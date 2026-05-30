using System.Text.Json;
using System.Text.Json.Serialization;

namespace KoemmerleAtHome.Api.Services;

// ── MGB Product (GET /product-display/public/v1/products/mgb/{migrosId}) ─────
// This is the primary product API — returns uid (shopping-list ID), GTIN, price,
// weight, breadcrumb, and images in one call. Replaces Migipedia scraping entirely.

public record MgbProductResponse(
    [property: JsonPropertyName("uid")] long Uid,
    [property: JsonPropertyName("migrosId")] string? MigrosId,
    [property: JsonPropertyName("migrosOnlineId")] string? MigrosOnlineId,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("brand")] string? Brand,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("gtins")] List<string>? Gtins,
    [property: JsonPropertyName("images")] List<MgbImage>? Images,
    [property: JsonPropertyName("imageTransparent")] MgbImage? ImageTransparent,
    [property: JsonPropertyName("breadcrumb")] List<MgbBreadcrumb>? Breadcrumb,
    [property: JsonPropertyName("offer")] MgbOffer? Offer
)
{
    public string EffectiveName => Title ?? (Brand is not null ? $"{Brand} · {Name}" : Name ?? MigrosId ?? "");
    public string? EffectiveImageUrl => MigrosImageUrl.Resolve(ImageTransparent?.Url ?? Images?.FirstOrDefault()?.Url);
}

public record MgbImage(
    [property: JsonPropertyName("cdn")] string? Cdn,
    [property: JsonPropertyName("url")] string? Url
);

public record MgbBreadcrumb(
    [property: JsonPropertyName("id")] string? Id,
    [property: JsonPropertyName("name")] string? Name
);

public record MgbOffer(
    [property: JsonPropertyName("price")] MgbPrice? Price,
    [property: JsonPropertyName("promotionPrice")] ProductCardOfferPrice? PromotionPrice,
    [property: JsonPropertyName("quantity")] string? Quantity,
    [property: JsonPropertyName("hints")] List<MgbHint>? Hints,
    [property: JsonPropertyName("badges")] List<ProductCardBadge>? Badges
);

public record MgbHint(
    [property: JsonPropertyName("type")] string? Type
);

public record MgbPrice(
    [property: JsonPropertyName("effectiveValue")] decimal? EffectiveValue,
    [property: JsonPropertyName("advertisedValue")] decimal? AdvertisedValue,
    [property: JsonPropertyName("multiplier")] int? Multiplier
)
{
    public decimal? Value => EffectiveValue ?? AdvertisedValue;
}

// ── Shopping List (PUT /shopping-list/public/v3/items) ────────────────────────

public record ShoppingListPutRequest(
    [property: JsonPropertyName("shoppingListId")] long ShoppingListId,
    [property: JsonPropertyName("items")] List<ShoppingListItem> Items
);

public record ShoppingListItem(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("quantity")] int Quantity,
    [property: JsonPropertyName("type")] string Type = "PRODUCT"
);

public record ShoppingListResponse(
    [property: JsonPropertyName("id")] long? Id,
    [property: JsonPropertyName("shoppingListId")] long? ShoppingListId
)
{
    public long? EffectiveId => Id ?? ShoppingListId;
}


// ── Product Search (POST /onesearch-oc-seaapi/public/v5/search) ──────────────

public record OnesearchRequest(
    [property: JsonPropertyName("query")] string Query,
    [property: JsonPropertyName("regionId")] string RegionId = "1",
    [property: JsonPropertyName("language")] string Language = "de",
    [property: JsonPropertyName("from")] int From = 0,
    [property: JsonPropertyName("limit")] int Limit = 100,
    [property: JsonPropertyName("algorithm")] string Algorithm = "DEFAULT"
)
{
    [JsonPropertyName("productIds")]
    public List<long> ProductIds { get; init; } = [];

    [JsonPropertyName("sortFields")]
    public List<string> SortFields { get; init; } = [];

    [JsonPropertyName("sortOrder")]
    public string SortOrder { get; init; } = "asc";

    [JsonPropertyName("filters")]
    public Dictionary<string, string> Filters { get; init; } = new();

    [JsonPropertyName("myProductsOverride")]
    public List<string> MyProductsOverride { get; init; } = [];
}

public record OnesearchResponse(
    [property: JsonPropertyName("productIds")] List<long>? ProductIds,
    [property: JsonPropertyName("numberOfProducts")] int NumberOfProducts
);

// ── Product Cards (POST /product-display/public/v4/product-cards) ─────────────

public record ProductCardsOfferFilter(
    [property: JsonPropertyName("storeType")] string StoreType = "ONLINE",
    [property: JsonPropertyName("warehouseId")] int WarehouseId = 1,
    [property: JsonPropertyName("ongoingOfferDate")] string? OngoingOfferDate = null
);

public record ProductCardsProductFilter(
    [property: JsonPropertyName("uids")] List<long> Uids
);

public record ProductCardsRequest(
    [property: JsonPropertyName("offerFilter")] ProductCardsOfferFilter OfferFilter,
    [property: JsonPropertyName("productFilter")] ProductCardsProductFilter ProductFilter
)
{
    [JsonPropertyName("cumulusCoupons")]
    public List<string> CumulusCoupons { get; init; } = [];
}

public record ProductCardImage(
    [property: JsonPropertyName("url")] string? Url
);

public record ProductCardOfferPrice(
    [property: JsonPropertyName("effectiveValue")] decimal? EffectiveValue,
    [property: JsonPropertyName("advertisedValue")] decimal? AdvertisedValue,
    [property: JsonPropertyName("multiplier")] int? Multiplier
)
{
    public decimal? Value => EffectiveValue ?? AdvertisedValue;
}

public record ProductCardBadge(
    [property: JsonPropertyName("type")] string? Type,
    [property: JsonPropertyName("description")] string? Description,
    [property: JsonPropertyName("enrichedDescription")] string? EnrichedDescription,
    [property: JsonPropertyName("rawDescription")] string? RawDescription
)
{
    public string? EffectiveDescription => Description ?? EnrichedDescription ?? RawDescription;
    public bool IsPromotionBadge
    {
        get
        {
            if (string.IsNullOrWhiteSpace(Type)) return false;
            if (Type.Contains("PARTNER", StringComparison.OrdinalIgnoreCase)) return false;
            return Type.Equals("PERCENTAGE_PROMOTION", StringComparison.OrdinalIgnoreCase)
                || Type.Equals("PRICE_PROMOTION", StringComparison.OrdinalIgnoreCase)
                || Type.Equals("AMOUNT_PROMOTION", StringComparison.OrdinalIgnoreCase)
                || Type.Equals("MULTIBUY_PROMOTION", StringComparison.OrdinalIgnoreCase)
                || Type.Equals("PROMOTION", StringComparison.OrdinalIgnoreCase)
                || Type.EndsWith("_PROMOTION", StringComparison.OrdinalIgnoreCase);
        }
    }
}

public record ProductCardOffer(
    [property: JsonPropertyName("price")] ProductCardOfferPrice? Price,
    [property: JsonPropertyName("promotionPrice")] ProductCardOfferPrice? PromotionPrice,
    [property: JsonPropertyName("quantity")] string? Quantity,
    [property: JsonPropertyName("badges")] List<ProductCardBadge>? Badges
);

public record ProductCardResponse(
    [property: JsonPropertyName("uid")] long? Uid,
    [property: JsonPropertyName("migrosId")] string? MigrosId,
    [property: JsonPropertyName("migrosOnlineId")] string? MigrosOnlineId,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("brand")] string? Brand,
    [property: JsonPropertyName("versioning")] string? Versioning,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("gtins")] List<string>? Gtins,
    [property: JsonPropertyName("images")] List<ProductCardImage>? Images,
    [property: JsonPropertyName("imageTransparent")] ProductCardImage? ImageTransparent,
    [property: JsonPropertyName("breadcrumb")] List<MgbBreadcrumb>? Breadcrumb,
    [property: JsonPropertyName("productUrls")] string? ProductUrls,
    [property: JsonPropertyName("offer")] ProductCardOffer? Offer
)
{
    public string? EffectiveName => Title ?? (Brand is not null ? $"{Brand} · {Name} · {Versioning}".TrimEnd(' ', '·', ' ') : Name);
    public string? EffectiveImageUrl => MigrosImageUrl.Resolve(ImageTransparent?.Url ?? Images?
        .Select(i => i.Url)
        .FirstOrDefault(u => !string.IsNullOrEmpty(u))
    );
    public decimal? EffectivePrice => Offer?.Price?.Value;
    public decimal? EffectivePromotionPrice => Offer?.PromotionPrice?.Value;
    public string? EffectivePromotionBadge => Offer?.Badges?
        .Where(b => b.IsPromotionBadge)
        .Select(b => b.EffectiveDescription)
        .FirstOrDefault(d => !string.IsNullOrWhiteSpace(d));
    public string? EffectiveWeightText => Offer?.Quantity;
    public int EffectiveMultiplier => Math.Max(Offer?.Price?.Multiplier ?? 1, 1);
    public long? EffectiveMigrosOnlineId => long.TryParse(MigrosOnlineId, out var id) ? id : null;
};

// ── Promotions (POST /product-display/public/web/v3/products/promotion/search) ─

public record PromotionSearchRequest(
    [property: JsonPropertyName("storeType")] string StoreType = "ONLINE",
    [property: JsonPropertyName("period")] string Period = "CURRENT",
    [property: JsonPropertyName("language")] string Language = "de",
    [property: JsonPropertyName("filters")] Dictionary<string, string>? Filters = null,
    [property: JsonPropertyName("sortFields")] List<string>? SortFields = null,
    [property: JsonPropertyName("sortOrder")] string SortOrder = "asc",
    [property: JsonPropertyName("from")] int From = 0,
    [property: JsonPropertyName("until")] int Until = 100,
    [property: JsonPropertyName("region")] string Region = "gmaa",
    [property: JsonPropertyName("warehouse")] string Warehouse = "1",
    [property: JsonPropertyName("enabledSponsoredProducts")] bool EnabledSponsoredProducts = true
)
{
    public Dictionary<string, string> EffectiveFilters => Filters ?? [];
    public List<string> EffectiveSortFields => SortFields ?? ["categoryLevel"];
}

public record PromotionSearchResponse(
    [property: JsonPropertyName("items")] List<PromotionSearchItem>? Items,
    [property: JsonPropertyName("numberOfItems")] int NumberOfItems,
    [property: JsonPropertyName("startDate")] DateTime? StartDate,
    [property: JsonPropertyName("endDate")] DateTime? EndDate
);

public record PromotionSearchItem(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("type")] string? Type
);

internal static class MigrosImageUrl
{
    // Captured from migros.ch product detail page for Cloudinary MO product images.
    private const string CloudinaryProductStack =
        "w_960,h_720,c_pad,g_center,fl_lossy,b_rgb:fff/f_auto/e_unsharp_mask:100/q_auto";

    public static string? Resolve(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        if (!url.Contains("{stack}", StringComparison.Ordinal)) return url;

        var stack = url.Contains("cloudinary.com/image/upload/", StringComparison.OrdinalIgnoreCase)
            ? CloudinaryProductStack
            : "original";

        return url.Replace("{stack}", stack, StringComparison.Ordinal);
    }
}

// ── Product Detail (GET /product-display/public/v2/product-detail) ────────────

public record ProductDetailResponse(
    [property: JsonPropertyName("uid")] string? Uid,
    [property: JsonPropertyName("id")] string? Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("imageUrl")] string? ImageUrl,
    [property: JsonPropertyName("images")] List<ProductDetailImage>? Images,
    [property: JsonPropertyName("price")] ProductDetailPrice? Price,
    [property: JsonPropertyName("weightText")] string? WeightText,
    [property: JsonPropertyName("packageSize")] string? PackageSize,
    [property: JsonPropertyName("gtins")] List<string>? Gtins,
    [property: JsonPropertyName("eans")] List<string>? Eans,
    [property: JsonPropertyName("breadcrumbs")] List<ProductDetailBreadcrumb>? Breadcrumbs,
    [property: JsonPropertyName("categories")] List<ProductDetailCategory>? Categories
)
{
    public string? EffectiveUid => Uid ?? Id;
    public string? EffectiveName => Name ?? Title;
    public string? EffectiveImageUrl => ImageUrl ?? Images?.FirstOrDefault()?.Url;
    public string? EffectiveWeightText => WeightText ?? PackageSize;
    public List<string>? EffectiveGtins => Gtins ?? Eans;
}

public record ProductDetailImage(
    [property: JsonPropertyName("url")] string? Url
);

public record ProductDetailPrice(
    [property: JsonPropertyName("value")] decimal? Value,
    [property: JsonPropertyName("formattedValue")] string? FormattedValue,
    [property: JsonPropertyName("effectiveAmount")] decimal? EffectiveAmount
)
{
    public decimal? EffectiveValue => Value ?? EffectiveAmount;
}

public record ProductDetailBreadcrumb(
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("label")] string? Label
)
{
    public string? EffectiveName => Name ?? Label;
}

public record ProductDetailCategory(
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("slug")] string? Slug
);

// ── Receipt List (GET account.migros.ch/ma/api/user/receipt) ─────────────────

public record ReceiptListItem(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("date")] DateTime? Date,
    [property: JsonPropertyName("outlet")] string? Outlet,
    [property: JsonPropertyName("total")] ReceiptAmount? Total,
    [property: JsonPropertyName("links")] ReceiptLinks? Links
);

public record ReceiptAmount(
    [property: JsonPropertyName("value")] decimal Value,
    [property: JsonPropertyName("currency")] string? Currency
);

public record ReceiptLinks(
    [property: JsonPropertyName("html")] string? Html,
    [property: JsonPropertyName("pdf")] string? Pdf
);

// ── Online Orders (GET ordergateway/public/web/v1/customers/customer-orders) ───

public record CustomerOrderListResponse(
    [property: JsonPropertyName("size")] int Size,
    [property: JsonPropertyName("orders")] List<CustomerOrder> Orders
);

public record CustomerOrder(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("orderNumber")] string? OrderNumber,
    [property: JsonPropertyName("deliveryStartDate")] DateTime? DeliveryStartDate,
    [property: JsonPropertyName("grandTotal")] decimal? GrandTotal
);

public record CustomerOrderDetailResponse(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("details")] CustomerOrderDetails? Details
);

public record CustomerOrderDetails(
    [property: JsonPropertyName("positions")] List<CustomerOrderPosition>? Positions
);

public record CustomerOrderPosition(
    [property: JsonPropertyName("productId")] long? ProductId,
    [property: JsonPropertyName("migrosId")] string? MigrosId,
    [property: JsonPropertyName("uniqueId")] long? UniqueId,
    [property: JsonPropertyName("productName")] string? ProductName,
    [property: JsonPropertyName("brand")] string? Brand,
    [property: JsonPropertyName("versioning")] string? Versioning,
    [property: JsonPropertyName("deliveredQuantity")] int DeliveredQuantity,
    [property: JsonPropertyName("adjustedPrice")] decimal? AdjustedPrice,
    [property: JsonPropertyName("weightedQuotedPrice")] decimal? WeightedQuotedPrice,
    [property: JsonPropertyName("estimatedRegularOfferPrice")] decimal? EstimatedRegularOfferPrice,
    [property: JsonPropertyName("categoryName")] string? CategoryName,
    [property: JsonPropertyName("productImage")] MgbImage? ProductImage
)
{
    public string EffectiveName
    {
        get
        {
            var parts = new[] { Brand, ProductName, Versioning }.Where(p => !string.IsNullOrWhiteSpace(p));
            return string.Join(" ", parts);
        }
    }
}

// ── Cart (endpoints to be discovered via route interception) ─────────────────

public record CartAddRequest(
    [property: JsonPropertyName("productId")] string ProductId,
    [property: JsonPropertyName("quantity")] int Quantity
);

public record CartUpdateRequest(
    [property: JsonPropertyName("quantity")] int Quantity
);
