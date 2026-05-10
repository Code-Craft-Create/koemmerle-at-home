using Microsoft.AspNetCore.SignalR;

namespace KoemmerleAtHome.Api.Hubs;

public class ScanHub : Hub
{
    // Clients subscribe to receive scan results in real time.
    // Server pushes via IScanNotifier (injected into controllers/services).
}
