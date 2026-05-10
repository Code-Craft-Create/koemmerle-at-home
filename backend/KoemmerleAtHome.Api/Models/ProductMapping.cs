namespace KoemmerleAtHome.Api.Models;

public class ProductMapping
{
    public int Id { get; set; }
    public string Barcode { get; set; } = string.Empty;  // trigger barcode (real or custom/dummy)
    public string Name { get; set; } = string.Empty;     // display label e.g. "Pizza Margherita"
    public string? ImageData { get; set; }               // base64 data URL for custom image
    public ICollection<ProductMappingItem> Items { get; set; } = [];
}
