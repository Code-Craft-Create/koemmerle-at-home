using Microsoft.AspNetCore.Mvc;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController(
    BearerTokenService bearerTokenService,
    PlaywrightLoginService loginService,
    ILogger<AuthController> logger) : ControllerBase
{
    [HttpGet("migros-session")]
    public IActionResult GetSession() => Ok(bearerTokenService.Status);

    [HttpPost("migros-login")]
    public async Task<IActionResult> StartLogin()
    {
        logger.LogInformation("Migros login start requested");
        await loginService.StartLoginAsync();
        logger.LogInformation("Migros login start request acknowledged");
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
