namespace KoemmerleAtHome.Api;

public sealed class LocalAppData
{
    private const string AppFolderName = "Koemmerle At Home";
    private const string LinuxAppFolderName = "koemmerle-at-home";

    public LocalAppData(IConfiguration configuration)
    {
        RootDirectory = ResolveRootDirectory(
            configuration["DataDirectory"] ?? configuration["KoemmerleAtHome:DataDirectory"]);
        Directory.CreateDirectory(RootDirectory);

        DatabasePath = Path.Combine(RootDirectory, "koemmerleathome.db");
        PlaywrightSessionDirectory = Path.Combine(RootDirectory, "playwright-session");
        MigrosSessionDirectory = Path.Combine(RootDirectory, "migros-session");
    }

    public string RootDirectory { get; }
    public string DatabasePath { get; }
    public string PlaywrightSessionDirectory { get; }
    public string MigrosSessionDirectory { get; }

    private static string ResolveRootDirectory(string? configuredPath)
    {
        if (!string.IsNullOrWhiteSpace(configuredPath))
            return Path.GetFullPath(ExpandHome(configuredPath));

        string baseDirectory;
        if (OperatingSystem.IsWindows())
        {
            baseDirectory = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(RequireDirectory(baseDirectory, "Windows application data"), AppFolderName);
        }

        if (OperatingSystem.IsMacOS())
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(RequireDirectory(home, "user profile"), "Library", "Application Support", AppFolderName);
        }

        var xdgDataHome = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
        if (!string.IsNullOrWhiteSpace(xdgDataHome))
            return Path.Combine(Path.GetFullPath(ExpandHome(xdgDataHome)), LinuxAppFolderName);

        var linuxHome = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(RequireDirectory(linuxHome, "user profile"), ".local", "share", LinuxAppFolderName);
    }

    private static string ExpandHome(string path)
    {
        if (path == "~")
            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        if (path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal))
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), path[2..]);

        return path;
    }

    private static string RequireDirectory(string path, string description)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new InvalidOperationException($"Could not resolve {description} directory.");

        return path;
    }
}
