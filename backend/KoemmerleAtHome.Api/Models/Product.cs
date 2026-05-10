namespace KoemmerleAtHome.Api.Models;

public class Product
{
    public int Id { get; set; }
    public string? MigrosId { get; set; }                   // 12-digit MGB article id -> /products/mgb/{migrosId}
    public long? MigrosOnlineId { get; set; }               // MO/catalog id -> /products/mo/{migrosOnlineId}
    public long? MigrosUid { get; set; }                    // product-card/search/shopping-list uid; order uniqueId
    public string? MigrosUrl { get; set; }                  // display only — link for user navigation
    public string Name { get; set; } = string.Empty;
    public string? ImageUrl { get; set; }
    public string? ImageData { get; set; }  // base64 compact JPEG thumbnail (~128px), stored locally
    public string Barcodes { get; set; } = string.Empty;    // comma-separated GTINs
    public string? WeightText { get; set; }                 // e.g. "700–950 g"
    public decimal? WeightMinGrams { get; set; }
    public decimal? WeightMaxGrams { get; set; }
    public string? WeightUnit { get; set; }                 // "g", "kg", "Stück"
    public decimal? Price { get; set; }
    public int Multiplier { get; set; } = 1;                  // Migros offer pack multiplier, e.g. 2 for "2 x 2 l"
    public DateTime? PriceFetchedAt { get; set; }
    public DateTime? LastSyncedAt { get; set; }             // null = stub only
    public string? Categories { get; set; }                 // pipe-separated breadcrumb
    public string? AdditionalInfo { get; set; }            // JSON: {"available": true/false, ...}
}
