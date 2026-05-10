namespace KoemmerleAtHome.Api.Models;

public enum OrderSyncStatus { HeaderFetched, DetailFetched, FullySynced }

public class Order
{
    public int Id { get; set; }
    public string MigrosOrderId { get; set; } = string.Empty;   // display order number e.g. "abc-032655520-xyz"
    public string? DetailPath { get; set; }                      // e.g. "/de/order/24255004"
    public string? DateText { get; set; }                        // raw delivery date text from order list
    public DateTime? OrderDate { get; set; }
    public decimal? TotalAmount { get; set; }
    public OrderSyncStatus Status { get; set; } = OrderSyncStatus.HeaderFetched;
    public DateTime FirstSeenAt { get; set; } = DateTime.UtcNow;

    public ICollection<OrderItem> Items { get; set; } = [];
}
