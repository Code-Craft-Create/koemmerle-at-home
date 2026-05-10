using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Services;

public interface IScanNotifier
{
    Task NotifyScanResultAsync(ScanResult result, string? connectionId = null);
    Task NotifyOrderSyncProgressAsync(OrderProductSyncProgress progress);
    Task NotifyQueueUpdatedAsync(List<KoemmerleAtHome.Api.Models.ScanQueueItem> queue);
}

public record OrderProductSyncProgress(int OrderId, int Done, int Total, string? CurrentProduct, string? LinkedProductUrl = null);

public record ScanChoice(long MigrosUid, string Name, string? ImageUrl, string? WeightText, decimal? Price, int Multiplier = 1);

public record ScanResult(
    string Barcode,
    bool Recognized,
    string? ProductName,
    string? ImageUrl,
    int? QueueItemId,
    int? Quantity,
    int? ItemCount = null,         // >1 for multi-product mappings
    int[]? AllQueueItemIds = null,  // all item IDs so frontend can cancel the group
    ScanChoice[]? Alternatives = null, // if >1 search results, they are listed here for user to choose
    int? TotalAlternatives = null, // the total number of results found by the search api
    int Multiplier = 1);
