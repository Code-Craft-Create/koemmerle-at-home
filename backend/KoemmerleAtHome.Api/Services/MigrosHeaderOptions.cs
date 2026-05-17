namespace KoemmerleAtHome.Api.Services;

internal sealed record MigrosHeaderOptions(
    bool SendCookies,
    bool SendBrowserIdentity,
    bool SendPeerId,
    bool SendTelemetry,
    bool SendPriority,
    bool SendAcceptEncoding)
{
    public static MigrosHeaderOptions FromConfiguration(IConfiguration configuration)
    {
        var section = configuration.GetSection("Migros:Headers");

        return new MigrosHeaderOptions(
            SendCookies: section.GetValue("SendCookies", false),
            SendBrowserIdentity: section.GetValue("SendBrowserIdentity", false),
            SendPeerId: section.GetValue("SendPeerId", false),
            SendTelemetry: section.GetValue("SendTelemetry", false),
            SendPriority: section.GetValue("SendPriority", false),
            SendAcceptEncoding: section.GetValue("SendAcceptEncoding", true));
    }
}
