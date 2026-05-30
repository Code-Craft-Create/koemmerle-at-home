using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Microsoft.Data.Sqlite;
using KoemmerleAtHome.Api;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Hubs;
using KoemmerleAtHome.Api.Services;

RepairPlaywrightExecutablePermissions();

if (args.Contains("--install-playwright", StringComparer.OrdinalIgnoreCase))
{
    Microsoft.Playwright.Program.Main(["install", "chromium"]);
    return;
}

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(options =>
{
    options.TimestampFormat = "yyyy-MM-dd HH:mm:ss.fff zzz ";
});

builder.Services.AddSingleton<LocalAppData>();

builder.Services.AddControllers()
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
        o.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
    });
builder.Services.AddOpenApi();
builder.Services.AddMemoryCache();
builder.Services.AddHttpClient("GitHubReleases", client =>
{
    client.BaseAddress = new Uri("https://api.github.com/");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("koemmerle-at-home");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
});
builder.Services.AddSignalR()
    .AddJsonProtocol(options =>
        options.PayloadSerializerOptions.Converters.Add(
            new System.Text.Json.Serialization.JsonStringEnumConverter()));

builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    var configuredConnectionString = builder.Configuration.GetConnectionString("Default");
    if (!string.IsNullOrWhiteSpace(configuredConnectionString))
    {
        options.UseSqlite(configuredConnectionString);
        return;
    }

    var appData = sp.GetRequiredService<LocalAppData>();
    var connectionString = new SqliteConnectionStringBuilder
    {
        DataSource = appData.DatabasePath
    }.ToString();
    options.UseSqlite(connectionString);
});

builder.Services.AddSingleton<ImageThumbnailService>();
builder.Services.AddSingleton<BearerTokenService>();
builder.Services.AddSingleton<ScanQueueService>();
builder.Services.AddSingleton<IScanNotifier, ScanHubNotifier>();

builder.Services.AddSingleton<PlaywrightLoginService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<PlaywrightLoginService>());

// API-based services (direct REST calls to Migros, no Playwright scraping)
builder.Services.AddSingleton<MigrosHttpSession>();
builder.Services.AddSingleton<MigrosProductSyncService>();
builder.Services.AddSingleton<MigrosOrderSyncService>();
builder.Services.AddSingleton<MigrosPromotionSyncService>();
builder.Services.AddSingleton<MigrosCartService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MigrosCartService>());

builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins("http://localhost:4200")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials()));

var app = builder.Build();

var appData = app.Services.GetRequiredService<LocalAppData>();
app.Logger.LogInformation("Local app data directory: {Directory}", appData.RootDirectory);
app.Logger.LogInformation("SQLite database path: {DatabasePath}", appData.DatabasePath);

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

    // Always run EnsureCreatedAsync FIRST — creates all tables on a fresh DB.
    // On existing DBs it's a no-op, and the manual SQL below handles migrations.
    await db.Database.EnsureCreatedAsync();

    // Safety net: if Orders table is still missing, the DB is in a broken state — reset it.
    var conn = db.Database.GetDbConnection();
    await conn.OpenAsync();
    bool ordersExists;
    {
        using var chk = conn.CreateCommand();
        chk.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='Orders'";
        ordersExists = (long)(chk.ExecuteScalar() ?? 0L) > 0;
    }
    if (!ordersExists)
    {
        await conn.CloseAsync();
        db.Database.EnsureDeleted();
        await db.Database.EnsureCreatedAsync();
        await conn.OpenAsync();
    }

    bool TableExists(string t)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{t}'";
        return (long)(cmd.ExecuteScalar() ?? 0L) > 0;
    }
    bool HasColumn(string t, string c)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM pragma_table_info('{t}') WHERE name='{c}'";
        return (long)(cmd.ExecuteScalar() ?? 0L) > 0;
    }
    void Exec(string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    // Add ImageData column to ProductMappings if missing
    if (TableExists("ProductMappings") && !HasColumn("ProductMappings", "ImageData"))
        Exec("""ALTER TABLE "ProductMappings" ADD COLUMN "ImageData" TEXT""");

    // Create AppSettings table if missing
    if (!TableExists("AppSettings"))
        Exec("""
            CREATE TABLE "AppSettings" (
                "Key"   TEXT NOT NULL PRIMARY KEY,
                "Value" TEXT
            )
            """);

    // Add product identity columns to Products if missing (existing installs)
    if (TableExists("Products") && !HasColumn("Products", "Categories"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "Categories" TEXT""");
    if (TableExists("Products") && !HasColumn("Products", "MigrosId"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "MigrosId" TEXT""");
    if (TableExists("Products") && !HasColumn("Products", "MigrosOnlineId"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "MigrosOnlineId" INTEGER""");
    if (TableExists("Products") && !HasColumn("Products", "MigrosUid"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "MigrosUid" INTEGER""");
    if (TableExists("Products") && !HasColumn("Products", "Multiplier"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "Multiplier" INTEGER NOT NULL DEFAULT 1""");
    if (TableExists("Products") && !HasColumn("Products", "WeightText"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "WeightText" TEXT""");
    if (TableExists("Products") && !HasColumn("Products", "WeightMinGrams"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "WeightMinGrams" TEXT""");
    if (TableExists("Products") && !HasColumn("Products", "WeightMaxGrams"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "WeightMaxGrams" TEXT""");
    if (TableExists("Products") && !HasColumn("Products", "WeightUnit"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "WeightUnit" TEXT""");

    // Add product identity columns to OrderItems if missing
    if (TableExists("OrderItems") && !HasColumn("OrderItems", "MigrosId"))
        Exec("""ALTER TABLE "OrderItems" ADD COLUMN "MigrosId" TEXT""");
    if (TableExists("OrderItems") && !HasColumn("OrderItems", "MigrosOnlineId"))
        Exec("""ALTER TABLE "OrderItems" ADD COLUMN "MigrosOnlineId" INTEGER""");
    if (TableExists("OrderItems") && !HasColumn("OrderItems", "MigrosUid"))
        Exec("""ALTER TABLE "OrderItems" ADD COLUMN "MigrosUid" INTEGER""");

    // Add identifier columns to ScanQueueItems if missing
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "MigrosId"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "MigrosId" TEXT""");
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "MigrosOnlineId"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "MigrosOnlineId" INTEGER""");
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "MigrosUid"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "MigrosUid" INTEGER""");
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "Multiplier"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "Multiplier" INTEGER NOT NULL DEFAULT 1""");

    // Add image/recipe columns to ScanQueueItems if missing
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "ProductImageUrl"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "ProductImageUrl" TEXT""");
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "RecipeName"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "RecipeName" TEXT""");
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "RecipeImageData"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "RecipeImageData" TEXT""");
    if (TableExists("ScanQueueItems") && !HasColumn("ScanQueueItems", "ProductImageData"))
        Exec("""ALTER TABLE "ScanQueueItems" ADD COLUMN "ProductImageData" TEXT""");

    // Add ImageData thumbnail column to Products if missing
    if (TableExists("Products") && !HasColumn("Products", "ImageData"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "ImageData" TEXT""");

    // Add AdditionalInfo JSON column to Products if missing
    if (TableExists("Products") && !HasColumn("Products", "AdditionalInfo"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "AdditionalInfo" TEXT""");

    // Add StickerPrintedAt column to Products if missing
    if (TableExists("Products") && !HasColumn("Products", "StickerPrintedAt"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "StickerPrintedAt" TEXT""");

    // Promotion sync stores Migros promotion-only products without showing them in "Meine Produkte"
    if (TableExists("Products") && !HasColumn("Products", "IsPromotionOnly"))
        Exec("""ALTER TABLE "Products" ADD COLUMN "IsPromotionOnly" INTEGER NOT NULL DEFAULT 0""");

    // Create StickerExports table if missing
    if (!TableExists("StickerExports"))
        Exec("""
            CREATE TABLE "StickerExports" (
                "Id"           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "ExportedAt"   TEXT NOT NULL,
                "LayoutJson"   TEXT NOT NULL DEFAULT '',
                "ProductsJson" TEXT NOT NULL DEFAULT ''
            )
            """);

    // Current Migros promotions. This table is cleared before every promotion sync.
    if (!TableExists("ProductPromotions"))
    {
        Exec("""
            CREATE TABLE "ProductPromotions" (
                "Id"               INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "ProductId"        INTEGER NOT NULL REFERENCES "Products"("Id") ON DELETE CASCADE,
                "PromotionPrice"   TEXT NOT NULL,
                "BadgeDescription" TEXT,
                "StartDate"        TEXT,
                "EndDate"          TEXT,
                "SyncedAt"         TEXT NOT NULL
            )
            """);
        Exec("""CREATE UNIQUE INDEX "IX_ProductPromotions_ProductId" ON "ProductPromotions"("ProductId") """);
    }

    // Migrate ProductMappings from old 1:1 schema to new multi-item schema
    if (TableExists("ProductMappings") && HasColumn("ProductMappings", "ProductId"))
    {
        Exec("DROP TABLE IF EXISTS \"ProductMappings\"");
    }

    // Create new ProductMappings (Barcode + Name, no ProductId FK)
    if (!TableExists("ProductMappings"))
    {
        Exec("""
            CREATE TABLE "ProductMappings" (
                "Id"      INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "Barcode" TEXT NOT NULL DEFAULT '',
                "Name"    TEXT NOT NULL DEFAULT ''
            )
            """);
        Exec("""CREATE INDEX "IX_ProductMappings_Barcode" ON "ProductMappings"("Barcode") """);
    }

    // Create ProductMappingItems join table
    if (!TableExists("ProductMappingItems"))
    {
        Exec("""
            CREATE TABLE "ProductMappingItems" (
                "Id"        INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "MappingId" INTEGER NOT NULL REFERENCES "ProductMappings"("Id") ON DELETE CASCADE,
                "ProductId" INTEGER NOT NULL REFERENCES "Products"("Id") ON DELETE CASCADE,
                "Quantity"  INTEGER NOT NULL DEFAULT 1
            )
            """);
        Exec("""CREATE INDEX "IX_ProductMappingItems_MappingId" ON "ProductMappingItems"("MappingId") """);
        Exec("""CREATE INDEX "IX_ProductMappingItems_ProductId" ON "ProductMappingItems"("ProductId") """);
    }

    await conn.CloseAsync();

    // Backfill OrderDate from DateText for existing orders synced before the parser existed
    var ordersToBackfill = await db.Orders
        .Where(o => o.OrderDate == null && o.DateText != null)
        .ToListAsync();
    foreach (var o in ordersToBackfill)
        o.OrderDate = KoemmerleAtHome.Api.Services.MigrosParseHelpers.ParseGermanDate(o.DateText);
    if (ordersToBackfill.Count > 0)
        await db.SaveChangesAsync();
}

if (app.Environment.IsDevelopment())
    app.MapOpenApi();

var executableDirectory = Path.GetDirectoryName(Environment.ProcessPath);
var publishedWebRoot = Directory.Exists(Path.Combine(executableDirectory ?? "", "wwwroot"))
    ? Path.Combine(executableDirectory!, "wwwroot")
    : Path.Combine(AppContext.BaseDirectory, "wwwroot");
if (Directory.Exists(publishedWebRoot))
{
    var fileProvider = new PhysicalFileProvider(publishedWebRoot);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider });
    app.MapFallbackToFile("index.html", new StaticFileOptions { FileProvider = fileProvider });
}
else
{
    app.UseDefaultFiles();
    app.UseStaticFiles();
    app.MapFallbackToFile("index.html");
}

app.UseRouting();
app.UseCors();
app.UseAuthorization();
app.MapControllers();
app.MapHub<ScanHub>("/hubs/scan");

OpenBrowserWhenReady(app);

app.Run();

static void OpenBrowserWhenReady(WebApplication app)
{
    var configured = app.Configuration["OpenBrowserOnStart"];
    var shouldOpen = configured is null
        ? !app.Environment.IsDevelopment()
        : !string.Equals(configured, "false", StringComparison.OrdinalIgnoreCase);

    if (!shouldOpen)
        return;

    app.Lifetime.ApplicationStarted.Register(() =>
    {
        var url = GetBrowserUrl(app);
        var delay = GetOpenBrowserDelay(app);
        app.Logger.LogInformation("Opening frontend at {Url} after {DelayMs} ms", url, delay.TotalMilliseconds);
        _ = Task.Run(async () =>
        {
            if (delay > TimeSpan.Zero)
                await Task.Delay(delay);

            OpenDefaultBrowser(url);
        });
    });
}

static TimeSpan GetOpenBrowserDelay(WebApplication app)
{
    var configured = app.Configuration["OpenBrowserDelaySeconds"];
    if (double.TryParse(configured, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var seconds) &&
        seconds > 0)
    {
        return TimeSpan.FromSeconds(seconds);
    }

    return TimeSpan.Zero;
}

static string GetBrowserUrl(WebApplication app)
{
    var address = app.Services.GetRequiredService<IServer>()
        .Features
        .Get<IServerAddressesFeature>()?
        .Addresses
        .FirstOrDefault()
        ?? "http://localhost:5000";

    var uri = new Uri(address);
    var host = uri.Host is "0.0.0.0" or "::" or "*" or "+"
        ? "localhost"
        : uri.Host;

    return new UriBuilder(uri) { Host = host }.Uri.ToString().TrimEnd('/');
}

static void OpenDefaultBrowser(string url)
{
    try
    {
        if (OperatingSystem.IsMacOS())
        {
            Process.Start(new ProcessStartInfo("open", url) { UseShellExecute = false });
        }
        else if (OperatingSystem.IsWindows())
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        else if (OperatingSystem.IsLinux())
        {
            Process.Start(new ProcessStartInfo("xdg-open", url) { UseShellExecute = false });
        }
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Could not open browser at {url}: {ex.Message}");
    }
}

static void RepairPlaywrightExecutablePermissions()
{
    if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux())
        return;

    var playwrightNodeRoot = Path.Combine(AppContext.BaseDirectory, ".playwright", "node");
    if (!Directory.Exists(playwrightNodeRoot))
        return;

    foreach (var nodeExecutable in Directory.EnumerateFiles(playwrightNodeRoot, "node", SearchOption.AllDirectories))
    {
        try
        {
            File.SetUnixFileMode(nodeExecutable,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Could not set execute permission on Playwright helper '{nodeExecutable}': {ex.Message}");
        }
    }
}
