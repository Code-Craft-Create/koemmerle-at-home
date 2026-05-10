namespace KoemmerleAtHome.Api.Models;

public class ProductMappingItem
{
    public int Id { get; set; }
    public int MappingId { get; set; }
    public ProductMapping Mapping { get; set; } = null!;
    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;
    public int Quantity { get; set; } = 1;
}
