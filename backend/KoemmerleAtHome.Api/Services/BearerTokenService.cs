using System.IdentityModel.Tokens.Jwt;
using System.Text.Json;

namespace KoemmerleAtHome.Api.Services;

public class BearerTokenService : IDisposable
{
    private static string TokenFile =>
        Path.Combine(AppContext.BaseDirectory, "migros-session", "bearer-token.json");

    private readonly ILogger<BearerTokenService> _logger;
    private string? _token;
    private DateTime _expiresAt;

    public bool IsAvailable => _token is not null && DateTime.UtcNow < _expiresAt;
    public DateTime? ExpiresAt => _token is null ? null : _expiresAt;

    public BearerTokenService(ILogger<BearerTokenService> logger)
    {
        _logger = logger;
        LoadPersisted();
    }

    public string GetToken()
    {
        if (_token is null) throw new InvalidOperationException("Bearer token not yet available — waiting for first Playwright navigation");
        if (DateTime.UtcNow >= _expiresAt) throw new InvalidOperationException("Bearer token has expired — trigger a browser navigation to refresh");
        return _token;
    }

    public void SetToken(string bearerToken)
    {
        _token = bearerToken;
        _expiresAt = ParseExpiry(bearerToken);
        Persist();
        _logger.LogInformation("Bearer token captured (expires {ExpiresAt:u})", _expiresAt);
    }

    private static DateTime ParseExpiry(string bearerToken)
    {
        var jwt = bearerToken.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? bearerToken["Bearer ".Length..]
            : bearerToken;
        try
        {
            var token = new JwtSecurityTokenHandler().ReadJwtToken(jwt);
            return token.ValidTo == DateTime.MinValue
                ? DateTime.UtcNow.AddMinutes(29)
                : token.ValidTo;
        }
        catch
        {
            return DateTime.UtcNow.AddMinutes(29);
        }
    }

    private void LoadPersisted()
    {
        try
        {
            if (!File.Exists(TokenFile)) return;
            var data = JsonSerializer.Deserialize<PersistedToken>(File.ReadAllText(TokenFile));
            if (data is null) return;
            _token = data.Token;
            _expiresAt = data.ExpiresAt;
            if (IsAvailable)
                _logger.LogInformation("Loaded persisted bearer token (expires {ExpiresAt:u})", _expiresAt);
            else
                _logger.LogWarning("Persisted bearer token is expired — will refresh on next browser navigation");
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Could not load persisted bearer token: {Error}", ex.Message);
        }
    }

    private void Persist()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(TokenFile)!);
            File.WriteAllText(TokenFile, JsonSerializer.Serialize(new PersistedToken(_token!, _expiresAt)));
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Could not persist bearer token: {Error}", ex.Message);
        }
    }

    public void Dispose() { }

    private record PersistedToken(string Token, DateTime ExpiresAt);
}
