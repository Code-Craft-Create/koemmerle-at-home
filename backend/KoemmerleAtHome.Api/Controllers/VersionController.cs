using System.Reflection;
using Microsoft.AspNetCore.Mvc;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/version")]
public class VersionController : ControllerBase
{
    [HttpGet]
    public IActionResult Get()
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

        return Ok(new VersionResponse(version, commit, displayVersion, informationalVersion));
    }

    public record VersionResponse(
        string Version,
        string Commit,
        string DisplayVersion,
        string InformationalVersion);
}
