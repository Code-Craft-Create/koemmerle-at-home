using Microsoft.AspNetCore.Mvc;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController(BearerTokenService bearerTokenService, PlaywrightLoginService loginService) : ControllerBase
{
    [HttpGet("migros-session")]
    public IActionResult GetSession() => Ok(new
    {
        isLoggedIn   = bearerTokenService.IsAvailable,
        expiresAt    = bearerTokenService.ExpiresAt,
        expiresInSec = bearerTokenService.ExpiresAt.HasValue
            ? (int)(bearerTokenService.ExpiresAt.Value - DateTime.UtcNow).TotalSeconds
            : (int?)null,
    });

    [HttpPost("migros-login")]
    public async Task<IActionResult> StartLogin()
    {
        await loginService.StartLoginAsync();
        return Ok(new { message = "Browser navigated to migros.ch — log in and the token will be captured automatically." });
    }

    [HttpPost("migros-token")]
    public IActionResult SetToken([FromBody] SetTokenRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.AccessToken))
            return BadRequest("accessToken is required");

        bearerTokenService.SetToken(req.AccessToken);
        return Ok(new { expiresAt = bearerTokenService.ExpiresAt });
    }

    public record SetTokenRequest(string AccessToken);
}
