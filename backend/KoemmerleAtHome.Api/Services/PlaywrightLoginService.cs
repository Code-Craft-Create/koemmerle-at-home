using Microsoft.Playwright;
using KoemmerleAtHome.Api;

namespace KoemmerleAtHome.Api.Services;

/// <summary>
/// Owns the Playwright browser used solely for login and bearer-token capture.
/// Navigates to migros.ch on startup only when no bearer token is available,
/// and whenever StartLoginAsync() is called.
/// Token is captured from the silent OAuth response and stored in BearerTokenService.
/// </summary>
public class PlaywrightLoginService(
    BearerTokenService bearerTokenService,
    LocalAppData appData,
    ILogger<PlaywrightLoginService> logger)
    : BackgroundService
{
    private IBrowserContext? _context;
    private bool _isLoggedIn;
    private readonly SemaphoreSlim _browserLock = new(1, 1);

    public bool IsLoggedIn => _isLoggedIn;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!bearerTokenService.IsAvailable)
        {
            await LaunchBrowserAsync();
            await NavigateAndWaitForLoginAsync(stoppingToken);
        }
        else
        {
            _isLoggedIn = true;
            logger.LogInformation("Persisted Migros bearer token available; deferring browser navigation until token refresh");
        }

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
            await NavigateForTokenAsync(ct, focusWindow: false);
        }
    }

    private async Task NavigateForTokenAsync(CancellationToken ct, bool focusWindow)
    {
        await EnsureBrowserAsync();
        if (_context is null) return;

        try
        {
            var page = _context.Pages.FirstOrDefault() ?? await _context.NewPageAsync();
            if (focusWindow) await page.BringToFrontAsync();
            await page.GotoAsync("https://www.migros.ch/de",
                new() { WaitUntil = WaitUntilState.DOMContentLoaded });
            await InjectLoginBannerAsync(page);
            if (focusWindow) await page.BringToFrontAsync();
        }
        catch (Exception ex)
        {
            logger.LogWarning("Token refresh navigation failed: {Error}", ex.Message);
            await ResetBrowserAsync();
            try
            {
                var page = _context?.Pages.FirstOrDefault() ?? await _context!.NewPageAsync();
                if (focusWindow) await page.BringToFrontAsync();
                await page.GotoAsync("https://www.migros.ch/de",
                    new() { WaitUntil = WaitUntilState.DOMContentLoaded });
                await InjectLoginBannerAsync(page);
                if (focusWindow) await page.BringToFrontAsync();
            }
            catch (Exception retryEx)
            {
                logger.LogWarning("Token refresh navigation retry failed: {Error}", retryEx.Message);
            }
        }
    }

    // Called from AuthController — opens (or re-navigates) the browser window.
    public Task StartLoginAsync()
    {
        logger.LogInformation("Scheduling Migros login browser navigation");
        var focusWindow = !bearerTokenService.IsAvailable;
        _ = Task.Run(async () =>
        {
            try
            {
                logger.LogInformation("Migros login browser navigation started");
                await NavigateForTokenAsync(CancellationToken.None, focusWindow);
                logger.LogInformation("Migros login browser navigation finished");
            }
            catch (Exception ex)
            {
                logger.LogWarning("Login browser navigation failed: {Error}", ex.Message);
            }
        });

        return Task.CompletedTask;
    }

    private async Task EnsureBrowserAsync()
    {
        if (_context is not null)
            return;

        await _browserLock.WaitAsync();
        try
        {
            if (_context is null)
                await LaunchBrowserAsync();
        }
        finally
        {
            _browserLock.Release();
        }
    }

    private async Task ResetBrowserAsync()
    {
        await _browserLock.WaitAsync();
        try
        {
            if (_context is not null)
            {
                try { await _context.CloseAsync(); } catch { }
                _context = null;
            }

            _isLoggedIn = false;
            await LaunchBrowserAsync();
        }
        finally
        {
            _browserLock.Release();
        }
    }

    private async Task LaunchBrowserAsync()
    {
        var playwright = await Playwright.CreateAsync();
        Directory.CreateDirectory(appData.PlaywrightSessionDirectory);

        // Remove stale Chromium lock files that survive crashes.
        foreach (var lockFile in new[] { "SingletonLock", "SingletonCookie", "SingletonSocket" })
        {
            try { File.Delete(Path.Combine(appData.PlaywrightSessionDirectory, lockFile)); } catch { }
        }

        _context = await playwright.Chromium.LaunchPersistentContextAsync(appData.PlaywrightSessionDirectory, new()
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

        _context.Page += (_, page) =>
        {
            page.Load += async (_, loadedPage) => await InjectLoginBannerAsync(loadedPage);
        };
        foreach (var page in _context.Pages)
        {
            page.Load += async (_, loadedPage) => await InjectLoginBannerAsync(loadedPage);
        }

        logger.LogInformation("Playwright browser launched. Session stored at: {Dir}", appData.PlaywrightSessionDirectory);
    }

    private async Task NavigateAndWaitForLoginAsync(CancellationToken ct)
    {
        if (_context is null) return;

        var page = _context.Pages.FirstOrDefault() ?? await _context.NewPageAsync();
        await page.GotoAsync("https://www.migros.ch/de",
            new() { WaitUntil = WaitUntilState.DOMContentLoaded });
        await InjectLoginBannerAsync(page);

        var loginBtn = page.Locator("[data-testid='login-button']");
        if (await loginBtn.IsVisibleAsync())
        {
            logger.LogWarning("Not logged in to Migros — please log in manually in the browser window");
            await page.BringToFrontAsync();
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(2000, ct);
                if (!await loginBtn.IsVisibleAsync()) break;
            }
        }

        _isLoggedIn = true;
        await RemoveLoginBannerAsync(page);
        logger.LogInformation("Logged in to Migros");
    }

    private static async Task InjectLoginBannerAsync(IPage page)
    {
        try
        {
            if (!page.Url.Contains("migros.ch", StringComparison.OrdinalIgnoreCase))
                return;

            if (!await page.Locator("[data-testid='login-button']").IsVisibleAsync())
            {
                await RemoveLoginBannerAsync(page);
                return;
            }

            await page.EvaluateAsync("""
                (() => {
                  const id = 'koemmerle-login-banner';
                  if (document.getElementById(id)) return;

                  const banner = document.createElement('div');
                  banner.id = id;
                  banner.textContent = 'Bitte bei Migros anmelden, damit KÖMMERLE At Home deinen Warenkorb synchronisieren kann.';
                  banner.style.position = 'fixed';
                  banner.style.top = '0';
                  banner.style.left = '0';
                  banner.style.right = '0';
                  banner.style.zIndex = '2147483647';
                  banner.style.padding = '12px 18px';
                  banner.style.background = '#ff6600';
                  banner.style.color = '#ffffff';
                  banner.style.font = '700 15px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
                  banner.style.lineHeight = '1.35';
                  banner.style.textAlign = 'center';
                  banner.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.18)';

                  document.documentElement.appendChild(banner);
                  document.body.style.paddingTop = `${banner.offsetHeight}px`;
                })();
                """);
        }
        catch
        {
            // Pages can navigate while we inject. The next load event will try again.
        }
    }

    private static async Task RemoveLoginBannerAsync(IPage page)
    {
        try
        {
            await page.EvaluateAsync("""
                (() => {
                  const banner = document.getElementById('koemmerle-login-banner');
                  if (banner) banner.remove();

                  if (document.body?.style.paddingTop) {
                    document.body.style.paddingTop = '';
                  }
                })();
                """);
        }
        catch
        {
            // Pages can navigate while we clean up. The next load event will settle it.
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        if (_context is not null)
            await _context.CloseAsync();
    }
}
