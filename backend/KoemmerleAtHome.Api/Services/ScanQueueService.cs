using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Services;

public class LookupResult
{
    public string? MappingName { get; set; }
    public string? MappingImageData { get; set; }
    public List<(Product Product, int Quantity)> Items { get; set; } = [];
    public bool Recognized => Items.Count > 0;
}

public class ScanQueueService(IServiceScopeFactory scopeFactory, IScanNotifier notifier)
{
    private readonly SemaphoreSlim _signal = new(0);

    /// <summary>
    /// 3-stage lookup:
    ///   1. Custom ProductMapping by Barcode → enqueue all items (supports multi-product)
    ///   2. Product whose Barcodes (GTINs) contain the barcode → enqueue with qty 1
    ///   3. Caller handles search (ScanController calls ProductSyncService.SyncBySearchAsync)
    /// Returns EnqueueResult with Recognized=false if stages 1 and 2 find nothing.
    /// </summary>
    public async Task<LookupResult> LookupAsync(string barcode, CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // ── Stage 1: custom mapping ──────────────────────────────────────────
        var mapping = await db.ProductMappings
            .Include(m => m.Items).ThenInclude(i => i.Product)
            .FirstOrDefaultAsync(m => m.Barcode == barcode, ct);

        if (mapping is not null && mapping.Items.Count > 0)
        {
            var result = new LookupResult { MappingName = mapping.Name, MappingImageData = mapping.ImageData };
            foreach (var mi in mapping.Items)
            {
                result.Items.Add((mi.Product, mi.Quantity));
            }
            return result;
        }

        // ── Stage 2: GTIN match on existing Products ─────────────────────────
        var products = await db.Products.ToListAsync(ct);
        var matched = products.FirstOrDefault(p =>
            p.Barcodes.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                      .Contains(barcode));

        if (matched is not null)
        {
            return new LookupResult { Items = [(matched, 1)] };
        }

        return new LookupResult();
    }

    public async Task<List<ScanQueueItem>> EnqueueAsync(string barcode, int multiplier = 1, CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var addedItems = new List<ScanQueueItem>();

        var mapping = await db.ProductMappings
            .Include(m => m.Items).ThenInclude(i => i.Product)
            .FirstOrDefaultAsync(m => m.Barcode == barcode, ct);

        if (mapping is not null && mapping.Items.Count > 0)
        {
            foreach (var mi in mapping.Items)
            {
                var qi = new ScanQueueItem
                {
                    Barcode = barcode,
                    ProductName = mi.Product.Name,
                    MigrosId = mi.Product.MigrosId,
                    MigrosOnlineId = mi.Product.MigrosOnlineId,
                    MigrosUid = mi.Product.MigrosUid,
                    Quantity = mi.Quantity * multiplier,
                    Multiplier = Math.Max(mi.Product.Multiplier, 1),
                    ScannedAt = DateTime.UtcNow,
                    Status = QueueStatus.Pending,
                    ProductImageUrl = mi.Product.ImageUrl,
                    ProductImageData = mi.Product.ImageData,
                    RecipeName = mapping.Name,
                    RecipeImageData = mapping.ImageData
                };
                db.ScanQueueItems.Add(qi);
                addedItems.Add(qi);
            }
        }
        else
        {
            var products = await db.Products.ToListAsync(ct);
            var matched = products.FirstOrDefault(p =>
                p.Barcodes.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                          .Contains(barcode));

            if (matched is not null)
            {
                var qi = new ScanQueueItem
                {
                    Barcode = barcode,
                    ProductName = matched.Name,
                    MigrosId = matched.MigrosId,
                    MigrosOnlineId = matched.MigrosOnlineId,
                    MigrosUid = matched.MigrosUid,
                    Quantity = multiplier,
                    Multiplier = Math.Max(matched.Multiplier, 1),
                    ScannedAt = DateTime.UtcNow,
                    Status = QueueStatus.Pending,
                    ProductImageUrl = matched.ImageUrl,
                    ProductImageData = matched.ImageData
                };
                db.ScanQueueItems.Add(qi);
                addedItems.Add(qi);
            }
        }

        if (addedItems.Count > 0)
        {
            await db.SaveChangesAsync(ct);
            foreach (var _ in addedItems) _signal.Release();
            await PushQueueAsync(db);
        }

        return addedItems;
    }

    public async Task<(ScanQueueItem item, string? imageUrl)> EnqueueProductAsync(
        Product product, string barcode, int multiplier = 1, CancellationToken ct = default)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var qi = new ScanQueueItem
        {
            Barcode = barcode,
            ProductName = product.Name,
            MigrosId = product.MigrosId,
            MigrosOnlineId = product.MigrosOnlineId,
            MigrosUid = product.MigrosUid,
            Quantity = multiplier,
            Multiplier = Math.Max(product.Multiplier, 1),
            ScannedAt = DateTime.UtcNow,
            Status = QueueStatus.Pending,
            ProductImageUrl = product.ImageUrl,
            ProductImageData = product.ImageData
        };
        db.ScanQueueItems.Add(qi);
        await db.SaveChangesAsync(ct);
        _signal.Release();
        await PushQueueAsync(db);
        return (qi, product.ImageUrl);
    }

    public async Task<ScanQueueItem?> DequeueNextPendingAsync(CancellationToken ct)
    {
        await _signal.WaitAsync(ct);

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var item = await db.ScanQueueItems
            .Where(i => i.Status == QueueStatus.Pending)
            .OrderBy(i => i.ScannedAt)
            .FirstOrDefaultAsync(ct);

        if (item is not null)
        {
            item.Status = QueueStatus.Processing;
            await db.SaveChangesAsync(ct);
            await PushQueueAsync(db);
        }

        return item;
    }

    public async Task UpdateStatusAsync(int id, QueueStatus status, string? errorMessage = null)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var item = await db.ScanQueueItems.FindAsync(id);
        if (item is null) return;
        item.Status = status;
        item.ErrorMessage = errorMessage;
        await db.SaveChangesAsync();
        await PushQueueAsync(db);
    }

    public async Task<List<ScanQueueItem>> GetQueueAsync()
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.ScanQueueItems
            .OrderByDescending(i => i.ScannedAt)
            .Take(100)
            .ToListAsync();
    }

    public async Task DeleteAsync(int id)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var item = await db.ScanQueueItems.FindAsync(id);
        if (item is null) return;
        db.ScanQueueItems.Remove(item);
        await db.SaveChangesAsync();
        await PushQueueAsync(db);
    }

    public async Task DeleteCompletedAsync()
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var done = db.ScanQueueItems.Where(i =>
            i.Status == QueueStatus.Done ||
            i.Status == QueueStatus.Failed ||
            i.Status == QueueStatus.UnknownBarcode);
        db.ScanQueueItems.RemoveRange(done);
        await db.SaveChangesAsync();
        await PushQueueAsync(db);
    }

    public async Task DeleteAllAsync()
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.ScanQueueItems.RemoveRange(db.ScanQueueItems);
        await db.SaveChangesAsync();
        await PushQueueAsync(db);
    }

    public async Task RequeueFailedAsync(int id)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var item = await db.ScanQueueItems.FindAsync(id);
        if (item is null) return;
        item.Status = QueueStatus.Pending;
        item.ErrorMessage = null;
        await db.SaveChangesAsync();
        _signal.Release();
        await PushQueueAsync(db);
    }

    private async Task PushQueueAsync(AppDbContext db)
    {
        var queue = await db.ScanQueueItems
            .OrderByDescending(i => i.ScannedAt)
            .Take(100)
            .ToListAsync();
        await notifier.NotifyQueueUpdatedAsync(queue);
    }
}
