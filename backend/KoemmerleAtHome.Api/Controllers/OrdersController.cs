using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class OrdersController(AppDbContext db, MigrosOrderSyncService orderSync) : ControllerBase
{
    /// <summary>
    /// Computes the sync status based on actual item linkage rather than stored state.
    /// - HeaderFetched: no items loaded yet
    /// - DetailFetched:  items loaded but at least one with a product URL is still unlinked
    /// - FullySynced:    every item that has a product URL also has a ProductId
    /// </summary>
    private static void ApplyComputedStatus(Order order)
    {
        if (order.Items is not { Count: > 0 })
        {
            order.Status = OrderSyncStatus.HeaderFetched;
            return;
        }
        var withId = order.Items.Where(HasAnyMigrosIdentity).ToList();
        order.Status = withId.Count > 0 && withId.All(i => i.ProductId.HasValue)
            ? OrderSyncStatus.FullySynced
            : OrderSyncStatus.DetailFetched;
    }

    /// <summary>
    /// For any unlinked OrderItems whose Migros identity already has a Product in the DB,
    /// set the FK and persist. Returns the number of newly linked items.
    /// </summary>
    private async Task<int> AutoLinkFromDbAsync(IEnumerable<Order> orders, CancellationToken ct = default)
    {
        var unlinked = orders
            .SelectMany(o => o.Items)
            .Where(i => i.ProductId is null && HasAnyMigrosIdentity(i))
            .ToList();
        if (unlinked.Count == 0) return 0;

        var migrosIds = unlinked.Where(i => i.MigrosId != null).Select(i => i.MigrosId!).Distinct().ToList();
        var onlineIds = unlinked.Where(i => i.MigrosOnlineId.HasValue)
                                .Select(i => i.MigrosOnlineId!.Value).Distinct().ToList();
        var uids = unlinked.Where(i => i.MigrosUid.HasValue)
                           .Select(i => i.MigrosUid!.Value).Distinct().ToList();

        var byMigrosId = migrosIds.Count > 0
            ? await db.Products.Where(p => p.MigrosId != null && migrosIds.Contains(p.MigrosId!))
                                .ToDictionaryAsync(p => p.MigrosId!, ct)
            : new Dictionary<string, Product>();
        var byOnlineId = onlineIds.Count > 0
            ? await db.Products.Where(p => p.MigrosOnlineId.HasValue && onlineIds.Contains(p.MigrosOnlineId!.Value))
                                .ToDictionaryAsync(p => p.MigrosOnlineId!.Value, ct)
            : new Dictionary<long, Product>();
        var byUid = uids.Count > 0
            ? await db.Products.Where(p => p.MigrosUid.HasValue && uids.Contains(p.MigrosUid!.Value))
                                .ToDictionaryAsync(p => p.MigrosUid!.Value, ct)
            : new Dictionary<long, Product>();

        int linked = 0;
        foreach (var item in unlinked)
        {
            Product? match = null;
            if (item.MigrosId != null) byMigrosId.TryGetValue(item.MigrosId, out match);
            if (match is null && item.MigrosOnlineId.HasValue) byOnlineId.TryGetValue(item.MigrosOnlineId.Value, out match);
            if (match is null && item.MigrosUid.HasValue) byUid.TryGetValue(item.MigrosUid.Value, out match);
            if (match is not null) { item.ProductId = match.Id; linked++; }
        }
        if (linked > 0) await db.SaveChangesAsync(ct);
        return linked;
    }

    private static bool HasAnyMigrosIdentity(OrderItem item) =>
        !string.IsNullOrWhiteSpace(item.MigrosId) || item.MigrosOnlineId.HasValue || item.MigrosUid.HasValue;

    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var orders = await db.Orders
            .Include(o => o.Items)
                .ThenInclude(i => i.Product)
            .OrderByDescending(o => o.OrderDate)
            .ToListAsync();
        await AutoLinkFromDbAsync(orders);
        orders.ForEach(ApplyComputedStatus);
        return Ok(orders);
    }

    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetById(int id)
    {
        var order = await db.Orders
            .Include(o => o.Items)
                .ThenInclude(i => i.Product)
            .FirstOrDefaultAsync(o => o.Id == id);
        if (order is null) return NotFound();
        await AutoLinkFromDbAsync([order]);
        ApplyComputedStatus(order);
        return Ok(order);
    }

    [HttpPost("sync-headers")]
    public async Task<IActionResult> SyncHeaders(CancellationToken ct)
    {
        var count = await orderSync.SyncHeadersAsync(ct);
        return Ok(new { synced = count });
    }

    [HttpPost("{id:int}/sync-detail")]
    public async Task<IActionResult> SyncDetail(int id, CancellationToken ct)
    {
        await orderSync.SyncDetailAsync(id, ct);
        return Ok();
    }

    [HttpPost("{id:int}/sync-products")]
    public async Task<IActionResult> SyncProducts(int id, CancellationToken ct)
    {
        await orderSync.SyncProductsAsync(id, ct);
        return Ok();
    }

    [HttpPost("cancel-product-sync")]
    public IActionResult CancelProductSync()
    {
        orderSync.CancelProductSync();
        return Ok();
    }

    [HttpDelete("all")]
    public async Task<IActionResult> DeleteAll()
    {
        db.Orders.RemoveRange(db.Orders);
        await db.SaveChangesAsync();
        return NoContent();
    }
}
