using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using SixLabors.ImageSharp.Formats.Jpeg;

namespace KoemmerleAtHome.Api.Services;

public class ImageThumbnailService(ILogger<ImageThumbnailService> logger)
{
    private static readonly HttpClient Http = new();
    private const int MaxDimension = 128;
    private const int JpegQuality = 80;

    /// <summary>
    /// Downloads an image from <paramref name="imageUrl"/>, resizes it to at most 128×128,
    /// and returns a base64-encoded JPEG data URL. Returns null on any failure.
    /// </summary>
    public async Task<string?> FetchThumbnailAsync(string imageUrl, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            logger.LogDebug("Fetching thumbnail image from {Url}", imageUrl);
            var bytes = await Http.GetByteArrayAsync(imageUrl, ct);
            logger.LogDebug("Fetched {Bytes} bytes for thumbnail from {Url}", bytes.Length, imageUrl);
            using var source = Image.Load<Rgba32>(bytes);
            source.Mutate(x => x.Resize(new ResizeOptions
            {
                Size = new Size(MaxDimension, MaxDimension),
                Mode = ResizeMode.Max
            }));
            // Composite onto white so transparent areas don't become black in JPEG
            using var canvas = new Image<Rgba32>(source.Width, source.Height, Color.White);
            canvas.Mutate(x => x.DrawImage(source, opacity: 1f));
            using var ms = new MemoryStream();
            await canvas.SaveAsJpegAsync(ms, new JpegEncoder { Quality = JpegQuality }, ct);
            return "data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray());
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Thumbnail fetch failed for {Url}: {Message}", imageUrl, ex.Message);
            return null;
        }
    }
}
