using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class BringController(
    PlaywrightLoginService playwright,
    MigrosProductSyncService productSync,
    ScanQueueService queueService,
    AppDbContext db,
    ILogger<BringController> logger) : ControllerBase
{
    private const int SearchLimitPerQuery = 10;
    private const int SuggestionLimit = 5;

    [HttpPost("start")]
    public async Task<IActionResult> Start()
    {
        await playwright.StartBringListSyncAsync();
        return Ok(new { message = "Browser navigated to Bring. Log in and open the shopping list you want to sync." });
    }

    [HttpPost("extract")]
    public async Task<ActionResult<BringExtractResponse>> Extract(CancellationToken ct)
    {
        IReadOnlyList<BringListItem> items;
        try
        {
            items = await playwright.ExtractBringListItemsAsync(ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Bring extraction failed");
            return BadRequest(new { message = ex.Message });
        }

        var results = new List<BringMatchDto>();
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            var suggestions = await SearchSuggestionsAsync(item, ct);
            results.Add(new BringMatchDto(i, item.Name, item.Specification, suggestions));
        }

        return Ok(new BringExtractResponse(results));
    }

    [HttpGet("search")]
    public async Task<ActionResult<BringSearchResponse>> Search([FromQuery] string query, [FromQuery] int limit = 50, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(query))
            return BadRequest("query is required");

        var safeLimit = Math.Clamp(limit, 1, 50);
        var suggestions = await SearchSuggestionsAsync(new BringListItem(query.Trim(), null), ct, safeLimit);
        return Ok(new BringSearchResponse(suggestions));
    }

    [HttpPost("enqueue")]
    public async Task<ActionResult<BringEnqueueResponse>> Enqueue([FromBody] BringEnqueueRequest request, CancellationToken ct)
    {
        if (request.Items is null || request.Items.Count == 0)
            return BadRequest("items are required");

        var queueIds = new List<int>();
        var skipped = 0;

        foreach (var item in request.Items)
        {
            if (item.MigrosUid <= 0)
            {
                skipped++;
                continue;
            }

            var product = await db.Products.FirstOrDefaultAsync(p => p.MigrosUid == item.MigrosUid, ct)
                ?? await productSync.SyncAsync(null, migrosOnlineId: null, migrosUid: item.MigrosUid, ct);
            if (product is null)
            {
                skipped++;
                continue;
            }

            var barcode = BuildQuery(item.Name, item.Specification);
            var quantity = item.Quantity > 0 ? item.Quantity : 1;
            var (queueItem, _) = await queueService.EnqueueProductAsync(product, barcode, quantity, ct);
            queueIds.Add(queueItem.Id);
        }

        return Ok(new BringEnqueueResponse(queueIds.Count, skipped, queueIds));
    }

    private async Task<List<BringSuggestionDto>> SearchSuggestionsAsync(
        BringListItem item,
        CancellationToken ct,
        int suggestionLimit = SuggestionLimit)
    {
        var candidates = new Dictionary<long, Candidate>();
        var products = await db.Products
            .Where(p => p.MigrosUid.HasValue)
            .ToListAsync(ct);
        var productIds = products.Select(p => p.Id).ToList();
        var relevanceByProductId = await GetProductRelevanceAsync(productIds, ct);
        var productByUid = products
            .Where(p => p.MigrosUid.HasValue)
            .GroupBy(p => p.MigrosUid!.Value)
            .ToDictionary(g => g.Key, g => g.First());
        var searchLimitPerQuery = Math.Clamp(
            Math.Max(SearchLimitPerQuery, suggestionLimit),
            SearchLimitPerQuery,
            100);

        var queryIndex = 0;
        var queried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var seed in BuildQuerySeeds(item))
        {
            var query = seed;
            while (!string.IsNullOrWhiteSpace(query) && queried.Add(query))
            {
                var queryUids = new HashSet<long>();

                var localMatches = SearchLocalProducts(products, query, relevanceByProductId)
                    .Take(searchLimitPerQuery)
                    .ToList();
                for (var rank = 0; rank < localMatches.Count; rank++)
                {
                    var product = localMatches[rank].Product;
                    if (!product.MigrosUid.HasValue) continue;

                    queryUids.Add(product.MigrosUid.Value);
                    var relevance = relevanceByProductId.TryGetValue(product.Id, out var rel) ? rel.Relevance : 0.0;
                    var orderCount = relevanceByProductId.TryGetValue(product.Id, out rel) ? rel.OrderCount : 0;
                    AddCandidate(candidates, new Candidate(
                        product.MigrosUid.Value,
                        product.Name,
                        product.ImageData ?? product.ImageUrl,
                        product.WeightText,
                        product.Price,
                        Math.Max(product.Multiplier, 1),
                        query,
                        queryIndex,
                        rank,
                        SourceRank: 0,
                        ProductId: product.Id,
                        Relevance: relevance,
                        OrderCount: orderCount));
                }

                var (cards, _) = await productSync.SyncBySearchAsync(query, limit: searchLimitPerQuery, ct: ct);
                for (var rank = 0; rank < cards.Count; rank++)
                {
                    var card = cards[rank];
                    if (!card.Uid.HasValue || card.Uid.Value <= 0) continue;

                    queryUids.Add(card.Uid.Value);
                    productByUid.TryGetValue(card.Uid.Value, out var product);
                    var relevance = product is not null && relevanceByProductId.TryGetValue(product.Id, out var rel) ? rel.Relevance : 0.9;
                    var orderCount = product is not null && relevanceByProductId.TryGetValue(product.Id, out rel) ? rel.OrderCount : 0;

                    AddCandidate(candidates, new Candidate(
                        card.Uid.Value,
                        product?.Name ?? card.EffectiveName ?? card.Name ?? "Unbekannt",
                        product?.ImageData ?? product?.ImageUrl ?? card.EffectiveImageUrl,
                        product?.WeightText ?? card.EffectiveWeightText,
                        product?.Price ?? card.EffectivePrice,
                        Math.Max(product?.Multiplier ?? card.EffectiveMultiplier, 1),
                        query,
                        queryIndex,
                        rank,
                        SourceRank: product is null ? 1 : 0,
                        ProductId: product?.Id,
                        Relevance: relevance,
                        OrderCount: orderCount));
                }

                logger.LogInformation("Bring search query '{Query}' found {FoundCount} candidate(s)", query, queryUids.Count);
                queryIndex++;
                query = TruncateLastWord(query);
            }
        }

        if (candidates.Count == 0) return [];

        return candidates.Values
            .Select(c =>
                new RankedSuggestion(
                    DirectMatchRank(c.Name, c.WeightText, item),
                    FirstWordMatchRank(c.Name, c.WeightText, item),
                    c.QueryIndex,
                    c.Rank,
                    c.SourceRank,
                    c.Relevance,
                    c.OrderCount,
                    ToDto(c)))
            .OrderByDescending(s => s.DirectRank)
            .ThenByDescending(s => s.FirstWordRank)
            .ThenByDescending(s => s.Relevance)
            .ThenByDescending(s => s.OrderCount)
            .ThenBy(s => s.SourceRank)
            .ThenBy(s => s.QueryIndex)
            .ThenBy(s => s.Rank)
            .ThenBy(s => s.Dto.Name)
            .Take(suggestionLimit)
            .Select(s => s.Dto)
            .ToList();
    }

    private static void AddCandidate(Dictionary<long, Candidate> candidates, Candidate candidate)
    {
        if (!candidates.TryGetValue(candidate.MigrosUid, out var existing))
        {
            candidates[candidate.MigrosUid] = candidate;
            return;
        }

        var betterRank =
            candidate.QueryIndex < existing.QueryIndex ||
            (candidate.QueryIndex == existing.QueryIndex && candidate.SourceRank < existing.SourceRank) ||
            (candidate.QueryIndex == existing.QueryIndex && candidate.SourceRank == existing.SourceRank && candidate.Rank < existing.Rank);

        if (betterRank)
        {
            candidates[candidate.MigrosUid] = candidate;
            return;
        }

        if (candidate.SourceRank < existing.SourceRank || candidate.Relevance > existing.Relevance)
            candidates[candidate.MigrosUid] = existing with
            {
                Name = candidate.Name,
                ImageUrl = candidate.ImageUrl,
                WeightText = candidate.WeightText,
                Price = candidate.Price,
                Multiplier = candidate.Multiplier,
                SourceRank = Math.Min(existing.SourceRank, candidate.SourceRank),
                ProductId = candidate.ProductId ?? existing.ProductId,
                Relevance = Math.Max(existing.Relevance, candidate.Relevance),
                OrderCount = Math.Max(existing.OrderCount, candidate.OrderCount)
            };
    }

    private static BringSuggestionDto ToDto(Candidate candidate) => new(
        candidate.MigrosUid,
        candidate.Name,
        candidate.ImageUrl,
        candidate.WeightText,
        candidate.Price,
        candidate.Multiplier,
        candidate.Relevance,
        candidate.OrderCount,
        candidate.Query);

    private async Task<Dictionary<int, ProductRelevance>> GetProductRelevanceAsync(List<int> productIds, CancellationToken ct)
    {
        if (productIds.Count == 0) return [];

        var now = DateTime.UtcNow;
        var orderData = await db.OrderItems
            .Include(oi => oi.Order)
            .Where(oi => oi.ProductId.HasValue && productIds.Contains(oi.ProductId.Value) && oi.Order.OrderDate.HasValue)
            .GroupBy(oi => oi.ProductId!.Value)
            .Select(g => new
            {
                ProductId = g.Key,
                TotalQty = g.Sum(oi => oi.Quantity),
                LastOrderDate = g.Max(oi => oi.Order.OrderDate)
            })
            .ToListAsync(ct);

        return orderData.ToDictionary(
            x => x.ProductId,
            x =>
            {
                var orderCount = x.TotalQty;
                var cappedOrderCount = Math.Min(x.TotalQty, 10);
                var daysSinceOrder = Math.Max((now - x.LastOrderDate!.Value).TotalDays - 30, 0);
                var relevance = cappedOrderCount / (1.0 + daysSinceOrder / 180.0);
                return new ProductRelevance(relevance, orderCount);
            });
    }

    private static IEnumerable<string> BuildQuerySeeds(BringListItem item)
    {
        var full = BuildQuery(item.Name, item.Specification);
        if (!string.IsNullOrWhiteSpace(full))
            yield return full;

        var name = item.Name.Trim();
        if (!string.Equals(full, name, StringComparison.OrdinalIgnoreCase))
            yield return name;
    }

    private static string TruncateLastWord(string query)
    {
        var parts = query
            .Split(' ', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .ToList();
        if (parts.Count <= 1) return "";
        return string.Join(' ', parts.Take(parts.Count - 1));
    }

    private static string BuildQuery(string name, string? specification)
    {
        var spec = string.IsNullOrWhiteSpace(specification) ? "" : $" {specification.Trim()}";
        return $"{name.Trim()}{spec}".Trim();
    }

    private static IEnumerable<ProductMatch> SearchLocalProducts(
        List<Product> products,
        string query,
        Dictionary<int, ProductRelevance> relevanceByProductId)
    {
        return products
            .Select(p =>
            {
                var relevance = relevanceByProductId.TryGetValue(p.Id, out var rel) ? rel.Relevance : 0.0;
                var orderCount = relevanceByProductId.TryGetValue(p.Id, out rel) ? rel.OrderCount : 0;
                return new ProductMatch(p, LocalMatchScore(p, query), relevance, orderCount);
            })
            .Where(m => m.Score > 0)
            .OrderByDescending(m => m.Score)
            .ThenByDescending(m => m.Relevance)
            .ThenByDescending(m => m.OrderCount)
            .ThenBy(m => m.Product.Name);
    }

    private static int LocalMatchScore(Product product, string query)
    {
        var q = Normalize(query);
        if (string.IsNullOrWhiteSpace(q)) return 0;

        var haystack = Normalize($"{product.Name} {product.Barcodes} {product.WeightText}");
        if (haystack.Contains(q, StringComparison.Ordinal)) return 5;

        var words = q.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 1 && words.All(w => haystack.Contains(w, StringComparison.Ordinal))) return 4;
        if (words.FirstOrDefault() is { Length: >= 3 } firstWord && haystack.Contains(firstWord, StringComparison.Ordinal)) return 3;
        if (words.Any(w => w.Length >= 3 && haystack.Contains(w, StringComparison.Ordinal))) return 1;
        return 0;
    }

    private static int DirectMatchRank(string productName, string? weightText, BringListItem item)
    {
        var haystack = Normalize($"{productName} {weightText}");
        var itemName = Normalize(item.Name);
        var full = Normalize(BuildQuery(item.Name, item.Specification));

        if (!string.IsNullOrWhiteSpace(full) && haystack.Contains(full, StringComparison.Ordinal)) return 2;
        if (!string.IsNullOrWhiteSpace(itemName) && haystack.Contains(itemName, StringComparison.Ordinal)) return 1;
        return 0;
    }

    private static int FirstWordMatchRank(string productName, string? weightText, BringListItem item)
    {
        var firstWord = Normalize(item.Name)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        if (string.IsNullOrWhiteSpace(firstWord) || firstWord.Length < 3) return 0;

        var normalizedName = Normalize(productName);
        if (normalizedName.StartsWith(firstWord, StringComparison.Ordinal)) return 2;

        var haystack = Normalize($"{productName} {weightText}");
        return haystack.Contains(firstWord, StringComparison.Ordinal) ? 1 : 0;
    }

    private static string Normalize(string value)
    {
        var normalized = value.ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(normalized.Length);
        foreach (var ch in normalized)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark)
                builder.Append(ch);
        }

        return builder.ToString().Normalize(NormalizationForm.FormC);
    }

    private record ProductMatch(Product Product, int Score, double Relevance, int OrderCount);
    private record Candidate(
        long MigrosUid,
        string Name,
        string? ImageUrl,
        string? WeightText,
        decimal? Price,
        int Multiplier,
        string Query,
        int QueryIndex,
        int Rank,
        int SourceRank,
        int? ProductId,
        double Relevance,
        int OrderCount);
    private record RankedSuggestion(int DirectRank, int FirstWordRank, int QueryIndex, int Rank, int SourceRank, double Relevance, int OrderCount, BringSuggestionDto Dto);
    private record ProductRelevance(double Relevance, int OrderCount);
}

public record BringExtractResponse(List<BringMatchDto> Items);
public record BringSearchResponse(List<BringSuggestionDto> Suggestions);
public record BringMatchDto(int Index, string Name, string? Specification, List<BringSuggestionDto> Suggestions);
public record BringSuggestionDto(
    long MigrosUid,
    string Name,
    string? ImageUrl,
    string? WeightText,
    decimal? Price,
    int Multiplier,
    double Relevance,
    int OrderCount,
    string MatchedQuery);
public record BringEnqueueRequest(List<BringEnqueueItem> Items);
public record BringEnqueueItem(int Index, string Name, string? Specification, long MigrosUid, int Quantity = 1);
public record BringEnqueueResponse(int Enqueued, int Skipped, List<int> QueueItemIds);
