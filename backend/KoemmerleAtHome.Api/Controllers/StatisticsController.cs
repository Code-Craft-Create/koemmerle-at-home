using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class StatisticsController(AppDbContext db, ScanQueueService scanQueueService) : ControllerBase
{
    [HttpGet("debug")]
    public async Task<IActionResult> Debug([FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct)
    {
        var allOrders = await db.Orders.ToListAsync(ct);
        var allItems  = await db.OrderItems.Include(i => i.Order).ToListAsync(ct);

        var ordersWithDate    = allOrders.Where(o => o.OrderDate.HasValue).ToList();
        var ordersWithoutDate = allOrders.Where(o => !o.OrderDate.HasValue).ToList();

        var inRange = from.HasValue || to.HasValue
            ? ordersWithDate.Where(o =>
                (!from.HasValue || o.OrderDate >= from.Value) &&
                (!to.HasValue   || o.OrderDate <= to.Value.Date.AddDays(1))).ToList()
            : ordersWithDate;

        var itemsInRange = allItems
            .Where(i => inRange.Any(o => o.Id == i.OrderId))
            .ToList();

        return Ok(new
        {
            filter = new { from, to },
            orders = new
            {
                total         = allOrders.Count,
                withDate      = ordersWithDate.Count,
                withoutDate   = ordersWithoutDate.Count,
                inRange       = inRange.Count,
                withoutDateDetails = ordersWithoutDate.Select(o => new
                {
                    o.Id, o.MigrosOrderId, o.Status, o.DateText, o.FirstSeenAt
                }),
                inRangeDetails = inRange.Select(o => new
                {
                    o.Id, o.MigrosOrderId, o.Status, orderDate = o.OrderDate, o.DateText
                }),
            },
            items = new
            {
                total       = allItems.Count,
                inRange     = itemsInRange.Count,
                withProduct = itemsInRange.Count(i => i.ProductId.HasValue),
                noProduct   = itemsInRange.Count(i => !i.ProductId.HasValue),
                sample      = itemsInRange.Take(5).Select(i => new
                {
                    i.Id, i.ProductNameAtOrder, i.Quantity,
                    i.ProductId, i.MigrosId, i.MigrosOnlineId, i.MigrosUid,
                    orderDate = i.Order.OrderDate
                }),
            }
        });
    }

    [HttpGet("orders")]
    public async Task<IActionResult> OrderStats(
        [FromQuery] DateTime? from,
        [FromQuery] DateTime? to,
        CancellationToken ct)
    {
        var query = db.OrderItems
            .Include(oi => oi.Order)
            .Include(oi => oi.Product)
            .Where(oi => oi.Order.OrderDate.HasValue);

        if (from.HasValue)
            query = query.Where(oi => oi.Order.OrderDate >= from.Value);
        if (to.HasValue)
            query = query.Where(oi => oi.Order.OrderDate <= to.Value.Date.AddDays(1));

        var items = await query.ToListAsync(ct);

        var stats = items
            .GroupBy(StatsGroupKey)
            .Select(g =>
            {
                var first = g.First();
                var totalQty = g.Sum(oi => oi.Quantity);

                decimal? totalWeightGrams = null;
                var p = first.Product;
                if (p?.WeightMinGrams.HasValue == true || p?.WeightMaxGrams.HasValue == true)
                {
                    var minW = p.WeightMinGrams ?? p.WeightMaxGrams!.Value;
                    var maxW = p.WeightMaxGrams ?? p.WeightMinGrams!.Value;
                    totalWeightGrams = (minW + maxW) / 2m * totalQty;
                }

                return new OrderStatDto(
                    first.ProductId,
                    first.Product?.Name ?? first.ProductNameAtOrder,
                    first.Product?.ImageUrl,
                    first.Product?.ImageData,
                    first.Product?.Categories,
                    first.Product?.Multiplier ?? 1,
                    totalQty,
                    totalWeightGrams
                );
            })
            .OrderByDescending(x => x.TotalQuantity)
            .ToList();

        return Ok(stats);
    }
    [HttpGet("forecast")]
    public async Task<IActionResult> Forecast(CancellationToken ct)
    {
        var items = await db.OrderItems
            .Include(oi => oi.Order)
            .Include(oi => oi.Product)
            .Where(oi => oi.Order.OrderDate.HasValue)
            .ToListAsync(ct);

        var today = DateTime.Today;

        var forecast = items
            .GroupBy(StatsGroupKey)
            .Select(g =>
            {
                var first = g.First();
                var dates = g.Select(oi => oi.Order.OrderDate!.Value.Date)
                             .Distinct().OrderBy(d => d).ToList();

                decimal? avgInterval = null;
                if (dates.Count >= 2)
                {
                    var intervals = Enumerable.Range(0, dates.Count - 1)
                        .Select(i => (decimal)(dates[i + 1] - dates[i]).TotalDays).ToList();
                    avgInterval = intervals.Average();
                }

                var lastDate = dates.Max();
                DateTime? predictedNext = avgInterval.HasValue
                    ? lastDate.AddDays((double)avgInterval.Value) : null;
                double? daysUntil = predictedNext.HasValue
                    ? (predictedNext.Value - today).TotalDays : null;

                var firstBarcode = first.Product?.Barcodes
                    .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                    .FirstOrDefault();

                return new ForecastItemDto(
                    first.ProductId,
                    first.Product?.Name ?? first.ProductNameAtOrder,
                    first.Product?.ImageUrl,
                    first.Product?.ImageData,
                    first.Product?.Categories,
                    first.Product?.Multiplier ?? 1,
                    TotalOrders: dates.Count,
                    AvgQuantityPerOrder: (decimal)g.Sum(oi => oi.Quantity) / dates.Count,
                    AvgIntervalDays: avgInterval,
                    LastOrderDate: lastDate,
                    PredictedNextDate: predictedNext,
                    DaysUntilNeeded: daysUntil,
                    FirstBarcode: firstBarcode);
            })
            .OrderBy(f => f.DaysUntilNeeded.HasValue ? 0 : 1)
            .ThenBy(f => f.DaysUntilNeeded)
            .ToList();

        return Ok(forecast);
    }

    [HttpPost("forecast/enqueue")]
    public async Task<IActionResult> Enqueue([FromBody] EnqueueForecastBody body, CancellationToken ct)
    {
        int enqueued = 0, skipped = 0;
        foreach (var barcode in body.Barcodes ?? [])
        {
            var result = await scanQueueService.EnqueueAsync(barcode, 1, ct);
            if (result.Count > 0) enqueued++;
            else skipped++;
        }
        return Ok(new { enqueued, skipped });
    }

    [HttpGet("monthly")]
    public async Task<IActionResult> Monthly([FromQuery] string period = "month", CancellationToken ct = default)
    {
        var items = await db.OrderItems
            .Include(oi => oi.Order)
            .Where(oi => oi.Order.OrderDate.HasValue)
            .ToListAsync(ct);

        List<MonthlyTotalDto> result;

        if (period == "biweekly")
        {
            // Fixed epoch so period boundaries are stable across calls
            var epoch = new DateTime(2020, 1, 1);
            var cutoff = DateTime.Today.AddDays(-14 * 26); // ~1 year of bi-weekly periods

            result = items
                .Where(oi => oi.Order.OrderDate!.Value.Date >= cutoff)
                .GroupBy(oi =>
                {
                    var dayOffset = (oi.Order.OrderDate!.Value.Date - epoch).Days;
                    return (int)Math.Floor(dayOffset / 14.0);
                })
                .Select(g =>
                {
                    var periodStart = epoch.AddDays(g.Key * 14);
                    return new MonthlyTotalDto(
                        Month: periodStart.ToString("yyyy-MM-dd"),
                        TotalQuantity: g.Sum(oi => oi.Quantity));
                })
                .OrderBy(m => m.Month)
                .ToList();
        }
        else
        {
            var cutoff = DateTime.Today.AddMonths(-24);

            result = items
                .GroupBy(oi => new { oi.Order.OrderDate!.Value.Year, oi.Order.OrderDate.Value.Month })
                .Where(g => new DateTime(g.Key.Year, g.Key.Month, 1) >= new DateTime(cutoff.Year, cutoff.Month, 1))
                .Select(g => new MonthlyTotalDto(
                    Month: $"{g.Key.Year:D4}-{g.Key.Month:D2}",
                    TotalQuantity: g.Sum(oi => oi.Quantity)))
                .OrderBy(m => m.Month)
                .ToList();
        }

        return Ok(result);
    }

    private static string StatsGroupKey(KoemmerleAtHome.Api.Models.OrderItem item) =>
        item.ProductId?.ToString()
        ?? item.MigrosId
        ?? (item.MigrosOnlineId.HasValue ? $"mo:{item.MigrosOnlineId.Value}" : null)
        ?? (item.MigrosUid.HasValue ? $"uid:{item.MigrosUid.Value}" : null)
        ?? $"order-item:{item.Id}";
}

public record OrderStatDto(
    int? ProductId,
    string ProductName,
    string? ImageUrl,
    string? ImageData,
    string? Categories,
    int Multiplier,
    int TotalQuantity,
    decimal? TotalWeightGrams);

public record ForecastItemDto(
    int? ProductId,
    string ProductName,
    string? ImageUrl,
    string? ImageData,
    string? Categories,
    int Multiplier,
    int TotalOrders,
    decimal AvgQuantityPerOrder,
    decimal? AvgIntervalDays,
    DateTime LastOrderDate,
    DateTime? PredictedNextDate,
    double? DaysUntilNeeded,
    string? FirstBarcode);

public record MonthlyTotalDto(string Month, int TotalQuantity);

public record EnqueueForecastBody(string[]? Barcodes);
