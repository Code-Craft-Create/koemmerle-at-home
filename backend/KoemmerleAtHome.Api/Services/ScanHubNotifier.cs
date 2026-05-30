using Microsoft.AspNetCore.SignalR;
using KoemmerleAtHome.Api.Hubs;

namespace KoemmerleAtHome.Api.Services;

public class ScanHubNotifier(IHubContext<ScanHub> hubContext) : IScanNotifier
{
    public Task NotifyScanResultAsync(ScanResult result, string? connectionId = null)
    {
        var target = !string.IsNullOrEmpty(connectionId)
            ? (IClientProxy)hubContext.Clients.Client(connectionId)
            : hubContext.Clients.All;
        return target.SendAsync("ScanResult", result);
    }

    public Task NotifyOrderSyncProgressAsync(OrderProductSyncProgress progress) =>
        hubContext.Clients.All.SendAsync("OrderProductSyncProgress", progress);

    public Task NotifyPromotionSyncProgressAsync(PromotionSyncProgress progress) =>
        hubContext.Clients.All.SendAsync("PromotionSyncProgress", progress);

    public Task NotifyAvailabilitySyncProgressAsync(AvailabilitySyncProgress progress) =>
        hubContext.Clients.All.SendAsync("AvailabilitySyncProgress", progress);

    public Task NotifyQueueUpdatedAsync(List<KoemmerleAtHome.Api.Models.ScanQueueItem> queue) =>
        hubContext.Clients.All.SendAsync("QueueUpdated", queue);

    public Task NotifyMigrosSessionUpdatedAsync(MigrosSessionStatus status) =>
        hubContext.Clients.All.SendAsync("MigrosSessionUpdated", status);
}
