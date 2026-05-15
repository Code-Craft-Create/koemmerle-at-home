namespace KoemmerleAtHome.Api.Models;

public class StickerExport
{
    public int Id { get; set; }
    public DateTime ExportedAt { get; set; }
    public string LayoutJson { get; set; } = string.Empty;
    public string ProductsJson { get; set; } = string.Empty;
}
