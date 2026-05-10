using Microsoft.Playwright;

namespace KoemmerleAtHome.Api.Services;

/// <summary>
/// Owns the Playwright browser used solely for login and bearer-token capture.
/// Navigates to migros.ch on startup and whenever StartLoginAsync() is called.
/// Token is captured from the silent OAuth response and stored in BearerTokenService.
/// </summary>
public class PlaywrightLoginService(BearerTokenService bearerTokenService, ILogger<PlaywrightLoginService> logger)
    : BackgroundService
{
    private static string SessionDir =>
        Path.Combine(Directory.GetCurrentDirectory(), "playwright-session");

    private IBrowserContext? _context;
    private bool _isLoggedIn;

    public bool IsLoggedIn => _isLoggedIn;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await LaunchBrowserAsync();
        await NavigateAndWaitForLoginAsync(stoppingToken);
        await KeepTokenFreshAsync(stoppingToken);
    }

    private async Task KeepTokenFreshAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var delay = TimeSpan.FromMinutes(25); // default: refresh every 25 min
            if (bearerTokenService.ExpiresAt.HasValue)
            {
                var timeLeft = bearerTokenService.ExpiresAt.Value - DateTime.UtcNow;
                // Navigate 2 minutes before expiry so the new token arrives before the old one runs out.
                delay = timeLeft - TimeSpan.FromMinutes(2);
            }

            if (delay < TimeSpan.FromSeconds(10))
                delay = TimeSpan.FromSeconds(10);

            await Task.Delay(delay, ct);

            if (ct.IsCancellationRequested) break;
            logger.LogInformation("Refreshing bearer token via browser navigation");
            await NavigateForTokenAsync(ct);
        }
    }

    private async Task NavigateForTokenAsync(CancellationToken ct)
    {
        if (_context is null) return;
        try
        {
            var page = _context.Pages.FirstOrDefault() ?? await _context.NewPageAsync();
            await page.GotoAsync("https://www.migros.ch/de",
                new() { WaitUntil = WaitUntilState.DOMContentLoaded });
        }
        catch (Exception ex)
        {
            logger.LogWarning("Token refresh navigation failed: {Error}", ex.Message);
        }
    }

    // Called from AuthController — opens (or re-navigates) the browser window.
    public Task StartLoginAsync() => NavigateForTokenAsync(CancellationToken.None);

    private async Task LaunchBrowserAsync()
    {
        var playwright = await Playwright.CreateAsync();
        Directory.CreateDirectory(SessionDir);

        // Remove stale Chromium lock files that survive crashes.
        foreach (var lockFile in new[] { "SingletonLock", "SingletonCookie", "SingletonSocket" })
        {
            try { File.Delete(Path.Combine(SessionDir, lockFile)); } catch { }
        }

        _context = await playwright.Chromium.LaunchPersistentContextAsync(SessionDir, new()
        {
            Headless = false,
            ViewportSize = new ViewportSize { Width = 756, Height = 982 },
            Args = ["--window-position=756,0"],
        });

        // Capture bearer token from every migros.ch page load (silent OAuth flow).
        _context.Response += async (_, response) =>
        {
            if (response.Url.Contains("/oauth/login-success") && response.Status == 200)
            {
                try
                {
                    var json = await response.JsonAsync();
                    if (json.HasValue)
                    {
                        var token = json.Value.GetProperty("accessToken").GetString();
                        if (token is not null) bearerTokenService.SetToken(token);
                    }
                }
                catch { }
            }
        };

        logger.LogInformation("Playwright browser launched. Session stored at: {Dir}", SessionDir);
    }

    private async Task NavigateAndWaitForLoginAsync(CancellationToken ct)
    {
        if (_context is null) return;

        var page = _context.Pages.FirstOrDefault() ?? await _context.NewPageAsync();
        await page.GotoAsync("https://www.migros.ch/de",
            new() { WaitUntil = WaitUntilState.DOMContentLoaded });

        var loginBtn = page.Locator("[data-testid='login-button']");
        if (await loginBtn.IsVisibleAsync())
        {
            logger.LogWarning("Not logged in to Migros — please log in manually in the browser window");
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(2000, ct);
                if (!await loginBtn.IsVisibleAsync()) break;
            }
        }

        _isLoggedIn = true;
        logger.LogInformation("Logged in to Migros");
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        if (_context is not null)
            await _context.CloseAsync();
    }
}
