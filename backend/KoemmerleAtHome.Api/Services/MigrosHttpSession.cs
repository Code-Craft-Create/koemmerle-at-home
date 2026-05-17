using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace KoemmerleAtHome.Api.Services;

/// <summary>
/// Manages the Migros HTTP session. Authenticated calls use the bearer token
/// from BearerTokenService (captured automatically by PlaywrightLoginService).
/// Guest calls use the leshopch token fetched from the public guest endpoint.
/// </summary>
public sealed class MigrosHttpSession : IDisposable
{
    private const string GuestTokenUrl = "https://www.migros.ch/authentication/public/v1/api/guest";
    private const string DefaultReferer = "https://www.migros.ch/de";
    private static readonly HttpRequestOptionsKey<bool> AuthenticatedGetKey = new("MigrosAuthenticatedGet");
    private static readonly HashSet<string> BrowserHeaderAllowList = new(StringComparer.OrdinalIgnoreCase)
    {
        "accept-language",
        "cache-control",
        "migros-language",
        "peer-id",
        "pragma",
        "priority",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "traceparent",
        "tracestate",
        "user-agent",
        "x-datadog-origin",
        "x-datadog-parent-id",
        "x-datadog-sampling-priority",
        "x-datadog-trace-id",
    };

    private readonly ILogger<MigrosHttpSession> _logger;
    private readonly BearerTokenService _bearerTokenService;
    private readonly HttpClient _httpClient;
    private readonly bool _forceHttp2;
    private readonly MigrosHeaderOptions _headerOptions;
    private readonly object _browserStateLock = new();

    private string? _guestToken;
    private string? _browserCookieHeader;
    private readonly Dictionary<string, string> _browserHeaders = new(StringComparer.OrdinalIgnoreCase);

    public bool IsLoggedIn => _bearerTokenService.IsAvailable;
    public DateTime? TokenExpiresAt => _bearerTokenService.ExpiresAt;

    public MigrosHttpSession(
        BearerTokenService bearerTokenService,
        IConfiguration configuration,
        ILogger<MigrosHttpSession> logger)
    {
        _bearerTokenService = bearerTokenService;
        _logger = logger;
        _forceHttp2 = configuration.GetValue<bool?>("Migros:ForceHttp2")
            ?? OperatingSystem.IsWindows();
        _headerOptions = MigrosHeaderOptions.FromConfiguration(configuration);

        var handler = new HttpClientHandler
        {
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All,
        };
        _httpClient = new HttpClient(handler);
        if (_forceHttp2)
        {
            _httpClient.DefaultRequestVersion = HttpVersion.Version20;
            _httpClient.DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact;
        }
        _httpClient.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", GetFallbackUserAgent());
        _httpClient.DefaultRequestHeaders.Add("Accept", "application/json, text/plain, */*");
        if (_headerOptions.SendAcceptEncoding)
            _httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Encoding", "gzip, deflate, br, zstd");
        _httpClient.DefaultRequestHeaders.Add("Accept-Language", "de");
        _httpClient.DefaultRequestHeaders.Add("migros-language", "de");
        if (_headerOptions.SendPeerId)
            _httpClient.DefaultRequestHeaders.Add("peer-id", "website-js-1147.0.0");
        if (_headerOptions.SendBrowserIdentity)
        {
            _httpClient.DefaultRequestHeaders.Add("Sec-Fetch-Site", "same-origin");
            _httpClient.DefaultRequestHeaders.Add("Sec-Fetch-Mode", "cors");
            _httpClient.DefaultRequestHeaders.Add("Sec-Fetch-Dest", "empty");
        }
        if (_headerOptions.SendPriority)
            _httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Priority", "u=1, i");
    }

    public void UpdateBrowserCookies(string cookieHeader)
    {
        if (string.IsNullOrWhiteSpace(cookieHeader)) return;

        lock (_browserStateLock)
        {
            _browserCookieHeader = cookieHeader;
        }

        _logger.LogDebug("Migros browser session updated headers: Cookie");
    }

    public void UpdateBrowserHeaders(IReadOnlyDictionary<string, string> headers)
    {
        var capturedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        lock (_browserStateLock)
        {
            foreach (var (name, value) in headers)
            {
                if (string.IsNullOrWhiteSpace(value))
                    continue;

                if (string.Equals(name, "cookie", StringComparison.OrdinalIgnoreCase))
                {
                    _browserCookieHeader = value;
                    capturedNames.Add("Cookie");
                    continue;
                }

                if (!BrowserHeaderAllowList.Contains(name) || !ShouldCaptureBrowserHeader(name))
                    continue;

                _browserHeaders[name] = value;
                capturedNames.Add(name);
            }
        }

        if (capturedNames.Count > 0)
            _logger.LogDebug(
                "Migros browser session updated headers: {HeaderNames}",
                string.Join(", ", capturedNames.OrderBy(h => h, StringComparer.OrdinalIgnoreCase)));
    }

    // ── Guest (public) API ────────────────────────────────────────────────────

    public async Task<HttpResponseMessage> GetGuestAsync(string url, CancellationToken ct = default)
    {
        await EnsureGuestTokenAsync(ct);
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Add("leshopch", _guestToken);
        AddCommonHeaders(req);
        return await SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PostGuestAsync(string url, object body, CancellationToken ct = default)
    {
        await EnsureGuestTokenAsync(ct);
        var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        req.Headers.Add("leshopch", _guestToken);
        AddCommonHeaders(req);
        return await SendAsync(req, ct);
    }

    // ── Authenticated API ─────────────────────────────────────────────────────

    public async Task<HttpResponseMessage> GetAuthenticatedAsync(string url, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        AddAuthHeaders(req);
        req.Options.Set(AuthenticatedGetKey, true);
        return await SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> GetAuthenticatedAsync(
        string url, string referer, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        AddAuthHeaders(req, referer);
        req.Options.Set(AuthenticatedGetKey, true);
        return await SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PostAuthenticatedAsync(string url, object body, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req);
        return await SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PutAuthenticatedAsync(string url, object body, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req);
        return await SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PatchAuthenticatedAsync(string url, object body, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Patch, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req);
        return await SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PostAuthenticatedAsync(
        string url, object body, string referer, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(body);
        var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req, referer);
        return await SendAsync(req, ct);
    }

    // ── Diagnostic ────────────────────────────────────────────────────────────

    public async Task<HttpResponseMessage> PostAuthenticatedWithDiagnosticsAsync(
        string url, object body, string referer, ILogger diagLogger, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(body);
        var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req, referer);
        diagLogger.LogDebug("POST {Url}", url);
        return await SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> GetAuthenticatedWithDiagnosticsAsync(
        string url, ILogger diagLogger, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        AddAuthHeaders(req);
        req.Options.Set(AuthenticatedGetKey, true);
        diagLogger.LogDebug("GET {Url}", url);
        return await SendAsync(req, ct);
    }

    // ── Guest token ───────────────────────────────────────────────────────────

    private async Task EnsureGuestTokenAsync(CancellationToken ct)
    {
        if (_guestToken is not null) return;
        var resp = await _httpClient.GetAsync(GuestTokenUrl, ct);
        if (resp.Headers.TryGetValues("leshopch", out var vals))
        {
            _guestToken = vals.FirstOrDefault();
            _logger.LogInformation("Migros guest token acquired");
        }
        else
        {
            _logger.LogWarning("Could not acquire Migros guest token — leshopch header missing");
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void AddCommonHeaders(HttpRequestMessage req, string referer = DefaultReferer)
    {
        ApplyBrowserHeaders(req);
        req.Headers.TryAddWithoutValidation("Referer", referer);
        req.Headers.Remove("x-correlation-id");
        req.Headers.TryAddWithoutValidation("x-correlation-id", Guid.NewGuid().ToString());
    }

    private void AddAuthHeaders(HttpRequestMessage req, string referer = DefaultReferer)
    {
        req.Headers.TryAddWithoutValidation("Authorization", NormalizeBearer(_bearerTokenService.GetToken()));
        AddCommonHeaders(req, referer);
        LogAuthenticatedRequestHeaders(req);
    }

    private void ApplyBrowserHeaders(HttpRequestMessage req)
    {
        string? cookieHeader;
        KeyValuePair<string, string>[] browserHeaders;
        lock (_browserStateLock)
        {
            cookieHeader = _browserCookieHeader;
            browserHeaders = _browserHeaders.ToArray();
        }

        foreach (var (name, value) in browserHeaders)
        {
            if (!ShouldSendBrowserHeader(name))
                continue;

            if (string.Equals(name, "cookie", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "host", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "origin", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "referer", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "authorization", StringComparison.OrdinalIgnoreCase))
                continue;

            req.Headers.Remove(name);
            req.Headers.TryAddWithoutValidation(name, value);
        }

        if (_headerOptions.SendCookies && !string.IsNullOrWhiteSpace(cookieHeader))
            req.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
    }

    private bool ShouldCaptureBrowserHeader(string name) =>
        IsAlwaysCapturedHeader(name) ||
        (_headerOptions.SendPeerId && IsPeerIdHeader(name)) ||
        (_headerOptions.SendBrowserIdentity && IsBrowserIdentityHeader(name)) ||
        (_headerOptions.SendTelemetry && IsTelemetryHeader(name)) ||
        (_headerOptions.SendPriority && IsPriorityHeader(name));

    private bool ShouldSendBrowserHeader(string name) =>
        IsAlwaysCapturedHeader(name) ||
        (_headerOptions.SendPeerId && IsPeerIdHeader(name)) ||
        (_headerOptions.SendBrowserIdentity && IsBrowserIdentityHeader(name)) ||
        (_headerOptions.SendTelemetry && IsTelemetryHeader(name)) ||
        (_headerOptions.SendPriority && IsPriorityHeader(name));

    private static bool IsAlwaysCapturedHeader(string name) =>
        string.Equals(name, "accept-language", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "migros-language", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "user-agent", StringComparison.OrdinalIgnoreCase);

    private static bool IsPeerIdHeader(string name) =>
        string.Equals(name, "peer-id", StringComparison.OrdinalIgnoreCase);

    private static bool IsPriorityHeader(string name) =>
        string.Equals(name, "priority", StringComparison.OrdinalIgnoreCase);

    private static bool IsBrowserIdentityHeader(string name) =>
        string.Equals(name, "sec-ch-ua", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "sec-ch-ua-mobile", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "sec-ch-ua-platform", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "sec-fetch-dest", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "sec-fetch-mode", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "sec-fetch-site", StringComparison.OrdinalIgnoreCase);

    private static bool IsTelemetryHeader(string name) =>
        string.Equals(name, "traceparent", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "tracestate", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "x-datadog-origin", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "x-datadog-parent-id", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "x-datadog-sampling-priority", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(name, "x-datadog-trace-id", StringComparison.OrdinalIgnoreCase);

    private static string NormalizeBearer(string token) =>
        token.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? token : $"Bearer {token}";

    private void LogAuthenticatedRequestHeaders(HttpRequestMessage req)
    {
        if (!_logger.IsEnabled(LogLevel.Debug)) return;

        bool hasCapturedCookie;
        string[] capturedBrowserHeaders;
        lock (_browserStateLock)
        {
            hasCapturedCookie = !string.IsNullOrWhiteSpace(_browserCookieHeader);
            capturedBrowserHeaders = _browserHeaders.Keys
                .OrderBy(h => h, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        var requestHeaders = _httpClient.DefaultRequestHeaders
            .Select(h => h.Key)
            .Concat(req.Headers.Select(h => h.Key))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(h => h, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        _logger.LogDebug(
            "Migros authenticated request prepared: {Method} {Url}; referer={Referer}; headers={HeaderNames}; capturedCookie={CapturedCookie}; capturedBrowserHeaders={CapturedBrowserHeaders}; forceHttp2={ForceHttp2}",
            req.Method.Method,
            req.RequestUri,
            req.Headers.Referrer?.ToString() ?? "(none)",
            string.Join(", ", requestHeaders),
            hasCapturedCookie,
            capturedBrowserHeaders.Length == 0 ? "(none)" : string.Join(", ", capturedBrowserHeaders),
            _forceHttp2);
    }

    private static string GetFallbackUserAgent()
    {
        const string chromiumSuffix = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

        if (OperatingSystem.IsMacOS())
            return $"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) {chromiumSuffix}";

        if (OperatingSystem.IsLinux())
            return $"Mozilla/5.0 (X11; Linux x86_64) {chromiumSuffix}";

        return $"Mozilla/5.0 (Windows NT 10.0; Win64; x64) {chromiumSuffix}";
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        if (_forceHttp2)
            ApplyHttp2(req);

        var canRetry = req.Options.TryGetValue(AuthenticatedGetKey, out var isAuthenticatedGet) &&
            isAuthenticatedGet;
        var retry = canRetry ? await CloneRequestAsync(req, ct) : null;

        var response = await _httpClient.SendAsync(req, ct);
        if (response.StatusCode != HttpStatusCode.Forbidden || retry is null)
            return response;

        response.Dispose();
        _logger.LogDebug("Migros authenticated GET returned 403; retrying once: {Url}", retry.RequestUri);
        await Task.Delay(TimeSpan.FromMilliseconds(200), ct);

        if (_forceHttp2)
            ApplyHttp2(retry);

        return await _httpClient.SendAsync(retry, ct);
    }

    private static void ApplyHttp2(HttpRequestMessage req)
    {
        req.Version = HttpVersion.Version20;
        req.VersionPolicy = HttpVersionPolicy.RequestVersionExact;
    }

    private static async Task<HttpRequestMessage> CloneRequestAsync(HttpRequestMessage source, CancellationToken ct)
    {
        var clone = new HttpRequestMessage(source.Method, source.RequestUri)
        {
            Version = source.Version,
            VersionPolicy = source.VersionPolicy
        };

        foreach (var header in source.Headers)
            clone.Headers.TryAddWithoutValidation(header.Key, header.Value);

        foreach (var option in source.Options)
            clone.Options.Set(new HttpRequestOptionsKey<object?>(option.Key), option.Value);

        if (source.Content is not null)
        {
            var bytes = await source.Content.ReadAsByteArrayAsync(ct);
            clone.Content = new ByteArrayContent(bytes);
            foreach (var header in source.Content.Headers)
                clone.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        return clone;
    }

    public void Dispose() => _httpClient.Dispose();
}

public class MigrosSessionExpiredException()
    : InvalidOperationException(
        "Migros session expired — the browser window needs to be open and logged in to refresh the token automatically.");
