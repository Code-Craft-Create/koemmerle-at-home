using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Hubs;
using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Services;

/// <summary>
/// API-based replacement for OrderSyncService. Uses the Migros receipt API for in-store
/// purchases. Online web orders use a separate API whose endpoint must be discovered via
/// route interception — see the [API-CAPTURE] log lines when running the app and navigating
/// to migros.ch/de/account/orders.
/// <summary>
/// API-based replacement for OrderSyncService. Uses the Migros ordergateway API
/// to sync online Migros purchases.
/// </summary>
public class MigrosOrderSyncService(
    MigrosHttpSession session,
    MigrosProductSyncService productSync,
    IServiceScopeFactory scopeFactory,
    IHubContext<ScanHub> hub,
    ILogger<MigrosOrderSyncService> logger)
{
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private CancellationTokenSource? _productSyncCts;

    public void CancelProductSync()
    {
        _productSyncCts?.Cancel();
        logger.LogInformation("Product sync cancellation requested");
    }

    /// <summary>
    /// Fetches online orders and upserts Order headers.
    /// </summary>
    public async Task<int> SyncHeadersAsync(CancellationToken ct = default)
    {
        if (!session.IsLoggedIn) throw new MigrosSessionExpiredException();

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        int upserted = 0;
        int totalSeen = 0;
        int page = 0;
        int? totalSize = null;

        do
        {
            var url = $"https://www.migros.ch/ordergateway/public/web/v1/customers/customer-orders?status=all&page={page}";

            var resp = await session.GetAuthenticatedAsync(url, ct);
            if (!resp.IsSuccessStatusCode)
            {
                logger.LogWarning("Order list API returned {Status} for page {Page}", resp.StatusCode, page);
                throw new InvalidOperationException($"Order list API returned {resp.StatusCode}");
            }

            var json = await resp.Content.ReadAsStringAsync(ct);
            logger.LogDebug("Order list response page {Page}: {Json}", page, json[..Math.Min(500, json.Length)]);

            var response = JsonSerializer.Deserialize<CustomerOrderListResponse>(json, JsonOpts);
            var orders = response?.Orders ?? [];

            if (totalSize is null && response is not null)
            {
                totalSize = response.Size;
            }

            foreach (var r in orders)
            {
                var idStr = r.Id.ToString();
                var existing = await db.Orders.FirstOrDefaultAsync(x => x.MigrosOrderId == idStr, ct);
                if (existing is null)
                {
                    existing = new Order { MigrosOrderId = idStr, FirstSeenAt = DateTime.UtcNow };
                    db.Orders.Add(existing);
                    upserted++;
                }
                existing.DateText = r.DeliveryStartDate?.ToString("d. MMMM yyyy");
                existing.OrderDate = r.DeliveryStartDate?.ToUniversalTime();
                existing.TotalAmount = r.GrandTotal;
                existing.DetailPath = null;
            }

            totalSeen += orders.Count;
            await db.SaveChangesAsync(ct);
            logger.LogInformation("SyncHeaders: fetched page {Page}, upserted {Count} orders so far (total seen: {Total})", page, upserted, totalSeen);
            await hub.Clients.All.SendAsync("OrderSyncProgress", new { phase = "headers", count = upserted }, ct);

            page++;
        } while (totalSize.HasValue && page * 10 < totalSize.Value);

        return upserted;
    }

    /// <summary>
    /// Fetches line items for a single order.
    /// </summary>
    public async Task SyncDetailAsync(int orderId, CancellationToken ct = default)
    {
        if (!session.IsLoggedIn) throw new MigrosSessionExpiredException();

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var order = await db.Orders.Include(o => o.Items).FirstOrDefaultAsync(o => o.Id == orderId, ct)
            ?? throw new InvalidOperationException($"Order {orderId} not found");

        var detailUrl = $"https://www.migros.ch/ordergateway/public/web/v1/orders/{order.MigrosOrderId}";
        var resp = await session.GetAuthenticatedAsync(detailUrl, ct);

        if (!resp.IsSuccessStatusCode)
        {
            logger.LogWarning("Order detail API returned {Status} for order {Id}", resp.StatusCode, orderId);
            throw new InvalidOperationException($"Order detail API returned {resp.StatusCode}");
        }

        var json = await resp.Content.ReadAsStringAsync(ct);
        var detailResp = JsonSerializer.Deserialize<CustomerOrderDetailResponse>(json, JsonOpts);

        db.OrderItems.RemoveRange(order.Items);
        order.Items.Clear();

        if (detailResp?.Details?.Positions is not null)
        {
            foreach (var pos in detailResp.Details.Positions)
            {
                if (string.IsNullOrWhiteSpace(pos.EffectiveName)) continue;

                order.Items.Add(new OrderItem
                {
                    ProductNameAtOrder = pos.EffectiveName,
                    Quantity = pos.DeliveredQuantity > 0 ? pos.DeliveredQuantity : 1,
                    UnitPrice = pos.WeightedQuotedPrice ?? pos.AdjustedPrice,
                    TotalPrice = pos.AdjustedPrice,
                    MigrosId = string.IsNullOrWhiteSpace(pos.MigrosId) ? null : pos.MigrosId,
                    MigrosOnlineId = pos.ProductId,
                    MigrosUid = pos.UniqueId
                });
            }
        }

        order.Status = OrderSyncStatus.DetailFetched;
        await db.SaveChangesAsync(ct);
        logger.LogInformation("SyncDetail: order {Id} → {Count} items", orderId, order.Items.Count);
    }

    /// <summary>Syncs all unlinked products in an order and marks it FullySynced.</summary>
    public async Task SyncProductsAsync(int orderId, CancellationToken ct = default)
    {
        _productSyncCts?.Cancel();
        _productSyncCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var linked = _productSyncCts.Token;

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var order = await db.Orders.Include(o => o.Items).FirstOrDefaultAsync(o => o.Id == orderId, linked)
            ?? throw new InvalidOperationException($"Order {orderId} not found");

        // Auto-link items already in the DB by matching explicit Migros identities.
        var needLink = order.Items
            .Where(i => i.ProductId is null && HasAnyMigrosIdentity(i))
            .ToList();
        if (needLink.Count > 0)
        {
            var migrosIds = needLink.Where(i => i.MigrosId != null).Select(i => i.MigrosId!).Distinct().ToList();
            var onlineIds = needLink.Where(i => i.MigrosOnlineId.HasValue)
                                    .Select(i => i.MigrosOnlineId!.Value).Distinct().ToList();
            var uids = needLink.Where(i => i.MigrosUid.HasValue)
                               .Select(i => i.MigrosUid!.Value).Distinct().ToList();

            var byMigrosId = migrosIds.Count > 0
                ? await db.Products.Where(p => p.MigrosId != null && migrosIds.Contains(p.MigrosId!))
                                    .ToDictionaryAsync(p => p.MigrosId!, linked)
                : new Dictionary<string, Product>();
            var byOnlineId = onlineIds.Count > 0
                ? await db.Products.Where(p => p.MigrosOnlineId.HasValue && onlineIds.Contains(p.MigrosOnlineId!.Value))
                                    .ToDictionaryAsync(p => p.MigrosOnlineId!.Value, linked)
                : new Dictionary<long, Product>();
            var byUid = uids.Count > 0
                ? await db.Products.Where(p => p.MigrosUid.HasValue && uids.Contains(p.MigrosUid!.Value))
                                    .ToDictionaryAsync(p => p.MigrosUid!.Value, linked)
                : new Dictionary<long, Product>();

            foreach (var item in needLink)
            {
                Product? match = null;
                if (item.MigrosId != null) byMigrosId.TryGetValue(item.MigrosId, out match);
                if (match is null && item.MigrosOnlineId.HasValue) byOnlineId.TryGetValue(item.MigrosOnlineId.Value, out match);
                if (match is null && item.MigrosUid.HasValue) byUid.TryGetValue(item.MigrosUid.Value, out match);
                
                if (match is not null)
                    item.ProductId = match.Id;
            }
            if (needLink.Any(i => i.ProductId != null))
            {
                await db.SaveChangesAsync(linked);
                logger.LogInformation("SyncProducts: auto-linked items from DB for order {Id}", orderId);
            }
        }

        var unlinked = order.Items
            .Where(i => i.ProductId is null && HasAnyMigrosIdentity(i))
            .ToList();

        var total = unlinked.Count;
        var done = 0;

        await hub.Clients.All.SendAsync("OrderProductSyncProgress",
            new OrderProductSyncProgress(orderId, done, total, null), linked);

        foreach (var item in unlinked)
        {
            if (linked.IsCancellationRequested) break;

            await hub.Clients.All.SendAsync("OrderProductSyncProgress",
                new OrderProductSyncProgress(orderId, done, total, item.ProductNameAtOrder), linked);

            var product = await productSync.SyncAsync(item.MigrosId, item.MigrosOnlineId, item.MigrosUid, linked);
            if (product is not null)
            {
                item.ProductId = product.Id;
                await db.SaveChangesAsync(linked);
            }

            done++;
            var syncedUrl = product?.MigrosUrl;
            await hub.Clients.All.SendAsync("OrderProductSyncProgress",
                new OrderProductSyncProgress(orderId, done, total, null, syncedUrl), linked);

            if (done < total) await Task.Delay(200, linked);
        }

        await db.SaveChangesAsync(CancellationToken.None);
        logger.LogInformation("SyncProducts: order {Id} done (cancelled={Cancelled})", orderId, linked.IsCancellationRequested);
    }

    private static bool HasAnyMigrosIdentity(OrderItem item) =>
        !string.IsNullOrWhiteSpace(item.MigrosId) || item.MigrosOnlineId.HasValue || item.MigrosUid.HasValue;

}
