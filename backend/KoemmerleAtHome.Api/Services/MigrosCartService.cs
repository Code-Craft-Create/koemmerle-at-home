using KoemmerleAtHome.Api.Models;
using System.Text.Json;

namespace KoemmerleAtHome.Api.Services;

/// <summary>
/// API-based replacement for PlaywrightCartService.
///
/// Confirmed endpoints (from network tab inspection):
///   GET  /shopping-list/public/v1/lists/overview          → shoppingListId
///   GET  /shopping-list/public/v2/list/details?shoppingListId={id}  → current items
///   PUT  /shopping-list/public/v3/items                   → set total quantity
///
/// The product uid (shopping-list item ID) comes from the MGB product API.
/// </summary>
public class MigrosCartService(
    MigrosHttpSession session,
    MigrosProductSyncService productSync,
    ScanQueueService queue,
    ILogger<MigrosCartService> logger)
    : BackgroundService
{
    private const string OverviewUrl      = "https://www.migros.ch/shopping-list/public/v1/lists/overview";
    private const string ListDetailsUrl   = "https://www.migros.ch/shopping-list/public/v2/list/details";
    private const string ItemsUrl         = "https://www.migros.ch/shopping-list/public/v3/items";

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private bool _isPaused;
    private long? _shoppingListId;

    public bool IsPaused => _isPaused;
    public bool IsLoggedIn => session.IsLoggedIn;

    public void Pause() => _isPaused = true;
    public void Resume() => _isPaused = false;

    public async Task<List<MigrosBasketItem>> GetBasketAsync(CancellationToken ct)
    {
        if (!session.IsLoggedIn) return [];

        var shoppingListId = await EnsureShoppingListIdAsync(ct);
        var url = $"{ListDetailsUrl}?shoppingListId={shoppingListId}";
        var resp = await session.GetAuthenticatedAsync(url, ct);
        if (!resp.IsSuccessStatusCode) return [];

        var json = await resp.Content.ReadAsStringAsync(ct);
        var rawItems = new List<(string uid, int qty)>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("categories", out var cats))
            {
                foreach (var cat in cats.EnumerateArray())
                {
                    if (!cat.TryGetProperty("items", out var items)) continue;
                    foreach (var el in items.EnumerateArray())
                    {
                        if (el.TryGetProperty("id", out var idEl) && el.TryGetProperty("quantity", out var qEl))
                            rawItems.Add((idEl.GetString()!, qEl.GetInt32()));
                    }
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning("Failed to parse shopping list details: {Error}", ex.Message);
            return [];
        }

        if (rawItems.Count == 0) return [];

        var uids = rawItems
            .Select(i => long.TryParse(i.uid, out var l) ? (long?)l : null)
            .OfType<long>()
            .ToList();

        var cards = await productSync.FetchProductCardsAsync(uids, ct);
        var cardMap = cards
            .Where(c => c.Uid.HasValue)
            .GroupBy(c => c.Uid!.Value.ToString())
            .ToDictionary(g => g.Key, g => g.First());

        static string? TopCategory(ProductCardResponse? card) =>
            card?.Breadcrumb?.FirstOrDefault(b => !string.IsNullOrWhiteSpace(b.Name))?.Name;

        static string? ProductUrl(ProductCardResponse? card) =>
            card?.ProductUrls
            ?? (!string.IsNullOrWhiteSpace(card?.MigrosId)
                ? MigrosProductSyncService.MigrosUrlFromId(card.MigrosId)
                : card?.EffectiveMigrosOnlineId is long moId ? MigrosProductSyncService.MoDisplayUrl(moId) : null);

        // Product cards already contain breadcrumbs in current Migros payloads.
        // The DB lookup remains a fallback for older/incomplete card responses.
        var categoryLookup = rawItems.Select(i =>
        {
            cardMap.TryGetValue(i.uid, out var card);
            return (i.uid, card?.MigrosId);
        });
        var dbCategoryMap = await productSync.GetTopCategoriesAsync(categoryLookup, ct);
        var dbMultiplierMap = await productSync.GetMultipliersAsync(rawItems.Select(i => i.uid), ct);

        return rawItems
            .Select(i =>
            {
                cardMap.TryGetValue(i.uid, out var card);
                dbCategoryMap.TryGetValue(i.uid, out var dbCategory);
                var multiplier = card?.EffectiveMultiplier ?? 1;
                if (multiplier == 1 && dbMultiplierMap.TryGetValue(i.uid, out var dbMultiplier))
                    multiplier = dbMultiplier;
                return new MigrosBasketItem(
                    Uid: i.uid,
                    ProductName: card?.EffectiveName ?? i.uid,
                    ImageUrl: card?.EffectiveImageUrl,
                    Quantity: i.qty,
                    Multiplier: multiplier,
                    Price: card?.EffectivePrice,
                    Category: TopCategory(card) ?? dbCategory ?? "Sonstige",
                    MigrosProductUrl: ProductUrl(card)
                );
            })
            .ToList();
    }

    public async Task SetItemQuantityAsync(string uid, int quantity, CancellationToken ct)
    {
        var shoppingListId = await EnsureShoppingListIdAsync(ct);
        var body = new ShoppingListPutRequest(
            ShoppingListId: shoppingListId,
            Items: [new ShoppingListItem(Id: uid, Quantity: quantity)]
        );
        var resp = await session.PutAuthenticatedAsync(ItemsUrl, body, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var rb = await resp.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException(
                $"Shopping-list PUT {resp.StatusCode}: {rb[..Math.Min(200, rb.Length)]}");
        }
    }

    public async Task<int?> GetCartQuantityAsync(string barcode, string? migrosId, CancellationToken ct)
    {
        if (!session.IsLoggedIn) return null;

        string? uid = null;
        if (!string.IsNullOrWhiteSpace(migrosId))
        {
            var (mgb, _) = await productSync.FetchMgbAsync(migrosId, ct);
            uid = mgb?.Uid.ToString();
        }
        if (uid is null)
            uid = await productSync.GetShoppingListUidAsync(barcode, ct);
        if (uid is null)
            return null;

        var shoppingListId = await EnsureShoppingListIdAsync(ct);
        var currentQty = await GetCurrentQuantityAsync(shoppingListId, uid, ct);
        var multiplier = await GetMultiplierAsync(uid, ct);
        return currentQty * multiplier;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            if (_isPaused)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                continue;
            }

            if (!session.IsLoggedIn)
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                continue;
            }

            ScanQueueItem? item = null;
            try
            {
                item = await queue.DequeueNextPendingAsync(stoppingToken);
                if (item is null) continue;

                await AddToCartAsync(item, stoppingToken);
                await queue.UpdateStatusAsync(item.Id, QueueStatus.Done);
                logger.LogInformation("Added '{Product}' to cart", item.ProductName);
            }
            catch (OperationCanceledException)
            {
                // Reset to Pending so the item can be retried after restart.
                if (item is not null)
                    await queue.UpdateStatusAsync(item.Id, QueueStatus.Pending);
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to add '{Product}' to cart", item?.ProductName);
                if (item is not null)
                    await queue.UpdateStatusAsync(item.Id, QueueStatus.Failed, ex.Message);
            }

            // Only rate-limit when an item was actually processed.
            if (item is not null)
                await Task.Delay(TimeSpan.FromMilliseconds(750), stoppingToken);
        }
    }

    private async Task AddToCartAsync(ScanQueueItem item, CancellationToken ct)
    {
        string? uid = null;
        if (item.MigrosUid.HasValue)
            uid = item.MigrosUid.Value.ToString();

        string? mgbError = null;

        if (uid is null && !string.IsNullOrWhiteSpace(item.MigrosId))
        {
            var (mgb, err) = await productSync.FetchMgbAsync(item.MigrosId, ct);
            mgbError = err;
            uid = mgb?.Uid.ToString();
        }

        if (uid is null && item.MigrosOnlineId.HasValue)
        {
            var product = await productSync.SyncAsync(item.MigrosId, item.MigrosOnlineId, item.MigrosUid, ct);
            uid = product?.MigrosUid?.ToString();
        }

        if (uid is null)
        {
            // MGB unavailable — fall back to onesearch by barcode then name
            uid = await productSync.GetShoppingListUidAsync(item.Barcode, ct)
               ?? await productSync.GetShoppingListUidAsync(item.ProductName, ct);
        }

        if (uid is null)
        {
            var reason = mgbError is not null ? $" (MGB: {mgbError})" : "";
            throw new InvalidOperationException(
                $"Cannot resolve shopping-list uid for '{item.ProductName}'{reason}");
        }

        var shoppingListId = await EnsureShoppingListIdAsync(ct);
        var multiplier = Math.Max(item.Multiplier, 1);
        if (multiplier == 1)
            multiplier = await GetMultiplierAsync(uid, ct);
        var currentQty = await GetCurrentQuantityAsync(shoppingListId, uid, ct);
        var targetQty = PackQuantity((currentQty * multiplier) + item.Quantity, multiplier);

        var body = new ShoppingListPutRequest(
            ShoppingListId: shoppingListId,
            Items: [new ShoppingListItem(Id: uid, Quantity: targetQty)]
        );

        var resp = await session.PutAuthenticatedAsync(ItemsUrl, body, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var rb = await resp.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException(
                $"Shopping-list PUT {resp.StatusCode}: {rb[..Math.Min(200, rb.Length)]}");
        }

        logger.LogInformation("Cart: uid={Uid} qty {Old}→{New} (x{Multiplier})", uid, currentQty, targetQty, multiplier);
    }

    // ── Shopping list ID ──────────────────────────────────────────────────────

    private async Task<long> EnsureShoppingListIdAsync(CancellationToken ct)
    {
        if (_shoppingListId.HasValue) return _shoppingListId.Value;

        var resp = await session.GetAuthenticatedAsync(OverviewUrl, ct);
        resp.EnsureSuccessStatusCode();

        var json = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        // Response is an array: [{ "shoppingListId": 196691, ... }]
        var listEl = root.ValueKind == JsonValueKind.Array && root.GetArrayLength() > 0
            ? root[0]
            : root;

        if (listEl.TryGetProperty("shoppingListId", out var idEl))
        {
            _shoppingListId = idEl.GetInt64();
            logger.LogInformation("Shopping list ID: {Id}", _shoppingListId.Value);
            return _shoppingListId.Value;
        }

        throw new InvalidOperationException(
            $"Could not parse shoppingListId from overview response: {json[..Math.Min(300, json.Length)]}");
    }

    // ── Current quantity ──────────────────────────────────────────────────────

    private async Task<int> GetCurrentQuantityAsync(long shoppingListId, string uid, CancellationToken ct)
    {
        var url = $"{ListDetailsUrl}?shoppingListId={shoppingListId}";
        var resp = await session.GetAuthenticatedAsync(url, ct);
        if (!resp.IsSuccessStatusCode) return 0;

        var json = await resp.Content.ReadAsStringAsync(ct);
        try
        {
            using var doc = JsonDocument.Parse(json);
            // Items are nested: categories[].items[].{ id, quantity }
            if (!doc.RootElement.TryGetProperty("categories", out var cats)) return 0;
            foreach (var cat in cats.EnumerateArray())
            {
                if (!cat.TryGetProperty("items", out var items)) continue;
                foreach (var el in items.EnumerateArray())
                {
                    if (el.TryGetProperty("id", out var idEl) && idEl.GetString() == uid
                        && el.TryGetProperty("quantity", out var qEl))
                        return qEl.GetInt32();
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning("Could not read current cart quantity for uid {Uid}: {Error}", uid, ex.Message);
        }

        return 0;
    }

    private async Task<int> GetMultiplierAsync(string uid, CancellationToken ct)
    {
        if (!long.TryParse(uid, out var uidLong)) return 1;
        var cards = await productSync.FetchProductCardsAsync([uidLong], ct);
        var card = cards.FirstOrDefault(c => c.Uid == uidLong) ?? cards.FirstOrDefault();
        var multiplier = card?.EffectiveMultiplier ?? 1;
        if (multiplier > 1) return multiplier;

        var dbMultipliers = await productSync.GetMultipliersAsync([uid], ct);
        return dbMultipliers.TryGetValue(uid, out var dbMultiplier) ? dbMultiplier : 1;
    }

    private static int PackQuantity(int singleQuantity, int multiplier)
    {
        if (singleQuantity <= 0) return 0;
        return (int)Math.Ceiling(singleQuantity / (double)Math.Max(multiplier, 1));
    }
}

public record MigrosBasketItem(
    string Uid,
    string ProductName,
    string? ImageUrl,
    int Quantity,
    int Multiplier,
    decimal? Price,
    string Category,
    string? MigrosProductUrl
);
