using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/sticker-exports")]
public class StickerExportsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var exports = await db.StickerExports
            .OrderByDescending(e => e.ExportedAt)
            .ToListAsync(ct);

        return Ok(exports.Select(ToDto));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateStickerExportRequest req, CancellationToken ct)
    {
        var export = new StickerExport
        {
            ExportedAt = DateTime.UtcNow,
            LayoutJson = req.LayoutJson,
            ProductsJson = req.ProductsJson,
        };
        db.StickerExports.Add(export);
        await db.SaveChangesAsync(ct);
        return Ok(ToDto(export));
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var export = await db.StickerExports.FindAsync([id], ct);
        if (export is null) return NotFound();
        db.StickerExports.Remove(export);
        await db.SaveChangesAsync(ct);
        return NoContent();
    }

    private static StickerExportDto ToDto(StickerExport e)
    {
        int count = 0;
        try
        {
            using var doc = JsonDocument.Parse(e.ProductsJson);
            count = doc.RootElement.GetArrayLength();
        }
        catch { }

        return new StickerExportDto(e.Id, e.ExportedAt, count, e.LayoutJson, e.ProductsJson);
    }
}

public record CreateStickerExportRequest(string LayoutJson, string ProductsJson);

public record StickerExportDto(
    int Id,
    DateTime ExportedAt,
    int ProductCount,
    string LayoutJson,
    string ProductsJson);
