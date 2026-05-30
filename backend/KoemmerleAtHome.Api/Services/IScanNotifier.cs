using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Services;

public interface IScanNotifier
{
    Task NotifyScanResultAsync(ScanResult result, string? connectionId = null);
    Task NotifyOrderSyncProgressAsync(OrderProductSyncProgress progress);
    Task NotifyPromotionSyncProgressAsync(PromotionSyncProgress progress);
    Task NotifyAvailabilitySyncProgressAsync(AvailabilitySyncProgress progress);
    Task NotifyQueueUpdatedAsync(List<KoemmerleAtHome.Api.Models.ScanQueueItem> queue);
    Task NotifyMigrosSessionUpdatedAsync(MigrosSessionStatus status);
}

public record OrderProductSyncProgress(int OrderId, int Done, int Total, string? CurrentProduct, string? LinkedProductUrl = null);

public record PromotionSyncProgress(
    string Stage,
    int Done,
    int Total,
    int ProductCards,
    int PromotionsStored,
    string? Message = null);

public record AvailabilitySyncProgress(
    string Stage,
    int Done,
    int Total,
    int Refreshed,
    int NowAvailable,
    int StillUnavailable,
    int Failed,
    string? Message = null);

public record ScanChoice(
    long MigrosUid,
    string Name,
    string? ImageUrl,
    string? WeightText,
    decimal? Price,
    int Multiplier = 1,
    decimal? PromotionPrice = null,
    string? PromotionBadgeDescription = null,
    bool Available = true);

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
    int Multiplier = 1,
    bool Available = true);
