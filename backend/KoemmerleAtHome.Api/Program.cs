using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Data;
using KoemmerleAtHome.Api.Hubs;
using KoemmerleAtHome.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers()
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
        o.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
    });
builder.Services.AddOpenApi();
builder.Services.AddSignalR()
    .AddJsonProtocol(options =>
        options.PayloadSerializerOptions.Converters.Add(
            new System.Text.Json.Serialization.JsonStringEnumConverter()));

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("Default") ?? "Data Source=koemmerleathome.db"));

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
builder.Services.AddSingleton<MigrosCartService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MigrosCartService>());

builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins("http://localhost:4200")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials()));

var app = builder.Build();

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

app.UseRouting();
app.UseCors();
app.UseAuthorization();
app.MapControllers();
app.MapHub<ScanHub>("/hubs/scan");


app.Run();
