using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ProductsController(AppDbContext db, MigrosProductSyncService productSync, ImageThumbnailService thumbnailService, ILogger<ProductsController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var products = await db.Products
            .Where(p => !p.IsPromotionOnly)
            .OrderBy(p => p.Name)
            .ToListAsync();
        var productIds = products.Select(p => p.Id).ToList();
        var promotions = await db.ProductPromotions
            .Where(p => productIds.Contains(p.ProductId))
            .ToDictionaryAsync(p => p.ProductId);
        var mappedIds = (await db.ProductMappingItems.Select(i => i.ProductId).ToListAsync()).ToHashSet();

        var orderData = await db.OrderItems
            .Include(oi => oi.Order)
            .Where(oi => oi.ProductId.HasValue && oi.Order.OrderDate.HasValue)
            .GroupBy(oi => oi.ProductId!.Value)
            .Select(g => new {
                ProductId = g.Key,
                TotalQty = g.Sum(oi => oi.Quantity),
                LastOrderDate = g.Max(oi => oi.Order.OrderDate)
            })
            .ToDictionaryAsync(x => x.ProductId);

        var now = DateTime.UtcNow;
        return Ok(products.Select(p =>
        {
            double relevance = 0.0;
            DateTime? lastOrderDate = null;
            int orderCount = 0;
            if (orderData.TryGetValue(p.Id, out var od))
            {
                lastOrderDate = od.LastOrderDate;
                orderCount = od.TotalQty;
                var oc = Math.Min(od.TotalQty, 10);
                var dso = Math.Max((now - od.LastOrderDate!.Value).TotalDays - 30, 0);
                relevance = oc / (1.0 + dso / 180.0);
            }
            promotions.TryGetValue(p.Id, out var promotion);
            return ToDto(p, mappedIds.Contains(p.Id), relevance, lastOrderDate, orderCount, promotion);
        }));
    }

    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetById(int id)
    {
        var p = await db.Products.FirstOrDefaultAsync(p => p.Id == id);
        if (p is null) return NotFound();
        var promotion = await db.ProductPromotions.FirstOrDefaultAsync(x => x.ProductId == id);
        var hasMapped = await db.ProductMappingItems.AnyAsync(i => i.ProductId == id);
        var lastOrderDate = await db.OrderItems
            .Include(oi => oi.Order)
            .Where(oi => oi.ProductId == id && oi.Order.OrderDate.HasValue)
            .MaxAsync(oi => (DateTime?)oi.Order.OrderDate);
        var orderCount = await db.OrderItems
            .Where(oi => oi.ProductId == id)
            .SumAsync(oi => (int?)oi.Quantity) ?? 0;
        return Ok(ToDto(p, hasMapped, lastOrderDate: lastOrderDate, orderCount: orderCount, promotion: promotion));
    }

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

    private static ProductDto ToDto(
        Product p,
        bool hasMapping,
        double relevance = 0.0,
        DateTime? lastOrderDate = null,
        int orderCount = 0,
        ProductPromotion? promotion = null) => new(
        p.Id, p.MigrosUrl, p.Name, p.ImageUrl, p.ImageData, p.Barcodes,
        p.WeightText, p.WeightMinGrams, p.WeightMaxGrams, p.WeightUnit,
        p.Price, p.Multiplier, p.PriceFetchedAt, p.LastSyncedAt, p.Categories, hasMapping,
        ParseAvailable(p.AdditionalInfo), relevance, orderCount, lastOrderDate,
        p.MigrosId, p.MigrosOnlineId, p.MigrosUid, p.StickerPrintedAt,
        promotion?.PromotionPrice, promotion?.BadgeDescription, promotion?.StartDate, promotion?.EndDate);

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] UpdateProductRequest req)
    {
        var p = await db.Products.FindAsync(id);
        if (p is null) return NotFound();
        p.Name = req.Name;
        p.Barcodes = req.Barcodes;
        p.WeightText = req.WeightText;
        p.WeightMinGrams = req.WeightMinGrams;
        p.WeightMaxGrams = req.WeightMaxGrams;
        p.WeightUnit = req.WeightUnit;
        p.Price = req.Price;
        p.Categories = req.Categories;
        await db.SaveChangesAsync();
        var hasMapped = await db.ProductMappingItems.AnyAsync(i => i.ProductId == id);
        return Ok(ToDto(p, hasMapped));
    }

    [HttpPost("{id:int}/sync")]
    public async Task<IActionResult> Sync(int id, CancellationToken ct)
    {
        var p = await db.Products.FindAsync([id], ct);
        if (p is null) return NotFound();
        var updated = await productSync.SyncAsync(p.MigrosId, p.MigrosOnlineId, p.MigrosUid, ct);
        if (updated is null) return StatusCode(502, "Sync failed");
        var hasMapped = await db.ProductMappingItems.AnyAsync(i => i.ProductId == updated.Id, ct);
        return Ok(ToDto(updated, hasMapped));
    }

    [HttpPost("sync-url")]
    public async Task<IActionResult> SyncByUrl([FromBody] SyncUrlRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.MigrosUrl)) return BadRequest("migrosUrl required");
        var product = await productSync.SyncAsync(req.MigrosUrl, ct);
        return product is null ? StatusCode(502, "Sync failed") : Ok(product);
    }

    [HttpPost("sync-unavailable")]
    public async Task<ActionResult<UnavailableProductRefreshResult>> SyncUnavailable(CancellationToken ct)
    {
        return Ok(await productSync.RefreshUnavailableProductsAsync(ct));
    }

    [HttpPost("sync-thumbnails")]
    public async Task<IActionResult> SyncThumbnails(CancellationToken ct)
    {
        var products = await db.Products
            .Where(p => p.ImageData == null && p.ImageUrl != null)
            .OrderBy(p => p.Id)
            .ToListAsync(ct);

        logger.LogInformation("Starting thumbnail sync for {Total} products without thumbnails", products.Count);

        int synced = 0, failed = 0;
        for (int i = 0; i < products.Count; i++)
        {
            var p = products[i];
            logger.LogInformation("[{Index}/{Total}] Fetching thumbnail for '{Name}' ({Url})",
                i + 1, products.Count, p.Name, p.ImageUrl);
            try
            {
                var data = await thumbnailService.FetchThumbnailAsync(p.ImageUrl!, ct);
                if (data is not null)
                {
                    p.ImageData = data;
                    synced++;
                    logger.LogInformation("[{Index}/{Total}] OK — '{Name}'", i + 1, products.Count, p.Name);
                }
                else
                {
                    failed++;
                    logger.LogWarning("[{Index}/{Total}] FAILED — '{Name}'", i + 1, products.Count, p.Name);
                }
            }
            catch (OperationCanceledException)
            {
                logger.LogInformation("Thumbnail sync cancelled after {Synced} synced, {Failed} failed (remaining: {Remaining})",
                    synced, failed, products.Count - i);
                await db.SaveChangesAsync(CancellationToken.None);
                return Ok(new { synced, failed, cancelled = true });
            }

            // Save every 10 products so progress isn't lost on unexpected shutdown
            if ((i + 1) % 10 == 0)
                await db.SaveChangesAsync(ct);
        }

        await db.SaveChangesAsync(ct);
        logger.LogInformation("Thumbnail sync complete: {Synced} synced, {Failed} failed", synced, failed);
        return Ok(new { synced, failed, cancelled = false });
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var p = await db.Products.FindAsync(id);
        if (p is null) return NotFound();
        db.Products.Remove(p);
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpDelete("all")]
    public async Task<IActionResult> DeleteAll()
    {
        db.Products.RemoveRange(db.Products);
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPost("sticker-printed")]
    public async Task<IActionResult> MarkStickerPrinted([FromBody] int[] ids)
    {
        var now = DateTime.UtcNow;
        var products = await db.Products.Where(p => ids.Contains(p.Id)).ToListAsync();
        foreach (var p in products)
            p.StickerPrintedAt = now;
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpDelete("sticker-printed")]
    public async Task<IActionResult> ClearStickerPrinted()
    {
        var products = await db.Products.Where(p => p.StickerPrintedAt != null).ToListAsync();
        foreach (var p in products)
            p.StickerPrintedAt = null;
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpGet("by-barcode")]
    public async Task<IActionResult> GetByBarcode([FromQuery] string barcode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(barcode)) return BadRequest("barcode required");

        var allProducts = await db.Products.ToListAsync(ct);
        var matches = allProducts
            .Where(p => p.Barcodes
                .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Contains(barcode.Trim()))
            .ToList();

        if (matches.Any())
        {
            var mappedIds = (await db.ProductMappingItems.Select(i => i.ProductId).ToListAsync(ct)).ToHashSet();
            return Ok(new { type = "found", products = matches.Select(p => ToDto(p, mappedIds.Contains(p.Id))) });
        }

        var (cards, _) = await productSync.SyncBySearchAsync(barcode.Trim(), ct: ct);
        if (cards.Count == 0)
            return Ok(new { type = "unknown", choices = Array.Empty<object>() });

        var choices = cards.Select(c => new ScanChoice(
            c.Uid ?? 0,
            c.EffectiveName ?? c.Name ?? "Unbekannt",
            c.EffectiveImageUrl,
            c.EffectiveWeightText,
            c.EffectivePrice,
            c.EffectiveMultiplier,
            c.EffectivePromotionPrice,
            c.EffectivePromotionBadge,
            c.HasCurrentOffer)).ToArray();

        return Ok(new { type = "candidates", choices });
    }

    [HttpGet("by-uid")]
    public async Task<IActionResult> GetByUid([FromQuery] long uid, CancellationToken ct)
    {
        var product = await db.Products.FirstOrDefaultAsync(p => p.MigrosUid == uid, ct);
        if (product is null)
            product = await productSync.SyncAsync(null, migrosOnlineId: null, migrosUid: uid, ct);
        if (product is null)
            return NotFound();
        var hasMapped = await db.ProductMappingItems.AnyAsync(i => i.ProductId == product.Id, ct);
        return Ok(ToDto(product, hasMapped));
    }
}

public record ProductDto(
    int Id,
    string? MigrosUrl,
    string Name,
    string? ImageUrl,
    string? ImageData,
    string Barcodes,
    string? WeightText,
    decimal? WeightMinGrams,
    decimal? WeightMaxGrams,
    string? WeightUnit,
    decimal? Price,
    int Multiplier,
    DateTime? PriceFetchedAt,
    DateTime? LastSyncedAt,
    string? Categories,
    bool HasMapping,
    bool Available,
    double Relevance,
    int OrderCount,
    DateTime? LastOrderDate,
    string? MigrosId,
    long? MigrosOnlineId,
    long? MigrosUid,
    DateTime? StickerPrintedAt,
    decimal? PromotionPrice,
    string? PromotionBadgeDescription,
    DateTime? PromotionStartDate,
    DateTime? PromotionEndDate);

public record SyncUrlRequest(string MigrosUrl);

public record UpdateProductRequest(
    string Name,
    string Barcodes,
    string? WeightText,
    decimal? WeightMinGrams,
    decimal? WeightMaxGrams,
    string? WeightUnit,
    decimal? Price,
    string? Categories);
