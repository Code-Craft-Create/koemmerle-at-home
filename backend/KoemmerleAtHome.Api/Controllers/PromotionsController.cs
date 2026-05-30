using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class PromotionsController(
    AppDbContext db,
    MigrosPromotionSyncService promotionSync) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var promotions = await db.ProductPromotions
            .Include(p => p.Product)
            .Where(p => p.Product != null)
            .ToListAsync(ct);

        var productIds = promotions.Select(p => p.ProductId).Distinct().ToList();
        var mappedIds = (await db.ProductMappingItems
            .Where(i => productIds.Contains(i.ProductId))
            .Select(i => i.ProductId)
            .ToListAsync(ct)).ToHashSet();

        var orderData = await db.OrderItems
            .Include(oi => oi.Order)
            .Where(oi => oi.ProductId.HasValue && productIds.Contains(oi.ProductId.Value) && oi.Order.OrderDate.HasValue)
            .GroupBy(oi => oi.ProductId!.Value)
            .Select(g => new {
                ProductId = g.Key,
                TotalQty = g.Sum(oi => oi.Quantity),
                LastOrderDate = g.Max(oi => oi.Order.OrderDate)
            })
            .ToDictionaryAsync(x => x.ProductId, ct);

        var now = DateTime.UtcNow;
        var result = promotions.Select(p =>
        {
            var product = p.Product!;
            double relevance = 0.0;
            DateTime? lastOrderDate = null;
            int orderCount = 0;

            if (orderData.TryGetValue(product.Id, out var od))
            {
                lastOrderDate = od.LastOrderDate;
                orderCount = od.TotalQty;
                var oc = Math.Min(od.TotalQty, 10);
                var dso = Math.Max((now - od.LastOrderDate!.Value).TotalDays - 30, 0);
                relevance = oc / (1.0 + dso / 180.0);
            }

            return ToDto(product, p, mappedIds.Contains(product.Id), relevance, lastOrderDate, orderCount);
        })
        .OrderByDescending(p => p.Relevance)
        .ThenByDescending(p => p.OrderCount)
        .ThenBy(p => p.Name)
        .ToList();

        return Ok(result);
    }

    [HttpPost("sync")]
    public async Task<ActionResult<PromotionSyncResult>> Sync(CancellationToken ct)
    {
        return Ok(await promotionSync.SyncNowAsync(ct));
    }

    [HttpDelete]
    public async Task<IActionResult> DeleteAll(CancellationToken ct)
    {
        var promotions = await db.ProductPromotions.ToListAsync(ct);
        db.ProductPromotions.RemoveRange(promotions);
        await db.SaveChangesAsync(ct);
        return Ok(new { deleted = promotions.Count });
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
        Product product,
        ProductPromotion promotion,
        bool hasMapping,
        double relevance,
        DateTime? lastOrderDate,
        int orderCount) => new(
            product.Id,
            product.MigrosUrl,
            product.Name,
            product.ImageUrl,
            product.ImageData,
            product.Barcodes,
            product.WeightText,
            product.WeightMinGrams,
            product.WeightMaxGrams,
            product.WeightUnit,
            product.Price,
            product.Multiplier,
            product.PriceFetchedAt,
            product.LastSyncedAt,
            product.Categories,
            hasMapping,
            ParseAvailable(product.AdditionalInfo),
            relevance,
            orderCount,
            lastOrderDate,
            product.MigrosId,
            product.MigrosOnlineId,
            product.MigrosUid,
            product.StickerPrintedAt,
            promotion.PromotionPrice,
            promotion.BadgeDescription,
            promotion.StartDate,
            promotion.EndDate);
}
