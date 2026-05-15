using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SettingsController(AppDbContext db) : ControllerBase
{
    private const string AutoUpdateOrdersKey = "AutoUpdateOrders";

    [HttpGet]
    public async Task<ActionResult<AppSettingsDto>> Get(CancellationToken ct)
    {
        return Ok(new AppSettingsDto(await GetBoolAsync(AutoUpdateOrdersKey, ct)));
    }

    [HttpPut("auto-update-orders")]
    public async Task<ActionResult<AppSettingsDto>> SetAutoUpdateOrders([FromBody] SetAutoUpdateOrdersRequest request, CancellationToken ct)
    {
        await SetBoolAsync(AutoUpdateOrdersKey, request.AutoUpdateOrders, ct);
        return Ok(new AppSettingsDto(request.AutoUpdateOrders));
    }

    private async Task<bool> GetBoolAsync(string key, CancellationToken ct)
    {
        var value = await db.AppSettings
            .Where(s => s.Key == key)
            .Select(s => s.Value)
            .FirstOrDefaultAsync(ct);

        if (value is null) return false;

        return bool.TryParse(value, out var enabled) && enabled;
    }

    private async Task SetBoolAsync(string key, bool value, CancellationToken ct)
    {
        var setting = await db.AppSettings.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (setting is null)
        {
            db.AppSettings.Add(new AppSetting { Key = key, Value = value.ToString() });
        }
        else
        {
            setting.Value = value.ToString();
        }

        await db.SaveChangesAsync(ct);
    }

    [HttpGet("json/{key}")]
    public async Task<IActionResult> GetJson(string key, CancellationToken ct)
    {
        var value = await db.AppSettings
            .Where(s => s.Key == key)
            .Select(s => s.Value)
            .FirstOrDefaultAsync(ct);
        return Ok(new { value });
    }

    [HttpPut("json/{key}")]
    public async Task<IActionResult> SetJson(string key, [FromBody] SetJsonRequest req, CancellationToken ct)
    {
        var setting = await db.AppSettings.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (setting is null)
            db.AppSettings.Add(new AppSetting { Key = key, Value = req.Value });
        else
            setting.Value = req.Value;
        await db.SaveChangesAsync(ct);
        return NoContent();
    }
}

public record AppSettingsDto(bool AutoUpdateOrders);
public record SetAutoUpdateOrdersRequest(bool AutoUpdateOrders);
public record SetJsonRequest(string Value);
