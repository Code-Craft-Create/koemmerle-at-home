using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ScanController(
    ScanQueueService queueService,
    MigrosProductSyncService productSync,
    IScanNotifier notifier,
    ILogger<ScanController> logger,
    AppDbContext db) : ControllerBase
{
    private const int SearchPageSize = 20;

    [HttpPost]
    public async Task<IActionResult> Scan([FromBody] ScanRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Barcode))
            return BadRequest("Barcode is required");

        var barcode = request.Barcode.Trim();

        logger.LogInformation("Scanned '{gtin}'",request.Barcode);

        // Stages 1 & 2 (mapping lookup + GTIN match)
        var lookup = await queueService.LookupAsync(barcode, ct);

        ScanResult result;
        if (lookup.Recognized)
        {
            var first = lookup.Items[0];

            var imageUrl = lookup.MappingImageData ?? first.Product.ImageUrl;

            result = new ScanResult(
                barcode, true,
                lookup.MappingName ?? first.Product.Name,
                imageUrl,
                null,
                first.Quantity,
                lookup.Items.Count,
                null,
                Multiplier: first.Product.Multiplier);
        }
        else
        {
            // Stage 3: search Migros by barcode
            var (cards, totalProducts) = await productSync.SyncBySearchAsync(barcode, limit: SearchPageSize, ct: ct);
            if (cards.Count == 1)
            {
                var card = cards[0];
                var product = await productSync.SyncFromProductCardAsync(card, ct);
                result = new ScanResult(
                    barcode,
                    true,
                    product?.Name ?? card.EffectiveName ?? card.Name,
                    product?.ImageUrl ?? card.EffectiveImageUrl,
                    null,
                    1,
                    1,
                    null,
                    Multiplier: product?.Multiplier ?? card.EffectiveMultiplier);
            }
            else if (cards.Count > 1)
            {
                var alternatives = ToChoices(cards);
                result = new ScanResult(barcode, false, "Mehrere Artikel gefunden", null, null, null, null, null, alternatives, totalProducts);
            }
            else
            {
                result = new ScanResult(barcode, false, null, null, null, null, null, null);
            }
        }

        var connectionId = Request.Headers["X-SignalR-Connection-Id"].FirstOrDefault();
        await notifier.NotifyScanResultAsync(result, connectionId);
        return Ok(result);
    }

    [HttpGet("alternatives")]
    public async Task<IActionResult> Alternatives(
        [FromQuery] string barcode,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = SearchPageSize,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(barcode))
            return BadRequest("barcode is required");

        var safeLimit = Math.Clamp(limit, 1, SearchPageSize);
        var safeOffset = Math.Max(offset, 0);
        var (cards, totalProducts) = await productSync.SyncBySearchAsync(barcode.Trim(), safeOffset, safeLimit, ct);
        return Ok(new ScanAlternativesResult(ToChoices(cards), totalProducts));
    }

    [HttpPost("enqueue")]
    public async Task<IActionResult> Enqueue([FromBody] ScanEnqueueRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Barcode))
            return BadRequest("Barcode is required");

        var quantity = request.Quantity > 0 ? request.Quantity : 1;
        var barcode = request.Barcode.Trim();

        logger.LogInformation("Enqueue '{gtin}' x{quantity}",barcode, quantity);

        if (request.MigrosUid.HasValue)
        {
            var product = await db.Products.FirstOrDefaultAsync(p => p.MigrosUid == request.MigrosUid.Value, ct)
                ?? await productSync.SyncAsync(null, migrosOnlineId: null, migrosUid: request.MigrosUid.Value, ct);
            if (product is not null)
            {
                var (item, _) = await queueService.EnqueueProductAsync(product, barcode, quantity, ct);
                return Ok(new[] { item.Id });
            }
        }

        var addedItems = await queueService.EnqueueAsync(barcode, quantity, ct);
        return Ok(addedItems.Select(qi => qi.Id));
    }

    private static ScanChoice[] ToChoices(IEnumerable<ProductCardResponse> cards) =>
        cards.Select(c => new ScanChoice(
            c.Uid ?? 0,
            c.EffectiveName ?? c.Name ?? "Unbekannt",
            c.EffectiveImageUrl,
            c.EffectiveWeightText,
            c.EffectivePrice,
            c.EffectiveMultiplier
        )).ToArray();
}

public record ScanRequest(string Barcode);
public record ScanEnqueueRequest(string Barcode, int Quantity, long? MigrosUid = null);
public record ScanAlternativesResult(ScanChoice[] Choices, int Total);
