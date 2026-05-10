using System.Net;
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

    private readonly ILogger<MigrosHttpSession> _logger;
    private readonly BearerTokenService _bearerTokenService;
    private readonly HttpClient _httpClient;

    private string? _guestToken;

    public bool IsLoggedIn => _bearerTokenService.IsAvailable;
    public DateTime? TokenExpiresAt => _bearerTokenService.ExpiresAt;

    public MigrosHttpSession(BearerTokenService bearerTokenService, ILogger<MigrosHttpSession> logger)
    {
        _bearerTokenService = bearerTokenService;
        _logger = logger;

        var handler = new HttpClientHandler
        {
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All,
        };
        _httpClient = new HttpClient(handler);
        _httpClient.DefaultRequestHeaders.Add("User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36");
        _httpClient.DefaultRequestHeaders.Add("Accept", "application/json, text/plain, */*");
        _httpClient.DefaultRequestHeaders.Add("Accept-Language", "de");
        _httpClient.DefaultRequestHeaders.Add("Origin", "https://www.migros.ch");
        _httpClient.DefaultRequestHeaders.Add("migros-language", "de");
        _httpClient.DefaultRequestHeaders.Add("peer-id", "website-js-1147.0.0");
    }

    // ── Guest (public) API ────────────────────────────────────────────────────

    public async Task<HttpResponseMessage> GetGuestAsync(string url, CancellationToken ct = default)
    {
        await EnsureGuestTokenAsync(ct);
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Add("leshopch", _guestToken);
        AddCommonHeaders(req);
        return await _httpClient.SendAsync(req, ct);
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
        return await _httpClient.SendAsync(req, ct);
    }

    // ── Authenticated API ─────────────────────────────────────────────────────

    public async Task<HttpResponseMessage> GetAuthenticatedAsync(string url, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        AddAuthHeaders(req);
        return await _httpClient.SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PostAuthenticatedAsync(string url, object body, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req);
        return await _httpClient.SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PutAuthenticatedAsync(string url, object body, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req);
        return await _httpClient.SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> PatchAuthenticatedAsync(string url, object body, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Patch, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        AddAuthHeaders(req);
        return await _httpClient.SendAsync(req, ct);
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
        return await _httpClient.SendAsync(req, ct);
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
        return await _httpClient.SendAsync(req, ct);
    }

    public async Task<HttpResponseMessage> GetAuthenticatedWithDiagnosticsAsync(
        string url, ILogger diagLogger, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        AddAuthHeaders(req);
        diagLogger.LogDebug("GET {Url}", url);
        return await _httpClient.SendAsync(req, ct);
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

    private void AddCommonHeaders(HttpRequestMessage req, string referer = "https://www.migros.ch/")
    {
        req.Headers.TryAddWithoutValidation("Referer", referer);
        req.Headers.TryAddWithoutValidation("x-correlation-id", Guid.NewGuid().ToString());
    }

    private void AddAuthHeaders(HttpRequestMessage req, string referer = "https://www.migros.ch/")
    {
        req.Headers.TryAddWithoutValidation("Authorization", _bearerTokenService.GetToken());
        AddCommonHeaders(req, referer);
    }

    public void Dispose() => _httpClient.Dispose();
}

public class MigrosSessionExpiredException()
    : InvalidOperationException(
        "Migros session expired — the browser window needs to be open and logged in to refresh the token automatically.");
