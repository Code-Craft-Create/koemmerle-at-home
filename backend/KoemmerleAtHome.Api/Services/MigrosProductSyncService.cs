using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Services;

public class MigrosProductSyncService(
    MigrosHttpSession session,
    IServiceScopeFactory scopeFactory,
    ImageThumbnailService thumbnailService,
    IScanNotifier notifier,
    ILogger<MigrosProductSyncService> logger)
{
    private const string MgbBaseUrl = "https://www.migros.ch/product-display/public/v1/products/mgb";
    private const string MoBaseUrl  = "https://www.migros.ch/product-display/public/v1/products/mo";
    private const string OnesearchUrl = "https://www.migros.ch/onesearch-oc-seaapi/public/v5/search";
    private const string ProductCardsUrl = "https://www.migros.ch/product-display/public/v4/product-cards";

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    /// <summary>
    /// Syncs a product using explicit Migros identity values.
    /// - migrosId: 12-digit MGB id for /products/mgb/{migrosId}
    /// - migrosOnlineId: MO/catalog id for /products/mo/{migrosOnlineId}
    /// - migrosUid: product-card/search/shopping-list uid, also order uniqueId
    /// </summary>
    public async Task<Product?> SyncAsync(
        string? migrosId,
        long? migrosOnlineId = null,
        long? migrosUid = null,
        CancellationToken ct = default)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(migrosId))
            {
                var (mgb, _) = await FetchMgbAsync(migrosId, ct);
                if (mgb is not null)
                    return await UpsertProductAsync(migrosId, migrosOnlineId, migrosUid, mgb, ct);

                if (migrosOnlineId.HasValue)
                {
                    logger.LogInformation("MGB failed for {MigrosId}, falling back to MO {MigrosOnlineId}",
                        migrosId, migrosOnlineId);
                    return await SyncByMoAsync(migrosOnlineId.Value, migrosUid, ct);
                }
            }

            if (migrosOnlineId.HasValue)
                return await SyncByMoAsync(migrosOnlineId.Value, migrosUid, ct);

            if (migrosUid.HasValue)
                return await SyncByUidAsync(migrosUid.Value, ct);

            logger.LogWarning("SyncAsync called without any Migros product identity");
            return null;
        }
        catch (OperationCanceledException) { return null; }
        catch (Exception ex)
        {
            logger.LogWarning(
                "ProductSync failed (migrosId={MigrosId}, migrosOnlineId={MigrosOnlineId}, migrosUid={MigrosUid}): {Error}",
                migrosId, migrosOnlineId, migrosUid, ex.Message);
            return null;
        }
    }

    public async Task<UnavailableProductRefreshResult> RefreshUnavailableProductsAsync(CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var unavailableProducts = (await db.Products
                .AsNoTracking()
                .Where(p => p.AdditionalInfo != null)
                .Select(p => new
                {
                    p.Id,
                    p.Name,
                    p.MigrosId,
                    p.MigrosOnlineId,
                    p.MigrosUid,
                    p.AdditionalInfo
                })
                .ToListAsync(ct))
            .Where(p => !ParseAvailable(p.AdditionalInfo))
            .ToList();

        await notifier.NotifyAvailabilitySyncProgressAsync(new AvailabilitySyncProgress(
            Stage: "start",
            Done: 0,
            Total: unavailableProducts.Count,
            Refreshed: 0,
            NowAvailable: 0,
            StillUnavailable: 0,
            Failed: 0,
            Message: unavailableProducts.Count == 0
                ? "Keine nicht verfügbaren Produkte zu prüfen."
                : "Nicht verfügbare Produkte werden geprüft."));

        var byUid = unavailableProducts
            .Where(p => p.MigrosUid.HasValue)
            .GroupBy(p => p.MigrosUid!.Value)
            .ToDictionary(g => g.Key, g => g.First());

        var refreshed = 0;
        var nowAvailable = 0;
        var stillUnavailable = 0;
        var failed = unavailableProducts.Count - byUid.Count;
        var done = failed;

        foreach (var uidChunk in byUid.Keys.Chunk(100))
        {
            ct.ThrowIfCancellationRequested();
            var chunk = uidChunk.ToList();
            var cards = await FetchProductCardsAsync(chunk, ct);
            var cardMap = cards
                .Where(c => c.Uid.HasValue)
                .GroupBy(c => c.Uid!.Value)
                .ToDictionary(g => g.Key, g => g.First());

            foreach (var uid in chunk)
            {
                if (!byUid.TryGetValue(uid, out var product))
                    continue;

                if (!cardMap.TryGetValue(uid, out var card))
                {
                    failed++;
                    done++;
                    logger.LogWarning("Unavailable batch refresh found no product-card for '{Name}' (id={Id}, uid={Uid})",
                        product.Name, product.Id, uid);
                    continue;
                }

                var updated = await UpsertProductCardAsync(card, ct, isPromotionOnly: false, skipThumbnail: true);
                if (updated is null)
                {
                    failed++;
                    done++;
                    logger.LogWarning("Unavailable batch refresh failed to upsert '{Name}' (id={Id}, uid={Uid})",
                        product.Name, product.Id, uid);
                    continue;
                }

                refreshed++;
                done++;
                if (card.HasCurrentOffer) nowAvailable++;
                else stillUnavailable++;
            }

            await notifier.NotifyAvailabilitySyncProgressAsync(new AvailabilitySyncProgress(
                Stage: "cards",
                Done: done,
                Total: unavailableProducts.Count,
                Refreshed: refreshed,
                NowAvailable: nowAvailable,
                StillUnavailable: stillUnavailable,
                Failed: failed,
                Message: $"{done} von {unavailableProducts.Count} Produkten geprüft."));
        }

        await notifier.NotifyAvailabilitySyncProgressAsync(new AvailabilitySyncProgress(
            Stage: "complete",
            Done: unavailableProducts.Count,
            Total: unavailableProducts.Count,
            Refreshed: refreshed,
            NowAvailable: nowAvailable,
            StillUnavailable: stillUnavailable,
            Failed: failed,
            Message: $"{nowAvailable} von {unavailableProducts.Count} Produkten sind wieder verfügbar."));

        return new UnavailableProductRefreshResult(
            Checked: unavailableProducts.Count,
            Refreshed: refreshed,
            NowAvailable: nowAvailable,
            StillUnavailable: stillUnavailable,
            Failed: failed);
    }

    /// <summary>Compatibility overload for callers that still hold a migros.ch frontend URL.</summary>
    public Task<Product?> SyncAsync(string migrosUrl, CancellationToken ct = default)
    {
        var (migrosId, migrosOnlineId) = ExtractIdsFromUrl(migrosUrl);
        return SyncAsync(migrosId, migrosOnlineId, migrosUid: null, ct);
    }

    public async Task<(List<ProductCardResponse> cards, int total)> SyncBySearchAsync(
        string barcode,
        int from = 0,
        int limit = 20,
        CancellationToken ct = default)
    {
        var cards = new List<ProductCardResponse>();
        var total = 0;
        try
        {
            from = Math.Max(from, 0);
            limit = Math.Clamp(limit, 1, 100);

            var request = new OnesearchRequest(Query: barcode, From: from, Limit: limit);
            var resp = await session.PostAuthenticatedAsync(OnesearchUrl, request, ct);
            resp.EnsureSuccessStatusCode();

            var json = await resp.Content.ReadAsStringAsync(ct);
            logger.LogInformation("Search response payload for {Barcode}: {Payload}", barcode, json);

            var searchResult = JsonSerializer.Deserialize<OnesearchResponse>(json, JsonOpts);
            var productUids = searchResult?.ProductIds ?? [];
            total = searchResult?.NumberOfProducts ?? productUids.Count;
            logger.LogInformation("Onesearch returned {Count} product UIDs (from={From}, total={Total}) for barcode {Barcode}",
                productUids.Count, from, total, barcode);

            if (productUids.Count == 0)
            {
                logger.LogWarning("No search results for barcode {Barcode}", barcode);
                return (cards, total);
            }

            var uidsToFetch = productUids.Take(limit).ToList();
            cards = await FetchProductCardsAsync(uidsToFetch, ct);
            logger.LogInformation("product-cards returned {Count} cards (sent {Sent} UIDs) for barcode {Barcode}",
                cards.Count, uidsToFetch.Count, barcode);

            // Keep search result pages ephemeral. Persist only when a caller
            // explicitly syncs the chosen product.
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            logger.LogWarning("SyncBySearch failed for barcode {Barcode}: {Error}", barcode, ex.Message);
        }
        return (cards, total);
    }

    // Returns the shopping-list uid (onesearch hit id) for a search query.
    internal async Task<string?> GetShoppingListUidAsync(string query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query)) return null;
        try
        {
            var request = new OnesearchRequest(Query: query, Limit: 1);
            var resp = await session.PostAuthenticatedAsync(OnesearchUrl, request, ct);
            if (!resp.IsSuccessStatusCode) return null;

            var json = await resp.Content.ReadAsStringAsync(ct);
            var result = JsonSerializer.Deserialize<OnesearchResponse>(json, JsonOpts);
            var firstUid = result?.ProductIds?.FirstOrDefault();
            return firstUid?.ToString();
        }
        catch { return null; }
    }

    public async Task<List<ProductCardResponse>> FetchProductCardsAsync(
        List<long> uids,
        CancellationToken ct,
        DateTime? offerDate = null)
    {
        if (uids.Count == 0) return [];
        var ongoingOfferDate = (offerDate ?? DateTime.UtcNow).ToString("yyyy-MM-ddT00:00:00");
        var request = new ProductCardsRequest(
            OfferFilter: new ProductCardsOfferFilter(OngoingOfferDate: ongoingOfferDate),
            ProductFilter: new ProductCardsProductFilter(Uids: uids)
        );
        var resp = await session.PostAuthenticatedAsync(ProductCardsUrl, request, ct);
        if (!resp.IsSuccessStatusCode) return [];
        var json = await resp.Content.ReadAsStringAsync(ct);
        return JsonSerializer.Deserialize<List<ProductCardResponse>>(json, JsonOpts) ?? [];
    }

    // items: shopping-list uid paired with the MGB id where available.
    // Returns uid -> top-level category for every item that can be matched locally.
    public async Task<Dictionary<string, string>> GetTopCategoriesAsync(
        IEnumerable<(string uid, string? migrosId)> items, CancellationToken ct)
    {
        var itemList = items.ToList();
        if (itemList.Count == 0) return [];

        var migrosIds = itemList
            .Where(i => !string.IsNullOrWhiteSpace(i.migrosId))
            .Select(i => i.migrosId!)
            .Distinct()
            .ToList();
        var migrosUids = itemList
            .Select(i => long.TryParse(i.uid, out var l) ? (long?)l : null)
            .OfType<long>()
            .Distinct()
            .ToList();

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var products = await db.Products
            .Where(p =>
                (p.MigrosId != null && migrosIds.Contains(p.MigrosId)) ||
                (p.MigrosUid.HasValue && migrosUids.Contains(p.MigrosUid.Value)))
            .Select(p => new { p.MigrosId, p.MigrosUid, p.Categories })
            .ToListAsync(ct);

        static string TopCat(string? cats) =>
            string.IsNullOrWhiteSpace(cats) ? "Sonstige" : cats.Split('|')[0].Trim();

        var byMigrosId = products.Where(p => p.MigrosId != null)
                                 .GroupBy(p => p.MigrosId!)
                                 .ToDictionary(g => g.Key, g => TopCat(g.First().Categories));
        var byUid = products.Where(p => p.MigrosUid.HasValue)
                            .GroupBy(p => p.MigrosUid!.Value)
                            .ToDictionary(g => g.Key, g => TopCat(g.First().Categories));

        var result = new Dictionary<string, string>();
        foreach (var (uid, migrosId) in itemList)
        {
            if (migrosId != null && byMigrosId.TryGetValue(migrosId, out var cat))
                result[uid] = cat;
            else if (long.TryParse(uid, out var l) && byUid.TryGetValue(l, out cat))
                result[uid] = cat;
        }
        return result;
    }

    public async Task<Dictionary<string, int>> GetMultipliersAsync(IEnumerable<string> uids, CancellationToken ct)
    {
        var migrosUids = uids
            .Select(uid => long.TryParse(uid, out var l) ? (long?)l : null)
            .OfType<long>()
            .Distinct()
            .ToList();
        if (migrosUids.Count == 0) return [];

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Products
            .Where(p => p.MigrosUid.HasValue && migrosUids.Contains(p.MigrosUid.Value))
            .Select(p => new { Uid = p.MigrosUid!.Value, p.Multiplier })
            .ToDictionaryAsync(p => p.Uid.ToString(), p => Math.Max(p.Multiplier, 1), ct);
    }

    internal async Task<Product?> SyncFromProductCardAsync(ProductCardResponse card, CancellationToken ct)
    {
        Product? product = null;

        if (!string.IsNullOrWhiteSpace(card.MigrosId))
            product = await SyncAsync(card.MigrosId, card.EffectiveMigrosOnlineId, card.Uid, ct);

        if (product is null && card.EffectiveMigrosOnlineId.HasValue)
            product = await SyncAsync(null, card.EffectiveMigrosOnlineId.Value, card.Uid, ct);

        product ??= await UpsertProductCardAsync(card, ct, isPromotionOnly: false);
        if (product is not null)
            await ApplyPromotionFromProductCardAsync(product.Id, card, ct);

        return product;
    }

    private async Task<Product?> SyncByUidAsync(long migrosUid, CancellationToken ct)
    {
        var cards = await FetchProductCardsAsync([migrosUid], ct);
        var card = cards.FirstOrDefault(c => c.Uid == migrosUid) ?? cards.FirstOrDefault();
        return card is null ? null : await SyncFromProductCardAsync(card, ct);
    }

    private async Task<Product?> SyncByMoAsync(long migrosOnlineId, long? migrosUid, CancellationToken ct)
    {
        try
        {
            var url = $"{MoBaseUrl}/{migrosOnlineId}";
            var referer = $"https://www.migros.ch/de/product/mo/{migrosOnlineId}";
            var body = new
            {
                storeType = "ONLINE",
                warehouseId = 1,
                region = "gmaa",
                ongoingOfferDate = DateTime.UtcNow.ToString("yyyy-MM-ddT00:00:00"),
                cumulusCoupons = Array.Empty<object>()
            };

            var resp = await session.PostAuthenticatedWithDiagnosticsAsync(url, body, referer, logger, ct);
            if (!resp.IsSuccessStatusCode)
            {
                logger.LogWarning("MO product API returned {Status} for migrosOnlineId {Id}", resp.StatusCode, migrosOnlineId);
                return null;
            }

            var json = await resp.Content.ReadAsStringAsync(ct);
            MgbProductResponse? product;
            try { product = JsonSerializer.Deserialize<MgbProductResponse>(json, JsonOpts); }
            catch (Exception ex)
            {
                logger.LogWarning("Failed to parse MO response for migrosOnlineId {Id}: {Error}", migrosOnlineId, ex.Message);
                return null;
            }

            return product is null ? null : await UpsertProductAsync(null, migrosOnlineId, migrosUid, product, ct);
        }
        catch (OperationCanceledException) { return null; }
        catch (Exception ex)
        {
            logger.LogWarning("SyncByMo failed for migrosOnlineId {Id}: {Error}", migrosOnlineId, ex.Message);
            return null;
        }
    }

    internal async Task<(MgbProductResponse? Result, string? Error)> FetchMgbAsync(string migrosId, CancellationToken ct)
    {
        var url = $"{MgbBaseUrl}/{migrosId}";
        var referer = $"https://www.migros.ch/de/product/{migrosId}";

        var body = new
        {
            storeType = "ONLINE",
            warehouseId = 1,
            region = "gmaa",
            ongoingOfferDate = DateTime.UtcNow.ToString("yyyy-MM-ddT00:00:00"),
            cumulusCoupons = Array.Empty<object>()
        };
        var resp = await session.PostAuthenticatedWithDiagnosticsAsync(url, body, referer, logger, ct);

        if (!resp.IsSuccessStatusCode)
        {
            var responseBody = await resp.Content.ReadAsStringAsync(ct);
            var error = $"{(int)resp.StatusCode} {resp.StatusCode}";
            logger.LogWarning("MGB product API returned {Status} for migrosId {Id}: {Body}",
                resp.StatusCode, migrosId, responseBody.Length > 300 ? responseBody[..300] : responseBody);
            return (null, error);
        }

        var json = await resp.Content.ReadAsStringAsync(ct);
        try
        {
            return (JsonSerializer.Deserialize<MgbProductResponse>(json, JsonOpts), null);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Failed to parse MGB response for {Id}: {Error}", migrosId, ex.Message);
            return (null, $"parse error: {ex.Message}");
        }
    }

    private async Task<Product> UpsertProductAsync(
        string? migrosId,
        long? migrosOnlineId,
        long? migrosUid,
        MgbProductResponse response,
        CancellationToken ct)
    {
        var resolvedMigrosId = FirstNonBlank(migrosId, response.MigrosId);
        var resolvedMigrosOnlineId = migrosOnlineId ?? ParseLong(response.MigrosOnlineId);
        var resolvedMigrosUid = migrosUid ?? (response.Uid > 0 ? response.Uid : null);

        var productName = response.EffectiveName;
        var imageUrl = response.EffectiveImageUrl;
        var price = response.Offer?.Price?.Value;
        var multiplier = Math.Max(response.Offer?.Price?.Multiplier ?? 1, 1);
        var weightText = response.Offer?.Quantity;
        var (weightMin, weightMax, weightUnit) = MigrosParseHelpers.ParseWeight(weightText);
        var categories = response.Breadcrumb is { Count: > 0 }
            ? string.Join("|", response.Breadcrumb.Select(b => b.Name).Where(n => !string.IsNullOrWhiteSpace(n)))
            : null;

        var barcodes = response.Gtins is { Count: > 0 }
            ? string.Join(", ", response.Gtins)
            : resolvedMigrosId ?? resolvedMigrosOnlineId?.ToString() ?? resolvedMigrosUid?.ToString() ?? string.Empty;

        var displayUrl = !string.IsNullOrWhiteSpace(resolvedMigrosId)
            ? MigrosUrlFromId(resolvedMigrosId)
            : resolvedMigrosOnlineId.HasValue ? MoDisplayUrl(resolvedMigrosOnlineId.Value) : null;

        var product = await FindProductAsync(resolvedMigrosId, resolvedMigrosOnlineId, resolvedMigrosUid, ct) ?? new Product();
        await ApplyProductFieldsAsync(
            product,
            resolvedMigrosId,
            resolvedMigrosOnlineId,
            resolvedMigrosUid,
            displayUrl,
            productName,
            imageUrl,
            barcodes,
            weightText,
            weightMin,
            weightMax,
            weightUnit,
            price,
            multiplier,
            categories,
            available: response.HasCurrentOffer && !(response.Offer?.Hints?.Any(h => h.Type == "UNKNOWN_AVAILABILITY") ?? false),
            ct);

        if (response.Offer?.PromotionPrice?.Value is decimal promotionPrice)
        {
            await UpsertPromotionAsync(
                product.Id,
                promotionPrice,
                EffectivePromotionBadge(response.Offer.Badges),
                startDate: null,
                endDate: null,
                ct);
        }
        else
        {
            await RemovePromotionAsync(product.Id, ct);
        }

        logger.LogInformation("Synced '{Name}' (gtins: {Barcodes}, uid: {Uid}, mo: {MigrosOnlineId})",
            productName, barcodes, resolvedMigrosUid, resolvedMigrosOnlineId);
        return product;
    }

    internal async Task<Product?> UpsertProductCardAsync(
        ProductCardResponse card,
        CancellationToken ct,
        bool isPromotionOnly = false,
        bool skipThumbnail = false,
        DateTime? promotionStartDate = null,
        DateTime? promotionEndDate = null)
    {
        if (card.Uid is null && string.IsNullOrWhiteSpace(card.MigrosId) && card.EffectiveMigrosOnlineId is null)
            return null;

        var productName = card.EffectiveName ?? card.Name ?? card.Uid?.ToString() ?? card.MigrosOnlineId ?? "";
        var imageUrl = card.EffectiveImageUrl;
        var price = card.EffectivePrice;
        var multiplier = card.EffectiveMultiplier;
        var weightText = card.EffectiveWeightText;
        var (weightMin, weightMax, weightUnit) = MigrosParseHelpers.ParseWeight(weightText);
        var categories = card.Breadcrumb is { Count: > 0 }
            ? string.Join("|", card.Breadcrumb.Select(b => b.Name).Where(n => !string.IsNullOrWhiteSpace(n)))
            : null;
        var barcodes = card.Gtins is { Count: > 0 }
            ? string.Join(", ", card.Gtins)
            : card.MigrosId ?? card.EffectiveMigrosOnlineId?.ToString() ?? card.Uid?.ToString() ?? string.Empty;
        var displayUrl = card.ProductUrls
            ?? (!string.IsNullOrWhiteSpace(card.MigrosId)
                ? MigrosUrlFromId(card.MigrosId)
                : card.EffectiveMigrosOnlineId.HasValue ? MoDisplayUrl(card.EffectiveMigrosOnlineId.Value) : null);

        var product = await FindProductAsync(card.MigrosId, card.EffectiveMigrosOnlineId, card.Uid, ct) ?? new Product();
        var shouldRemainPromotionOnly = isPromotionOnly && (product.Id == 0 || product.IsPromotionOnly);
        await ApplyProductFieldsAsync(
            product,
            card.MigrosId,
            card.EffectiveMigrosOnlineId,
            card.Uid,
            displayUrl,
            productName,
            imageUrl,
            barcodes,
            weightText,
            weightMin,
            weightMax,
            weightUnit,
            price,
            multiplier,
            categories,
            available: card.HasCurrentOffer,
            ct,
            isPromotionOnly: shouldRemainPromotionOnly,
            skipThumbnail: skipThumbnail);

        await ApplyPromotionFromProductCardAsync(product.Id, card, ct, promotionStartDate, promotionEndDate);

        return product;
    }

    internal async Task ApplyPromotionFromProductCardAsync(
        int productId,
        ProductCardResponse card,
        CancellationToken ct,
        DateTime? promotionStartDate = null,
        DateTime? promotionEndDate = null)
    {
        if (card.EffectivePromotionPrice is decimal promotionPrice)
        {
            await UpsertPromotionAsync(
                productId,
                promotionPrice,
                card.EffectivePromotionBadge,
                promotionStartDate,
                promotionEndDate,
                ct);
            return;
        }

        await RemovePromotionAsync(productId, ct);
    }

    private async Task<Product?> FindProductAsync(string? migrosId, long? migrosOnlineId, long? migrosUid, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        if (!string.IsNullOrWhiteSpace(migrosId))
        {
            var byMigrosId = await db.Products.FirstOrDefaultAsync(p => p.MigrosId == migrosId, ct);
            if (byMigrosId is not null) return byMigrosId;
        }
        if (migrosOnlineId.HasValue)
        {
            var byOnlineId = await db.Products.FirstOrDefaultAsync(p => p.MigrosOnlineId == migrosOnlineId, ct);
            if (byOnlineId is not null) return byOnlineId;
        }
        if (migrosUid.HasValue)
        {
            var byUid = await db.Products.FirstOrDefaultAsync(p => p.MigrosUid == migrosUid, ct);
            if (byUid is not null) return byUid;
        }

        return null;
    }

    private async Task ApplyProductFieldsAsync(
        Product product,
        string? migrosId,
        long? migrosOnlineId,
        long? migrosUid,
        string? displayUrl,
        string productName,
        string? imageUrl,
        string barcodes,
        string? weightText,
        decimal? weightMin,
        decimal? weightMax,
        string? weightUnit,
        decimal? price,
        int multiplier,
        string? categories,
        bool available,
        CancellationToken ct,
        bool? isPromotionOnly = false,
        bool skipThumbnail = false)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        if (product.Id != 0)
            db.Attach(product);

        product.MigrosId = migrosId ?? product.MigrosId;
        product.MigrosOnlineId = migrosOnlineId ?? product.MigrosOnlineId;
        product.MigrosUid = migrosUid ?? product.MigrosUid;
        product.MigrosUrl = displayUrl ?? product.MigrosUrl;
        product.Name = productName;
        logger.LogDebug("Resolved image for '{Name}' uid={MigrosUid} mo={MigrosOnlineId}: {ImageUrl}",
            productName, migrosUid, migrosOnlineId, imageUrl ?? "(none)");
        if (!skipThumbnail && imageUrl != null && (product.ImageData == null || product.ImageUrl != imageUrl))
        {
            product.ImageData = await thumbnailService.FetchThumbnailAsync(imageUrl, ct);
            if (product.ImageData == null)
                logger.LogWarning("Thumbnail fetch returned null for product uid={MigrosUid} url={Url}", migrosUid, imageUrl);
            else
                logger.LogDebug("Thumbnail stored for '{Name}' uid={MigrosUid} from {Url}", productName, migrosUid, imageUrl);
        }
        product.ImageUrl = imageUrl;
        product.Barcodes = barcodes;
        product.WeightText = weightText;
        product.WeightMinGrams = weightMin;
        product.WeightMaxGrams = weightMax;
        product.WeightUnit = weightUnit;
        product.Price = price;
        product.Multiplier = Math.Max(multiplier, 1);
        product.PriceFetchedAt = price.HasValue ? DateTime.UtcNow : product.PriceFetchedAt;
        product.LastSyncedAt = DateTime.UtcNow;
        if (categories is not null) product.Categories = categories;
        product.AdditionalInfo = JsonSerializer.Serialize(new { available, hasCurrentOffer = available });
        if (isPromotionOnly.HasValue)
            product.IsPromotionOnly = isPromotionOnly.Value;

        if (product.Id == 0) db.Products.Add(product);
        await db.SaveChangesAsync(ct);
    }

    private async Task UpsertPromotionAsync(
        int productId,
        decimal promotionPrice,
        string? badgeDescription,
        DateTime? startDate,
        DateTime? endDate,
        CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var promotion = await db.ProductPromotions.FirstOrDefaultAsync(p => p.ProductId == productId, ct);
        if (promotion is null)
        {
            promotion = new ProductPromotion { ProductId = productId };
            db.ProductPromotions.Add(promotion);
        }

        promotion.PromotionPrice = promotionPrice;
        promotion.BadgeDescription = badgeDescription;
        promotion.StartDate = startDate;
        promotion.EndDate = endDate;
        promotion.SyncedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    private async Task RemovePromotionAsync(int productId, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var promotion = await db.ProductPromotions.FirstOrDefaultAsync(p => p.ProductId == productId, ct);
        if (promotion is null) return;

        db.ProductPromotions.Remove(promotion);
        await db.SaveChangesAsync(ct);
    }

    private static string? EffectivePromotionBadge(IEnumerable<ProductCardBadge>? badges) =>
        badges?
            .Where(b => b.IsPromotionBadge)
            .Select(b => b.EffectiveDescription)
            .FirstOrDefault(d => !string.IsNullOrWhiteSpace(d));

    internal static string MigrosUrlFromId(string migrosId) => $"https://www.migros.ch/de/product/{migrosId}";
    internal static string MoDisplayUrl(long migrosOnlineId) => $"https://www.migros.ch/de/product/mo/{migrosOnlineId}";

    internal static string? ExtractMigrosId(string migrosUrl) => ExtractIdsFromUrl(migrosUrl).MigrosId;

    internal static (string? MigrosId, long? MigrosOnlineId) ExtractIdsFromUrl(string migrosUrl)
    {
        var clean = migrosUrl.TrimEnd('/').Split('?')[0];
        var segments = clean.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var last = segments.LastOrDefault();
        if (string.IsNullOrWhiteSpace(last)) return (null, null);

        var isMo = segments.Length >= 2 && string.Equals(segments[^2], "mo", StringComparison.OrdinalIgnoreCase);
        if (isMo && long.TryParse(last, out var moId)) return (null, moId);
        return (last, null);
    }

    private static long? ParseLong(string? value) => long.TryParse(value, out var parsed) ? parsed : null;

    private static string? FirstNonBlank(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    private static bool ParseAvailable(string? json)
    {
        if (json is null) return true;
        try
        {
            using var doc = JsonDocument.Parse(json);
            return !doc.RootElement.TryGetProperty("available", out var v) || v.GetBoolean();
        }
        catch { return true; }
    }
}

public record UnavailableProductRefreshResult(
    int Checked,
    int Refreshed,
    int NowAvailable,
    int StillUnavailable,
    int Failed);
