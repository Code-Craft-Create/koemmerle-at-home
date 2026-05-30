namespace KoemmerleAtHome.Api.Models;

public class ProductPromotion
{
    public int Id { get; set; }
    public int ProductId { get; set; }
    public Product? Product { get; set; }
    public decimal PromotionPrice { get; set; }
    public string? BadgeDescription { get; set; }
    public DateTime? StartDate { get; set; }
    public DateTime? EndDate { get; set; }
    public DateTime SyncedAt { get; set; } = DateTime.UtcNow;
}
