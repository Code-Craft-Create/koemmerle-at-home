namespace KoemmerleAtHome.Api.Models;

public enum QueueStatus
{
    Pending,
    Processing,
    Done,
    Failed,
    UnknownBarcode
}

public class ScanQueueItem
{
    public int Id { get; set; }
    public string Barcode { get; set; } = string.Empty;
    public string ProductName { get; set; } = string.Empty;
    public string? MigrosId { get; set; }
    public long? MigrosOnlineId { get; set; }
    public long? MigrosUid { get; set; }
    public int Quantity { get; set; } = 1;
    public int Multiplier { get; set; } = 1;
    public DateTime ScannedAt { get; set; } = DateTime.UtcNow;
    public QueueStatus Status { get; set; } = QueueStatus.Pending;
    public string? ErrorMessage { get; set; }
    public string? ProductImageUrl { get; set; }
    public string? ProductImageData { get; set; }  // copied from Product.ImageData at enqueue time
    public string? RecipeName { get; set; }
    public string? RecipeImageData { get; set; }
}
