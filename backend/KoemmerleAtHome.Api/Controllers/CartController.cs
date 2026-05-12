using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class CartController(ScanQueueService queueService, MigrosCartService cartService, AppDbContext db) : ControllerBase
{
    private const string BasketSwimlanesSettingKey = "basket.swimlanes";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly BasketSwimlaneConfig[] DefaultBasketSwimlanes =
    [
        new("fruechte-gemuese", "Früchte & Gemüse",
        [
            "Früchte & Gemüse"
        ]),
        new("milch-fleisch", "Milch & Fleisch",
        [
            "Fleisch & Fisch",
            "Milchprodukte, Eier & frische Fertiggerichte"
        ]),
        new("andere-lebensmittel", "Andere Lebensmittel",
        [
            "Tiefkühlprodukte",
            "Wein, Bier & Spirituosen",
            "Snacks & Süssigkeiten",
            "Getränke, Kaffee & Tee",
            "Pasta, Würzmittel & Konserven",
            "Brot, Backwaren & Frühstück"
        ]),
        new("diverses", "Diverses",
        [
            "Andere",
            "Bekleidung & Accessoires",
            "Drogerie & Kosmetik",
            "Haushalt & Wohnen",
            "Baby & Kinder",
            "Waschen & Putzen",
            "Tierbedarf"
        ])
    ];

    [HttpGet("queue")]
    public async Task<IActionResult> GetQueue() =>
        Ok(await queueService.GetQueueAsync());

    [HttpGet("status")]
    public IActionResult GetStatus() =>
        Ok(new CartStatus(cartService.IsPaused, cartService.IsLoggedIn));

    [HttpGet("basket")]
    public async Task<IActionResult> GetBasket(CancellationToken ct) =>
        Ok(await cartService.GetBasketAsync(ct));

    [HttpGet("basket/swimlanes")]
    public async Task<ActionResult<IReadOnlyList<BasketSwimlaneConfig>>> GetBasketSwimlanes(CancellationToken ct)
    {
        var setting = await db.AppSettings
            .FirstOrDefaultAsync(s => s.Key == BasketSwimlanesSettingKey, ct);

        if (string.IsNullOrWhiteSpace(setting?.Value))
        {
            await SaveBasketSwimlanesSettingAsync(DefaultBasketSwimlanes, ct);
            return Ok(DefaultBasketSwimlanes);
        }

        try
        {
            var swimlanes = JsonSerializer.Deserialize<List<BasketSwimlaneConfig>>(setting.Value, JsonOptions);
            return Ok(SanitiseSwimlanes(swimlanes).ToList());
        }
        catch (JsonException)
        {
            await SaveBasketSwimlanesSettingAsync(DefaultBasketSwimlanes, ct);
            return Ok(DefaultBasketSwimlanes);
        }
    }

    [HttpPut("basket/swimlanes")]
    public async Task<IActionResult> SaveBasketSwimlanes([FromBody] List<BasketSwimlaneConfig>? swimlanes, CancellationToken ct)
    {
        var clean = SanitiseSwimlanes(swimlanes).ToList();
        await SaveBasketSwimlanesSettingAsync(clean, ct);
        return Ok(clean);
    }

    [HttpDelete("basket/swimlanes")]
    public async Task<ActionResult<IReadOnlyList<BasketSwimlaneConfig>>> ResetBasketSwimlanes(CancellationToken ct)
    {
        await SaveBasketSwimlanesSettingAsync(DefaultBasketSwimlanes, ct);
        return Ok(DefaultBasketSwimlanes);
    }

    [HttpPut("basket/quantity")]
    public async Task<IActionResult> SetBasketQuantity([FromBody] SetBasketQuantityRequest req, CancellationToken ct)
    {
        await cartService.SetItemQuantityAsync(req.Uid, req.Quantity, ct);
        return Ok();
    }

    [HttpGet("quantity")]
    public async Task<IActionResult> GetCartQuantity(
        [FromQuery] string barcode,
        [FromQuery] string? migrosId,
        CancellationToken ct)
    {
        var qty = await cartService.GetCartQuantityAsync(barcode, migrosId, ct);
        return Ok(new { currentQuantity = qty ?? 0 });
    }

    [HttpPost("pause")]
    public IActionResult Pause()
    {
        cartService.Pause();
        return Ok();
    }

    [HttpPost("resume")]
    public IActionResult Resume()
    {
        cartService.Resume();
        return Ok();
    }

    [HttpDelete("queue/{id:int}")]
    public async Task<IActionResult> DeleteQueueItem(int id)
    {
        await queueService.DeleteAsync(id);
        return NoContent();
    }

    [HttpDelete("queue/completed")]
    public async Task<IActionResult> DeleteCompleted()
    {
        await queueService.DeleteCompletedAsync();
        return NoContent();
    }

    [HttpDelete("queue/all")]
    public async Task<IActionResult> DeleteAll()
    {
        await queueService.DeleteAllAsync();
        return NoContent();
    }

    [HttpPost("queue/{id:int}/retry")]
    public async Task<IActionResult> RetryQueueItem(int id)
    {
        await queueService.RequeueFailedAsync(id);
        return Ok();
    }

    private static IEnumerable<BasketSwimlaneConfig> SanitiseSwimlanes(IEnumerable<BasketSwimlaneConfig>? swimlanes)
    {
        if (swimlanes is null) yield break;

        foreach (var lane in swimlanes)
        {
            var id = string.IsNullOrWhiteSpace(lane.Id) ? Guid.NewGuid().ToString("N") : lane.Id.Trim();
            var label = string.IsNullOrWhiteSpace(lane.Label) ? "Neue Spalte" : lane.Label.Trim();
            var categories = (lane.Categories ?? [])
                .Where(c => !string.IsNullOrWhiteSpace(c))
                .Select(c => c.Trim())
                .Distinct(StringComparer.Ordinal)
                .ToArray();

            yield return new BasketSwimlaneConfig(id, label, categories);
        }
    }

    private async Task SaveBasketSwimlanesSettingAsync(IEnumerable<BasketSwimlaneConfig> swimlanes, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(SanitiseSwimlanes(swimlanes).ToList(), JsonOptions);

        var setting = await db.AppSettings.FirstOrDefaultAsync(s => s.Key == BasketSwimlanesSettingKey, ct);
        if (setting is null)
        {
            db.AppSettings.Add(new AppSetting { Key = BasketSwimlanesSettingKey, Value = json });
        }
        else
        {
            setting.Value = json;
        }

        await db.SaveChangesAsync(ct);
    }
}

public record CartStatus(bool IsPaused, bool IsLoggedIn);
public record SetBasketQuantityRequest(string Uid, int Quantity);
public record BasketSwimlaneConfig(string Id, string Label, string[] Categories);
