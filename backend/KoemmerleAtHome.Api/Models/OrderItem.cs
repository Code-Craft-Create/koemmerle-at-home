namespace KoemmerleAtHome.Api.Models;

public class OrderItem
{
    public int Id { get; set; }
    public int OrderId { get; set; }
    public Order Order { get; set; } = null!;
    public int? ProductId { get; set; }          // null until synced
    public Product? Product { get; set; }
    public string? MigrosId { get; set; }        // 12-digit MGB article id
    public long? MigrosOnlineId { get; set; }    // order productId / migrosOnlineId / MO endpoint id
    public long? MigrosUid { get; set; }         // order uniqueId / shopping-list uid
    public string ProductNameAtOrder { get; set; } = string.Empty;
    public int Quantity { get; set; }
    public decimal? UnitPrice { get; set; }
    public decimal? TotalPrice { get; set; }
}
