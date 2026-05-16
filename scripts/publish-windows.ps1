$ErrorActionPreference = "Stop"

$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$project = Join-Path $rootDir "backend\KoemmerleAtHome.Api\KoemmerleAtHome.Api.csproj"
$outputRoot = Join-Path $rootDir "release"
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")

if ($nodeMajor -notin @(20, 22, 24)) {
    throw "Angular 21 requires Node.js 20, 22, or 24. Found: $(node --version)"
}

& (Join-Path $PSScriptRoot "sync-version.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "Version sync failed."
}

$frontendDir = Join-Path $rootDir "frontend\koemmerle-at-home"
$output = Join-Path $outputRoot "win-x64"

$frontendPath = (Resolve-Path $frontendDir).Path
$frontendProcesses = Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Path -and
        ($_.ProcessName -in @("node", "esbuild", "ng")) -and
        $_.Path.StartsWith($frontendPath, [System.StringComparison]::OrdinalIgnoreCase)
    }

$releasePath = [System.IO.Path]::GetFullPath($output)
$releaseProcesses = Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Path -and
        $_.Path.StartsWith($releasePath, [System.StringComparison]::OrdinalIgnoreCase)
    }

$lockingProcesses = @($frontendProcesses) + @($releaseProcesses)
if ($lockingProcesses.Count -gt 0) {
    $processList = ($lockingProcesses | Sort-Object Id -Unique | ForEach-Object {
        "  $($_.ProcessName) PID $($_.Id): $($_.Path)"
    }) -join [Environment]::NewLine

    throw @"
Found processes running from this repository. Stop the Angular dev server, build watcher, or running release app before publishing, then run this script again.
$processList
"@
}

Push-Location $frontendDir
try {
    npm ci --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed."
    }

    npm run build -- --configuration production
    if ($LASTEXITCODE -ne 0) {
        throw "Angular production build failed."
    }
}
finally {
    Pop-Location
}

function Publish-Runtime {
    param([string]$Rid)

    $output = Join-Path $outputRoot $Rid
    $url = "http://localhost:5050"

    dotnet publish $project `
        --configuration Release `
        --runtime $Rid `
        --self-contained true `
        --output $output `
        -p:PublishSingleFile=true `
        -p:DebugType=none `
        -p:DebugSymbols=false `
        -p:EnableCompressionInSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:IncludeAllContentForSelfExtract=true `
        -p:BuildFrontend=false
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed for $Rid."
    }

    $startCmd = @"
@echo off
setlocal
cd /d "%~dp0"

set "DOTNET_BUNDLE_EXTRACT_BASE_DIR=%CD%\.dotnet-bundle"
if not exist "%DOTNET_BUNDLE_EXTRACT_BASE_DIR%" mkdir "%DOTNET_BUNDLE_EXTRACT_BASE_DIR%"

set "PLAYWRIGHT_CACHE=%LOCALAPPDATA%\ms-playwright"
if not exist "%PLAYWRIGHT_CACHE%" (
  echo Installing Playwright Chromium for the Migros login window...
  KoemmerleAtHome.Api.exe --install-playwright
)

echo Starting KOEMMERLE At Home...
echo Open $url in your browser.
set "ASPNETCORE_URLS=$url"
KoemmerleAtHome.Api.exe
pause
"@

    Set-Content -Path (Join-Path $output "start.cmd") -Value $startCmd -Encoding ascii
}

Publish-Runtime "win-x64"

Write-Host "Windows release builds written to:"
Write-Host "  $(Join-Path $outputRoot "win-x64\start.cmd")"
