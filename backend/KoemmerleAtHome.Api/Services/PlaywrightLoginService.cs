using Microsoft.Playwright;
using KoemmerleAtHome.Api;
using System.Text.Json;

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
    private const string BringListsUrl = "https://web.getbring.com/app/lists";
    private const int BrowserWindowLeft = 756;
    private const int BrowserViewportWidth = 1100;
    private const int BrowserViewportHeight = 982;
    private IBrowserContext? _context;
    private bool _isLoggedIn;
    private IReadOnlyList<BringAvailableList> _bringLists = [];
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
            await NavigateForTokenAsync(stoppingToken, focusWindow: false);
            _isLoggedIn = true;
            logger.LogInformation("Persisted Migros bearer token available; token refresh navigation completed");
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
            await PrepareInteractivePageAsync(page);
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
                await PrepareInteractivePageAsync(page);
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

    public Task StartBringListSyncAsync()
    {
        logger.LogInformation("Scheduling Bring list browser navigation");
        _ = Task.Run(async () =>
        {
            try
            {
                _bringLists = [];
                await EnsureBrowserAsync();
                if (_context is null) return;

                var page = _context.Pages.LastOrDefault(p =>
                    p.Url.Contains("getbring.com", StringComparison.OrdinalIgnoreCase))
                    ?? await _context.NewPageAsync();

                await PrepareInteractivePageAsync(page);
                await page.BringToFrontAsync();
                await page.GotoAsync(BringListsUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded });
                await InjectBringBannerAsync(page);
                await page.BringToFrontAsync();
                _ = WatchBringListsAsync(page);
                logger.LogInformation("Bring list browser navigation finished");
            }
            catch (Exception ex)
            {
                logger.LogWarning("Bring browser navigation failed: {Error}", ex.Message);
            }
        });

        return Task.CompletedTask;
    }

    public async Task<IReadOnlyList<BringAvailableList>> GetBringListsAsync(CancellationToken ct = default)
    {
        if (_context is null)
            return _bringLists;

        var page = FindBringPage();
        if (page is null)
            return _bringLists;

        try
        {
            await page.WaitForLoadStateAsync(LoadState.DOMContentLoaded);
            var lists = await ReadBringListsAsync(page);
            if (lists.Count > 0)
                _bringLists = lists;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Bring list selector read failed");
        }

        return _bringLists;
    }

    public async Task<IReadOnlyList<BringListItem>> ExtractBringListItemsAsync(string? listName = null, CancellationToken ct = default)
    {
        logger.LogInformation("Starting Bring list extraction");
        await EnsureBrowserAsync();
        if (_context is null)
        {
            logger.LogWarning("Bring extraction aborted: Playwright browser context is not available");
            return [];
        }

        logger.LogInformation("Bring extraction sees {PageCount} open Playwright page(s): {Urls}",
            _context.Pages.Count,
            string.Join(" | ", _context.Pages.Select(p => string.IsNullOrWhiteSpace(p.Url) ? "(blank)" : p.Url)));

        var page = FindBringPage();
        if (page is null && !string.IsNullOrWhiteSpace(listName))
        {
            page = await _context.NewPageAsync();
            await PrepareInteractivePageAsync(page);
            await page.GotoAsync(BringListsUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded });
        }

        if (page is null)
        {
            logger.LogWarning("Bring extraction aborted: no open getbring.com page found");
            throw new InvalidOperationException("No Bring page is open. Start list sync first.");
        }

        logger.LogInformation("Bring extraction using page URL: {Url}", page.Url);

        try
        {
            await page.WaitForLoadStateAsync(LoadState.DOMContentLoaded);
            logger.LogInformation("Bring page load state reached DOMContentLoaded; current URL: {Url}", page.Url);

            if (!string.IsNullOrWhiteSpace(listName))
                await SelectBringListAsync(page, listName, ct);

            var containerCount = await page.Locator(".bring-list-item-container.bring-list-item-container-to-purchase").CountAsync();
            var textContainerCount = await page.Locator(".bring-list-item-container.bring-list-item-container-to-purchase .bring-list-item-text-container").CountAsync();
            var nameCount = await page.Locator(".bring-list-item-container.bring-list-item-container-to-purchase .bring-list-item-name").CountAsync();
            var specificationCount = await page.Locator(".bring-list-item-container.bring-list-item-container-to-purchase .bring-list-item-specification-label").CountAsync();
            logger.LogInformation(
                "Bring DOM selector counts: containers={ContainerCount}, textContainers={TextContainerCount}, names={NameCount}, specifications={SpecificationCount}",
                containerCount, textContainerCount, nameCount, specificationCount);

            var itemsJson = await page.EvaluateAsync<string>("""
                (() => {
                  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
                  const textContainers = Array.from(document.querySelectorAll(
                    '.bring-list-item-container.bring-list-item-container-to-purchase .bring-list-item-text-container'
                  ));

                  const items = textContainers
                    .map((textContainer) => {
                      const name = clean(textContainer.querySelector('.bring-list-item-name')?.textContent);
                      const specification = clean(textContainer.querySelector('.bring-list-item-specification-label')?.textContent);
                      return name ? { name, specification: specification || null } : null;
                    })
                    .filter(Boolean);

                  return JSON.stringify(items);
                })()
                """);

            var items = string.IsNullOrWhiteSpace(itemsJson)
                ? []
                : JsonSerializer.Deserialize<List<BringListItemPayload>>(itemsJson, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                }) ?? [];

            logger.LogInformation("Bring DOM evaluation returned {ItemCount} raw item(s)", items?.Count ?? 0);

            var cleaned = (items ?? [])
                .Where(i => !string.IsNullOrWhiteSpace(i.Name))
                .Select(i => new BringListItem(i.Name.Trim(), string.IsNullOrWhiteSpace(i.Specification) ? null : i.Specification.Trim()))
                .ToList();

            logger.LogInformation("Bring extraction cleaned {ItemCount} item(s): {Items}",
                cleaned.Count,
                string.Join(" | ", cleaned.Take(20).Select(i =>
                    string.IsNullOrWhiteSpace(i.Specification) ? i.Name : $"{i.Name} ({i.Specification})")));

            return cleaned;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Bring list extraction failed on page URL {Url}", page.Url);
            throw;
        }
    }

    private IPage? FindBringPage() => _context?.Pages.LastOrDefault(p =>
        p.Url?.Contains("getbring.com", StringComparison.OrdinalIgnoreCase) == true);

    private async Task WatchBringListsAsync(IPage page)
    {
        var deadline = DateTime.UtcNow.AddMinutes(5);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                if (page.IsClosed)
                    return;

                if (!page.Url.Contains("getbring.com", StringComparison.OrdinalIgnoreCase))
                    return;

                await InjectBringBannerAsync(page);
                var lists = await ReadBringListsAsync(page);
                if (lists.Count > 0)
                {
                    _bringLists = lists;
                    logger.LogInformation("Bring list selector found {ListCount} list(s): {Lists}",
                        lists.Count,
                        string.Join(" | ", lists.Select(l => $"{l.Name} ({l.ItemCount?.ToString() ?? "?"})")));

                    return;
                }
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Waiting for Bring list selector failed");
            }

            await Task.Delay(1000);
        }
    }

    private static async Task<IReadOnlyList<BringAvailableList>> ReadBringListsAsync(IPage page)
    {
        var listsJson = await page.EvaluateAsync<string>("""
            (() => {
              const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
              const entries = Array.from(document.querySelectorAll('.bring-list-selector-entry'));
              const lists = entries
                .map((entry, index) => {
                  const nameElement = entry.querySelector('.bring-list-selector-list-name');
                  const countElement = entry.querySelector('.bring-list-selector-list-item-count');
                  const name = clean(nameElement?.textContent);
                  const countText = clean(countElement?.textContent);
                  const count = Number.parseInt(countText, 10);
                  const selected = entry.classList.contains('selected')
                    || !!entry.querySelector('.selected');
                  return name ? {
                    name,
                    itemCount: Number.isFinite(count) ? count : null,
                    selected,
                    index
                  } : null;
                })
                .filter(Boolean);

              return JSON.stringify(lists);
            })()
            """);

        if (string.IsNullOrWhiteSpace(listsJson))
            return [];

        return JsonSerializer.Deserialize<List<BringAvailableList>>(listsJson, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? [];
    }

    private static async Task SelectBringListAsync(IPage page, string listName, CancellationToken ct)
    {
        var requested = NormalizeBringListName(listName);
        var selector = page.Locator(".bring-list-selector-entry");
        await selector.First.WaitForAsync(new() { Timeout = 30000 });

        var count = await selector.CountAsync();
        for (var i = 0; i < count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var entry = selector.Nth(i);
            var name = await entry.Locator(".bring-list-selector-list-name").InnerTextAsync();
            if (NormalizeBringListName(name) != requested)
                continue;

            await entry.ClickAsync();
            await page.WaitForTimeoutAsync(500);
            return;
        }

        throw new InvalidOperationException($"Bring list '{listName}' was not found.");
    }

    private static string NormalizeBringListName(string value) =>
        string.Join(" ", value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim();

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

        try
        {
            _context = await LaunchPersistentChromiumAsync(playwright);
        }
        catch (PlaywrightException ex) when (IsMissingBrowserExecutable(ex))
        {
            logger.LogWarning("Playwright Chromium is missing or outdated; installing the required browser and retrying launch");
            InstallPlaywrightChromium();
            _context = await LaunchPersistentChromiumAsync(playwright);
        }

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

    private Task<IBrowserContext> LaunchPersistentChromiumAsync(IPlaywright playwright) =>
        playwright.Chromium.LaunchPersistentContextAsync(appData.PlaywrightSessionDirectory, new()
        {
            Headless = false,
            ViewportSize = new ViewportSize { Width = BrowserViewportWidth, Height = BrowserViewportHeight },
            Args =
            [
                $"--window-position={BrowserWindowLeft},0",
                $"--window-size={BrowserViewportWidth},{BrowserViewportHeight}"
            ],
        });

    private static bool IsMissingBrowserExecutable(PlaywrightException ex) =>
        ex.Message.Contains("Executable doesn't exist", StringComparison.OrdinalIgnoreCase) ||
        ex.Message.Contains("Please run the following command to download new browsers", StringComparison.OrdinalIgnoreCase);

    private static void InstallPlaywrightChromium()
    {
        var exitCode = Microsoft.Playwright.Program.Main(["install", "chromium"]);
        if (exitCode != 0)
            throw new InvalidOperationException($"Playwright Chromium install failed with exit code {exitCode}.");
    }

    private async Task NavigateAndWaitForLoginAsync(CancellationToken ct)
    {
        if (_context is null) return;

        var page = _context.Pages.FirstOrDefault() ?? await _context.NewPageAsync();
        await PrepareInteractivePageAsync(page);
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

    private static async Task PrepareInteractivePageAsync(IPage page)
    {
        try
        {
            await page.SetViewportSizeAsync(BrowserViewportWidth, BrowserViewportHeight);
        }
        catch
        {
            // The page may be closing or navigating; navigation will still proceed.
        }
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

    private static async Task InjectBringBannerAsync(IPage page)
    {
        try
        {
            if (!page.Url.Contains("getbring.com", StringComparison.OrdinalIgnoreCase))
                return;

            await page.EvaluateAsync("""
                (() => {
                  const id = 'koemmerle-bring-banner';
                  if (document.getElementById(id)) return;

                  const banner = document.createElement('div');
                  banner.id = id;
                  banner.textContent = 'Bitte bei Bring anmelden. Sobald deine Listen sichtbar sind, erscheinen sie in KÖMMERLE At Home.';
                  banner.style.position = 'fixed';
                  banner.style.top = '0';
                  banner.style.left = '0';
                  banner.style.right = '0';
                  banner.style.zIndex = '2147483647';
                  banner.style.padding = '12px 18px';
                  banner.style.background = '#111111';
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
            // Bring can be mid-navigation while the user logs in or changes lists.
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

public record BringListItem(string Name, string? Specification);
public record BringAvailableList(string Name, int? ItemCount, bool Selected, int Index);
internal record BringListItemPayload(string Name, string? Specification);
