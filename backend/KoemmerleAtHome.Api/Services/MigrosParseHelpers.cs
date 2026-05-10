namespace KoemmerleAtHome.Api.Services;

internal static class MigrosParseHelpers
{
    internal static decimal? ParsePrice(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        text = System.Text.RegularExpressions.Regex.Replace(text, @"[^\d.,]", "").Trim();
        if (string.IsNullOrEmpty(text)) return null;
        text = text.TrimEnd('.').TrimEnd(',');
        if (string.IsNullOrEmpty(text)) return null;
        return ParseDecimal(text);
    }

    /// <summary>
    /// Parses weight strings from Migros product pages.
    /// Examples:
    ///   "2 × 285 g"  → (570, 570, "g")   — multi-pack
    ///   "6 × 1 l"    → (6000, 6000, "g") — multi-pack liquid (1 l = 1 kg)
    ///   "700–950 g"  → (700, 950, "g")   — range
    ///   "285 g"      → (285, 285, "g")   — single
    ///   "1.5 kg"     → (1500, 1500, "g") — kg → g
    ///   "1.5 l"      → (1500, 1500, "g") — litre → g (water-based)
    ///   "1 Stück"    → (null, null, "Stück")
    /// WeightText is always stored as the raw scraped string.
    /// </summary>
    internal static (decimal? min, decimal? max, string? unit) ParseWeight(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return (null, null, null);
        text = System.Text.RegularExpressions.Regex.Replace(text.Trim(), @"\s+", " ");

        // ── Multi-pack: "2 × 285 g", "2 x 285 g", "2 × 1.5 kg", "6 × 1 l" ───
        var multi = System.Text.RegularExpressions.Regex.Match(text,
            @"^([\d.,]+)\s*[×xX]\s*([\d.,]+)\s*(g|kg|l|dl|cl|ml)\.?$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (multi.Success)
        {
            var count   = ParseDecimal(multi.Groups[1].Value);
            var perUnit = ParseDecimal(multi.Groups[2].Value);
            var rawUnit = multi.Groups[3].Value.ToLowerInvariant();
            if (count.HasValue && perUnit.HasValue)
            {
                var mult = rawUnit switch
                {
                    "kg" => 1000m,
                    "l"  => 1000m,
                    "dl" => 100m,
                    "cl" => 10m,
                    "ml" => 1m,
                    _    => 1m
                };
                var total = count.Value * perUnit.Value * mult;
                return (total, total, "g");
            }
        }

        if (text.Contains("Stück", StringComparison.OrdinalIgnoreCase))
            return (null, null, "Stück");

        string? unit = null;
        decimal multiplier = 1m;
        if (text.EndsWith("kg", StringComparison.OrdinalIgnoreCase))
        {
            unit = "g"; multiplier = 1000m;
            text = text[..^2].Trim();
        }
        else if (text.EndsWith(" g", StringComparison.OrdinalIgnoreCase) || text.EndsWith("g"))
        {
            unit = "g"; multiplier = 1m;
            text = text.TrimEnd('g').Trim();
        }
        else if (text.EndsWith("dl", StringComparison.OrdinalIgnoreCase))
        {
            unit = "g"; multiplier = 100m;
            text = text[..^2].Trim();
        }
        else if (text.EndsWith("cl", StringComparison.OrdinalIgnoreCase))
        {
            unit = "g"; multiplier = 10m;
            text = text[..^2].Trim();
        }
        else if (text.EndsWith("ml", StringComparison.OrdinalIgnoreCase))
        {
            unit = "g"; multiplier = 1m;
            text = text[..^2].Trim();
        }
        else if (text.EndsWith(" l", StringComparison.OrdinalIgnoreCase) || text.EndsWith("l"))
        {
            unit = "g"; multiplier = 1000m;
            text = text.TrimEnd('l').TrimEnd('L').Trim();
        }
        else
        {
            return (null, null, null);
        }

        var sep = text.Contains('–') ? '–' : '-';
        var parts = text.Split(sep);
        if (parts.Length == 2
            && ParseDecimal(parts[0].Trim()) is decimal lo
            && ParseDecimal(parts[1].Trim()) is decimal hi)
        {
            return (lo * multiplier, hi * multiplier, unit);
        }

        if (ParseDecimal(text.Trim()) is decimal single)
            return (single * multiplier, single * multiplier, unit);

        return (null, null, unit);
    }

    internal static DateTime? ParseGermanDate(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var datePart = text.Split([" zwischen ", " ab ", " bis "], StringSplitOptions.None)[0].Trim();

        var match = System.Text.RegularExpressions.Regex.Match(
            datePart, @"(\d{1,2})\.\s+(\S+)\s+(\d{4})");
        if (!match.Success) return null;

        if (!int.TryParse(match.Groups[1].Value, out var day)) return null;
        if (!int.TryParse(match.Groups[3].Value, out var year)) return null;

        var month = match.Groups[2].Value.TrimEnd('.').ToLowerInvariant() switch
        {
            "jan" or "januar"    => 1,
            "feb" or "februar"   => 2,
            "märz" or "marz"     => 3,
            "apr" or "april"     => 4,
            "mai"                => 5,
            "jun" or "juni"      => 6,
            "jul" or "juli"      => 7,
            "aug" or "august"    => 8,
            "sep" or "sept" or "september" => 9,
            "okt" or "oktober"   => 10,
            "nov" or "november"  => 11,
            "dez" or "dezember"  => 12,
            _                    => 0
        };
        if (month == 0) return null;

        try { return new DateTime(year, month, day, 0, 0, 0, DateTimeKind.Utc); }
        catch { return null; }
    }

    internal static decimal? ParseAmount(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        text = System.Text.RegularExpressions.Regex.Replace(text, @"[^\d.,]", "").Replace("'", "").Trim();
        return decimal.TryParse(text, System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;
    }

    internal static decimal? ParseDecimal(string s)
    {
        s = s.Replace(',', '.');
        return decimal.TryParse(s, System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;
    }
}
