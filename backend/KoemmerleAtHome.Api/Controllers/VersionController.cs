using System.Reflection;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/version")]
public partial class VersionController : ControllerBase
{
    private const string Owner = "Code-Craft-Create";
    private const string Repo = "koemmerle-at-home";
    private static readonly TimeSpan ReleaseCacheDuration = TimeSpan.FromMinutes(30);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IMemoryCache _cache;
    private readonly ILogger<VersionController> _logger;

    public VersionController(
        IHttpClientFactory httpClientFactory,
        IMemoryCache cache,
        ILogger<VersionController> logger)
    {
        _httpClientFactory = httpClientFactory;
        _cache = cache;
        _logger = logger;
    }

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var assembly = Assembly.GetEntryAssembly() ?? typeof(VersionController).Assembly;
        var informationalVersion = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion
            ?? "0.0.0";

        var parts = informationalVersion.Split('+', 2);
        var version = parts[0];
        var commit = parts.Length > 1
            ? new string(parts[1].Where(char.IsLetterOrDigit).Take(6).ToArray())
            : "";
        var displayVersion = string.IsNullOrWhiteSpace(commit)
            ? version
            : $"{version} {commit}";

        var latestRelease = await GetLatestRelease(version, cancellationToken);

        return Ok(new VersionResponse(version, commit, displayVersion, informationalVersion, latestRelease));
    }

    private async Task<LatestReleaseResponse?> GetLatestRelease(string currentVersion, CancellationToken cancellationToken)
    {
        try
        {
            var release = await _cache.GetOrCreateAsync("github-latest-release", async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = ReleaseCacheDuration;

                var client = _httpClientFactory.CreateClient("GitHubReleases");
                var response = await client.GetFromJsonAsync<GitHubReleaseResponse>(
                    $"repos/{Owner}/{Repo}/releases/latest",
                    cancellationToken);

                return response;
            });

            if (release is null || string.IsNullOrWhiteSpace(release.TagName) || string.IsNullOrWhiteSpace(release.HtmlUrl))
                return null;

            var latestVersion = NormalizeVersion(release.TagName);
            if (!IsNewerVersion(latestVersion, currentVersion))
                return null;

            return new LatestReleaseResponse(
                latestVersion,
                release.TagName,
                string.IsNullOrWhiteSpace(release.Name) ? release.TagName : release.Name,
                release.HtmlUrl,
                release.PublishedAt);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not check GitHub latest release.");
            return null;
        }
    }

    private static string NormalizeVersion(string version)
    {
        return version.Trim().TrimStart('v', 'V');
    }

    private static bool IsNewerVersion(string candidate, string current)
    {
        var candidateSemVer = SemVer.Parse(candidate);
        var currentSemVer = SemVer.Parse(current);

        if (candidateSemVer is null || currentSemVer is null)
            return !string.Equals(NormalizeVersion(candidate), NormalizeVersion(current), StringComparison.OrdinalIgnoreCase);

        return candidateSemVer.CompareTo(currentSemVer) > 0;
    }

    public record VersionResponse(
        string Version,
        string Commit,
        string DisplayVersion,
        string InformationalVersion,
        LatestReleaseResponse? LatestRelease);

    public record LatestReleaseResponse(
        string Version,
        string TagName,
        string Name,
        string HtmlUrl,
        DateTimeOffset? PublishedAt);

    private sealed record GitHubReleaseResponse(
        [property: JsonPropertyName("tag_name")] string TagName,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("html_url")] string HtmlUrl,
        [property: JsonPropertyName("published_at")] DateTimeOffset? PublishedAt);

    private sealed record SemVer(int Major, int Minor, int Patch, string? PreRelease) : IComparable<SemVer>
    {
        public static SemVer? Parse(string version)
        {
            var normalized = NormalizeVersion(version);
            var buildSeparator = normalized.IndexOf('+');
            if (buildSeparator >= 0)
                normalized = normalized[..buildSeparator];

            string? preRelease = null;
            var preReleaseSeparator = normalized.IndexOf('-');
            if (preReleaseSeparator >= 0)
            {
                preRelease = normalized[(preReleaseSeparator + 1)..];
                normalized = normalized[..preReleaseSeparator];
            }

            var parts = normalized.Split('.');
            if (parts.Length < 3)
                return null;

            return int.TryParse(parts[0], out var major)
                && int.TryParse(parts[1], out var minor)
                && int.TryParse(parts[2], out var patch)
                    ? new SemVer(major, minor, patch, preRelease)
                    : null;
        }

        public int CompareTo(SemVer? other)
        {
            if (other is null) return 1;

            var core = Major.CompareTo(other.Major);
            if (core != 0) return core;
            core = Minor.CompareTo(other.Minor);
            if (core != 0) return core;
            core = Patch.CompareTo(other.Patch);
            if (core != 0) return core;

            if (string.IsNullOrWhiteSpace(PreRelease) && string.IsNullOrWhiteSpace(other.PreRelease)) return 0;
            if (string.IsNullOrWhiteSpace(PreRelease)) return 1;
            if (string.IsNullOrWhiteSpace(other.PreRelease)) return -1;

            return string.Compare(PreRelease, other.PreRelease, StringComparison.OrdinalIgnoreCase);
        }
    }
}
