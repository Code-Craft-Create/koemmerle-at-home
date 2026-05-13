#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/backend/KoemmerleAtHome.Api/KoemmerleAtHome.Api.csproj"
OUTPUT_ROOT="$ROOT_DIR/release"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"

case "$NODE_MAJOR" in
  20|22|24) ;;
  *)
    echo "Angular 21 requires Node.js 20, 22, or 24. Found: $(node --version)" >&2
    exit 1
    ;;
esac

"$ROOT_DIR/scripts/sync-version.sh"

publish_runtime() {
  local runtime="$1"
  local output="$OUTPUT_ROOT/$runtime"
  local url="http://localhost:5050"

  dotnet publish "$PROJECT" \
    --configuration Release \
    --runtime "$runtime" \
    --self-contained true \
    --output "$output" \
    -p:PublishSingleFile=true \
    -p:DebugType=none \
    -p:DebugSymbols=false \
    -p:EnableCompressionInSingleFile=true \
    -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:IncludeAllContentForSelfExtract=true

  chmod +x "$output/KoemmerleAtHome.Api"

  cat > "$output/start.command" <<EOF
#!/usr/bin/env bash
set -euo pipefail

cd "\$(dirname "\$0")"

export DOTNET_BUNDLE_EXTRACT_BASE_DIR="\$PWD/.dotnet-bundle"
mkdir -p "\$DOTNET_BUNDLE_EXTRACT_BASE_DIR"

if [ ! -d "\$HOME/Library/Caches/ms-playwright" ]; then
  echo "Installing Playwright Chromium for the Migros login window..."
  ./KoemmerleAtHome.Api --install-playwright
fi

echo "Starting KÖMMERLE At Home..."
echo "Open $url in your browser."
ASPNETCORE_URLS=$url ./KoemmerleAtHome.Api
EOF
  chmod +x "$output/start.command"
}

publish_runtime osx-x64
publish_runtime osx-arm64

echo "macOS release builds written to:"
echo "  $OUTPUT_ROOT/osx-x64/start.command"
echo "  $OUTPUT_ROOT/osx-arm64/start.command"
