using Microsoft.EntityFrameworkCore;
using KoemmerleAtHome.Api.Models;

namespace KoemmerleAtHome.Api.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
    public DbSet<ProductMapping> ProductMappings => Set<ProductMapping>();
    public DbSet<ProductMappingItem> ProductMappingItems => Set<ProductMappingItem>();
    public DbSet<ScanQueueItem> ScanQueueItems => Set<ScanQueueItem>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderItem> OrderItems => Set<OrderItem>();
    public DbSet<AppSetting> AppSettings => Set<AppSetting>();
    public DbSet<StickerExport> StickerExports => Set<StickerExport>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Product>()
            .HasIndex(p => p.MigrosId).IsUnique()
            .HasFilter("\"MigrosId\" IS NOT NULL");
        modelBuilder.Entity<Product>()
            .HasIndex(p => p.MigrosOnlineId).IsUnique()
            .HasFilter("\"MigrosOnlineId\" IS NOT NULL");
        modelBuilder.Entity<Product>()
            .HasIndex(p => p.MigrosUid).IsUnique()
            .HasFilter("\"MigrosUid\" IS NOT NULL");

        modelBuilder.Entity<ProductMapping>()
            .HasIndex(m => m.Barcode);

        modelBuilder.Entity<ProductMappingItem>()
            .HasOne(i => i.Mapping)
            .WithMany(m => m.Items)
            .HasForeignKey(i => i.MappingId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<ProductMappingItem>()
            .HasOne(i => i.Product)
            .WithMany()
            .HasForeignKey(i => i.ProductId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<Order>()
            .Property(o => o.Status).HasConversion<string>();

        modelBuilder.Entity<OrderItem>()
            .HasOne(i => i.Order)
            .WithMany(o => o.Items)
            .HasForeignKey(i => i.OrderId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<OrderItem>()
            .HasOne(i => i.Product)
            .WithMany()
            .HasForeignKey(i => i.ProductId)
            .OnDelete(DeleteBehavior.SetNull);

        modelBuilder.Entity<ScanQueueItem>()
            .Property(s => s.Status).HasConversion<string>();

        modelBuilder.Entity<AppSetting>()
            .HasKey(s => s.Key);
    }
}
