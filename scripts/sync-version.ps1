$ErrorActionPreference = "Stop"

& node (Join-Path $PSScriptRoot "sync-version.cjs")
if ($LASTEXITCODE -ne 0) {
    throw "Version sync failed."
}
