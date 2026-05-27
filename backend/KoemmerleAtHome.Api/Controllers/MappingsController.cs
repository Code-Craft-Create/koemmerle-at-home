using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Models;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/recipes")]
public class MappingsController(AppDbContext db, MigrosProductSyncService productSync) : ControllerBase
{
    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetById(int id)
    {
        var mapping = await db.ProductMappings
            .Include(m => m.Items).ThenInclude(i => i.Product)
            .FirstOrDefaultAsync(m => m.Id == id);
        if (mapping is null) return NotFound();
        return Ok(ToDto(mapping));
    }

    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var mappings = await db.ProductMappings
            .Include(m => m.Items).ThenInclude(i => i.Product)
            .OrderBy(m => m.Name)
            .ToListAsync();
        return Ok(mappings.Select(ToDto));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateMappingBody body)
    {
        var mapping = new ProductMapping { Barcode = body.Barcode, Name = body.Name };
        db.ProductMappings.Add(mapping);
        await db.SaveChangesAsync();
        await db.Entry(mapping).Collection(m => m.Items).LoadAsync();
        return Ok(ToDto(mapping));
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] CreateMappingBody body)
    {
        var mapping = await db.ProductMappings.FindAsync(id);
        if (mapping is null) return NotFound();
        mapping.Barcode = body.Barcode;
        mapping.Name = body.Name;
        await db.SaveChangesAsync();
        return Ok();
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var mapping = await db.ProductMappings.FindAsync(id);
        if (mapping is null) return NotFound();
        db.ProductMappings.Remove(mapping);
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpDelete]
    public async Task<IActionResult> DeleteMany([FromBody] DeleteManyRequest request)
    {
        await db.ProductMappings.Where(m => request.Ids.Contains(m.Id)).ExecuteDeleteAsync();
        return NoContent();
    }

    [HttpDelete("all")]
    public async Task<IActionResult> DeleteAll()
    {
        db.ProductMappings.RemoveRange(db.ProductMappings);
        await db.SaveChangesAsync();
        return NoContent();
    }

    // ── Import / Export ──────────────────────────────────────────────────────

    [HttpPost("export")]
    public async Task<IActionResult> Export([FromBody] ExportRecipesRequest request, CancellationToken ct)
    {
        if (request.Ids.Count == 0) return BadRequest("No recipes selected");

        var mappings = await db.ProductMappings
            .Include(m => m.Items).ThenInclude(i => i.Product)
            .Where(m => request.Ids.Contains(m.Id))
            .OrderBy(m => m.Name)
            .ToListAsync(ct);

        var export = new RecipeExportDocument(
            Format: "KoemmerleAtHomeRecipes",
            Version: 1,
            ExportedAt: DateTimeOffset.UtcNow,
            Recipes: mappings.Select(ToExportDto).ToList());

        return Ok(export);
    }

    [HttpPost("import")]
    public async Task<IActionResult> Import([FromBody] RecipeExportDocument document, CancellationToken ct)
    {
        if (!string.Equals(document.Format, "KoemmerleAtHomeRecipes", StringComparison.OrdinalIgnoreCase))
            return BadRequest("Unsupported recipe export format");

        var imported = 0;
        var updated = 0;
        var skippedProducts = new List<ImportSkippedProductDto>();

        foreach (var importedRecipe in document.Recipes)
        {
            if (string.IsNullOrWhiteSpace(importedRecipe.Barcode) || string.IsNullOrWhiteSpace(importedRecipe.Name))
                continue;

            var mapping = await db.ProductMappings
                .Include(m => m.Items)
                .FirstOrDefaultAsync(m => m.Barcode == importedRecipe.Barcode, ct);

            var isNew = mapping is null;
            if (mapping is null)
            {
                mapping = new ProductMapping();
                db.ProductMappings.Add(mapping);
            }

            mapping.Barcode = importedRecipe.Barcode.Trim();
            mapping.Name = importedRecipe.Name.Trim();
            mapping.ImageData = importedRecipe.ImageData;

            if (!isNew)
                db.ProductMappingItems.RemoveRange(mapping.Items);

            await db.SaveChangesAsync(ct);

            foreach (var importedItem in importedRecipe.Items)
            {
                var product = await FindOrSyncProductAsync(importedItem.Product, ct);
                if (product is null)
                {
                    skippedProducts.Add(new ImportSkippedProductDto(
                        importedRecipe.Barcode,
                        importedItem.Product.Name,
                        importedItem.Product.MigrosId,
                        importedItem.Product.MigrosOnlineId,
                        importedItem.Product.MigrosUid));
                    continue;
                }

                db.ProductMappingItems.Add(new ProductMappingItem
                {
                    MappingId = mapping.Id,
                    ProductId = product.Id,
                    Quantity = Math.Max(importedItem.Quantity, 1)
                });
            }

            if (isNew) imported++;
            else updated++;
        }

        await db.SaveChangesAsync(ct);
        return Ok(new ImportRecipesResult(imported, updated, skippedProducts.Count, skippedProducts));
    }

    // ── Items ─────────────────────────────────────────────────────────────────

    [HttpPost("{id:int}/items")]
    public async Task<IActionResult> AddItem(int id, [FromBody] AddItemBody body)
    {
        if (!await db.ProductMappings.AnyAsync(m => m.Id == id)) return NotFound("Mapping not found");
        var product = await db.Products.FindAsync(body.ProductId);
        if (product is null) return NotFound("Product not found");

        var item = new ProductMappingItem { MappingId = id, ProductId = body.ProductId, Quantity = body.Quantity };
        db.ProductMappingItems.Add(item);
        await db.SaveChangesAsync();

        return Ok(ToItemDto(item.Id, product, item.Quantity));
    }

    [HttpPut("{id:int}/items/{itemId:int}")]
    public async Task<IActionResult> UpdateItem(int id, int itemId, [FromBody] UpdateItemBody body)
    {
        var item = await db.ProductMappingItems.Include(i => i.Product)
            .FirstOrDefaultAsync(i => i.Id == itemId && i.MappingId == id);
        if (item is null) return NotFound();
        item.Quantity = body.Quantity;
        await db.SaveChangesAsync();
        return Ok(ToItemDto(item.Id, item.Product, item.Quantity));
    }

    [HttpDelete("{id:int}/items/{itemId:int}")]
    public async Task<IActionResult> RemoveItem(int id, int itemId)
    {
        var item = await db.ProductMappingItems.FirstOrDefaultAsync(i => i.Id == itemId && i.MappingId == id);
        if (item is null) return NotFound();
        db.ProductMappingItems.Remove(item);
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPut("{id:int}/image")]
    public async Task<IActionResult> SetImage(int id, [FromBody] SetImageBody body)
    {
        var mapping = await db.ProductMappings.FindAsync(id);
        if (mapping is null) return NotFound();
        mapping.ImageData = body.ImageData; // null clears the image
        await db.SaveChangesAsync();
        return Ok(new { imageData = mapping.ImageData });
    }

    private async Task<Product?> FindOrSyncProductAsync(ExportProductRefDto productRef, CancellationToken ct)
    {
        var product = await db.Products.FirstOrDefaultAsync(p =>
            (!string.IsNullOrWhiteSpace(productRef.MigrosId) && p.MigrosId == productRef.MigrosId) ||
            (productRef.MigrosOnlineId.HasValue && p.MigrosOnlineId == productRef.MigrosOnlineId) ||
            (productRef.MigrosUid.HasValue && p.MigrosUid == productRef.MigrosUid), ct);
        if (product is not null) return product;

        product = await productSync.SyncAsync(productRef.MigrosId, productRef.MigrosOnlineId, productRef.MigrosUid, ct);
        if (product is null || product.Id == 0) return null;

        return await db.Products.FindAsync([product.Id], ct);
    }

    private static MappingDto ToDto(ProductMapping m) => new(
        m.Id, m.Barcode, m.Name, m.ImageData,
        m.Items.Select(i => ToItemDto(i.Id, i.Product, i.Quantity)).ToList());

    private static MappingItemDto ToItemDto(int id, Product product, int quantity) => new(
        id,
        product.Id,
        product.Name,
        product.MigrosUrl,
        product.ImageUrl,
        product.ImageData,
        quantity,
        product.Multiplier,
        product.WeightText,
        product.Price,
        product.MigrosId,
        product.MigrosOnlineId,
        product.MigrosUid);

    private static ExportRecipeDto ToExportDto(ProductMapping m) => new(
        m.Barcode,
        m.Name,
        m.ImageData,
        m.Items.Select(i => new ExportRecipeItemDto(
            i.Quantity,
            new ExportProductRefDto(
                i.Product.Name,
                i.Product.MigrosId,
                i.Product.MigrosOnlineId,
                i.Product.MigrosUid))).ToList());
}

public record MappingDto(int Id, string Barcode, string Name, string? ImageData, List<MappingItemDto> Items);
public record MappingItemDto(
    int Id,
    int ProductId,
    string ProductName,
    string? MigrosUrl,
    string? ImageUrl,
    string? ImageData,
    int Quantity,
    int Multiplier,
    string? WeightText,
    decimal? Price,
    string? MigrosId,
    long? MigrosOnlineId,
    long? MigrosUid);
public record CreateMappingBody(string Barcode, string Name);
public record AddItemBody(int ProductId, int Quantity = 1);
public record UpdateItemBody(int Quantity);
public record DeleteManyRequest(List<int> Ids);
public record SetImageBody(string? ImageData);
public record ExportRecipesRequest(List<int> Ids);
public record RecipeExportDocument(string Format, int Version, DateTimeOffset ExportedAt, List<ExportRecipeDto> Recipes);
public record ExportRecipeDto(string Barcode, string Name, string? ImageData, List<ExportRecipeItemDto> Items);
public record ExportRecipeItemDto(int Quantity, ExportProductRefDto Product);
public record ExportProductRefDto(string Name, string? MigrosId, long? MigrosOnlineId, long? MigrosUid);
public record ImportRecipesResult(int Imported, int Updated, int SkippedProducts, List<ImportSkippedProductDto> Skipped);
public record ImportSkippedProductDto(string RecipeBarcode, string ProductName, string? MigrosId, long? MigrosOnlineId, long? MigrosUid);
