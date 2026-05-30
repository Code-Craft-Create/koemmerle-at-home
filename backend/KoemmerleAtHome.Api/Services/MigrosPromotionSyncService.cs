using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Services;

public class MigrosPromotionSyncService(
    MigrosHttpSession session,
    MigrosProductSyncService productSync,
    IServiceScopeFactory scopeFactory,
    IScanNotifier notifier,
    ILogger<MigrosPromotionSyncService> logger)
{
    private const string PromotionsSearchUrl = "https://www.migros.ch/product-display/public/web/v3/products/promotion/search";
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };
    private readonly SemaphoreSlim _syncLock = new(1, 1);

    public async Task<PromotionSyncResult> SyncNowAsync(CancellationToken ct = default)
    {
        if (!session.IsLoggedIn) throw new MigrosSessionExpiredException();

        if (!await _syncLock.WaitAsync(0, ct))
            return new PromotionSyncResult(0, 0, 0, true);

        try
        {
            await NotifyProgressAsync("clear", 0, 1, 0, 0, "Bestehende Aktionen werden entfernt.", ct);
            await ClearPromotionsAsync(ct);

            var (uids, startDate, endDate) = await FetchPromotionUidsAsync(ct);
            logger.LogInformation("Promotion search returned {Count} product UIDs", uids.Count);
            await NotifyProgressAsync("cards", 0, uids.Count, 0, 0, $"{uids.Count} Aktionen gefunden.", ct);

            var syncedAt = DateTime.UtcNow;
            var cardsFetched = 0;
            var promotionsStored = 0;
            var processedUids = 0;
            var batches = (int)Math.Ceiling(uids.Count / 150.0);
            var batchNumber = 0;

            foreach (var batch in uids.Chunk(150))
            {
                ct.ThrowIfCancellationRequested();
                batchNumber++;
                var batchUids = batch.ToList();
                await NotifyProgressAsync(
                    "cards",
                    processedUids,
                    uids.Count,
                    cardsFetched,
                    promotionsStored,
                    $"Aktions-Produkte werden geladen ({processedUids}/{uids.Count}).",
                    ct);
                logger.LogInformation(
                    "Promotion sync batch {Batch}/{Batches}: fetching product cards for {Count} UIDs ({Processed}/{Total} already processed)",
                    batchNumber,
                    batches,
                    batchUids.Count,
                    processedUids,
                    uids.Count);

                var cards = await productSync.FetchProductCardsAsync(batchUids, ct, syncedAt);
                cardsFetched += cards.Count;
                logger.LogInformation(
                    "Promotion sync batch {Batch}/{Batches}: product-cards returned {Cards} cards; storing promotions",
                    batchNumber,
                    batches,
                    cards.Count);

                foreach (var card in cards)
                {
                    var promotionPrice = card.EffectivePromotionPrice;
                    if (!promotionPrice.HasValue) continue;

                    var product = await productSync.UpsertProductCardAsync(
                        card,
                        ct,
                        isPromotionOnly: true,
                        skipThumbnail: true,
                        promotionStartDate: startDate,
                        promotionEndDate: endDate);
                    if (product is null) continue;

                    promotionsStored++;
                }

                processedUids += batchUids.Count;
                await NotifyProgressAsync(
                    "cards",
                    Math.Min(processedUids, uids.Count),
                    uids.Count,
                    cardsFetched,
                    promotionsStored,
                    $"{promotionsStored} Aktionen gespeichert.",
                    ct);
                logger.LogInformation(
                    "Promotion sync batch {Batch}/{Batches} complete: {Stored} promotions stored so far from {Cards} cards",
                    batchNumber,
                    batches,
                    promotionsStored,
                    cardsFetched);
            }

            logger.LogInformation("Promotion sync complete: {Stored} promotions from {Cards} product cards",
                promotionsStored, cardsFetched);
            await NotifyProgressAsync("complete", uids.Count, uids.Count, cardsFetched, promotionsStored, "Aktionen aktualisiert.", ct);
            return new PromotionSyncResult(uids.Count, cardsFetched, promotionsStored, false);
        }
        finally
        {
            _syncLock.Release();
        }
    }

    private async Task ClearPromotionsAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var count = await db.ProductPromotions.CountAsync(ct);
        logger.LogInformation("Clearing {Count} existing promotion rows before promotion sync", count);
        db.ProductPromotions.RemoveRange(db.ProductPromotions);
        await db.SaveChangesAsync(ct);
    }

    private async Task<(List<long> Uids, DateTime? StartDate, DateTime? EndDate)> FetchPromotionUidsAsync(CancellationToken ct)
    {
        try
        {
            return await FetchPromotionUidsAsync(pageSize: 500, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("Promotion search with page size 500 failed ({Error}); retrying with page size 100", ex.Message);
            return await FetchPromotionUidsAsync(pageSize: 100, ct);
        }
    }

    private async Task<(List<long> Uids, DateTime? StartDate, DateTime? EndDate)> FetchPromotionUidsAsync(
        int pageSize,
        CancellationToken ct)
    {
        var uids = new List<long>();
        DateTime? startDate = null;
        DateTime? endDate = null;
        int? total = null;

        for (var from = 0; !total.HasValue || from < total.Value; from += pageSize)
        {
            var response = await FetchPromotionPageAsync(from, from + pageSize, ct);
            total ??= response.NumberOfItems;
            startDate ??= response.StartDate;
            endDate ??= response.EndDate;

            var pageUids = (response.Items ?? [])
                .Where(i => string.Equals(i.Type, "PRODUCT", StringComparison.OrdinalIgnoreCase))
                .Select(i => i.Id)
                .Where(id => id > 0)
                .ToList();

            if (pageUids.Count == 0) break;
            uids.AddRange(pageUids);
            await NotifyProgressAsync(
                "search",
                uids.Count,
                total.Value,
                0,
                0,
                $"Aktionsliste wird geladen ({uids.Count}/{total.Value}).",
                ct);
            logger.LogInformation(
                "Promotion search page from={From} until={Until} returned {Count} product UIDs ({Fetched}/{Total})",
                from,
                from + pageSize,
                pageUids.Count,
                uids.Count,
                total.Value);
        }

        return (uids.Distinct().ToList(), startDate, endDate);
    }

    private async Task<PromotionSearchResponse> FetchPromotionPageAsync(
        int from,
        int until,
        CancellationToken ct)
    {
        var request = new
        {
            storeType = "ONLINE",
            period = "CURRENT",
            language = "de",
            filters = new Dictionary<string, string>(),
            sortFields = new[] { "categoryLevel" },
            sortOrder = "asc",
            from,
            until,
            region = "gmaa",
            warehouse = "1",
            enabledSponsoredProducts = true
        };

        var resp = await session.PostAuthenticatedAsync(PromotionsSearchUrl, request, ct);
        resp.EnsureSuccessStatusCode();

        var json = await resp.Content.ReadAsStringAsync(ct);
        return JsonSerializer.Deserialize<PromotionSearchResponse>(json, JsonOpts)
            ?? new PromotionSearchResponse([], 0, null, null);
    }

    private Task NotifyProgressAsync(
        string stage,
        int done,
        int total,
        int productCards,
        int promotionsStored,
        string? message,
        CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return Task.CompletedTask;
        return notifier.NotifyPromotionSyncProgressAsync(new PromotionSyncProgress(
            stage,
            done,
            Math.Max(total, 0),
            productCards,
            promotionsStored,
            message));
    }
}

public record PromotionSyncResult(
    int PromotionUids,
    int ProductCards,
    int PromotionsStored,
    bool AlreadyRunning);
