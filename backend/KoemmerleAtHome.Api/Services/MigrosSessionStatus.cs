namespace KoemmerleAtHome.Api.Services;

public record MigrosSessionStatus(bool IsLoggedIn, DateTime? ExpiresAt, int? ExpiresInSec);
