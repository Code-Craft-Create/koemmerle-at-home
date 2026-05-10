using Microsoft.AspNetCore.Mvc;
using KoemmerleAtHome.Api.Services;

namespace KoemmerleAtHome.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class CartController(ScanQueueService queueService, MigrosCartService cartService) : ControllerBase
{
    [HttpGet("queue")]
    public async Task<IActionResult> GetQueue() =>
        Ok(await queueService.GetQueueAsync());

    [HttpGet("status")]
    public IActionResult GetStatus() =>
        Ok(new CartStatus(cartService.IsPaused, cartService.IsLoggedIn));

    [HttpGet("basket")]
    public async Task<IActionResult> GetBasket(CancellationToken ct) =>
        Ok(await cartService.GetBasketAsync(ct));

    [HttpPut("basket/quantity")]
    public async Task<IActionResult> SetBasketQuantity([FromBody] SetBasketQuantityRequest req, CancellationToken ct)
    {
        await cartService.SetItemQuantityAsync(req.Uid, req.Quantity, ct);
        return Ok();
    }

    [HttpGet("quantity")]
    public async Task<IActionResult> GetCartQuantity(
        [FromQuery] string barcode,
        [FromQuery] string? migrosId,
        CancellationToken ct)
    {
        var qty = await cartService.GetCartQuantityAsync(barcode, migrosId, ct);
        return Ok(new { currentQuantity = qty ?? 0 });
    }

    [HttpPost("pause")]
    public IActionResult Pause()
    {
        cartService.Pause();
        return Ok();
    }

    [HttpPost("resume")]
    public IActionResult Resume()
    {
        cartService.Resume();
        return Ok();
    }

    [HttpDelete("queue/{id:int}")]
    public async Task<IActionResult> DeleteQueueItem(int id)
    {
        await queueService.DeleteAsync(id);
        return NoContent();
    }

    [HttpDelete("queue/completed")]
    public async Task<IActionResult> DeleteCompleted()
    {
        await queueService.DeleteCompletedAsync();
        return NoContent();
    }

    [HttpDelete("queue/all")]
    public async Task<IActionResult> DeleteAll()
    {
        await queueService.DeleteAllAsync();
        return NoContent();
    }

    [HttpPost("queue/{id:int}/retry")]
    public async Task<IActionResult> RetryQueueItem(int id)
    {
        await queueService.RequeueFailedAsync(id);
        return Ok();
    }
}

public record CartStatus(bool IsPaused, bool IsLoggedIn);
public record SetBasketQuantityRequest(string Uid, int Quantity);
