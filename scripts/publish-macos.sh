#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/backend/KoemmerleAtHome.Api/KoemmerleAtHome.Api.csproj"
OUTPUT_ROOT="$ROOT_DIR/release"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
RUNTIMES=()

usage() {
  cat <<'EOF'
Usage: ./scripts/publish-macos.sh [--arm|--x64|--both]

Options:
  --arm    Build only the Apple silicon release (osx-arm64)
  --x64    Build only the Intel Mac release (osx-x64)
  --both   Build both releases (default)
  --help   Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --arm)
      RUNTIMES=("osx-arm64")
      ;;
    --x64)
      RUNTIMES=("osx-x64")
      ;;
    --both)
      RUNTIMES=("osx-x64" "osx-arm64")
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ "${#RUNTIMES[@]}" -eq 0 ]; then
  RUNTIMES=("osx-x64" "osx-arm64")
fi

case "$NODE_MAJOR" in
  20|22|24) ;;
  *)
    echo "Angular 21 requires Node.js 20, 22, or 24. Found: $(node --version)" >&2
    exit 1
    ;;
esac

"$ROOT_DIR/scripts/sync-version.sh"

(
  cd "$ROOT_DIR/frontend/koemmerle-at-home"
  npm ci --legacy-peer-deps
  npm run build -- --configuration production
)

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
    -p:IncludeAllContentForSelfExtract=true \
    -p:BuildFrontend=false

  chmod +x "$output/KoemmerleAtHome.Api"

  cat > "$output/start.command" <<EOF
#!/usr/bin/env bash
set -euo pipefail

cd "\$(dirname "\$0")"

export DOTNET_BUNDLE_EXTRACT_BASE_DIR="\$PWD/.dotnet-bundle"
mkdir -p "\$DOTNET_BUNDLE_EXTRACT_BASE_DIR"

echo "Ensuring Playwright Chromium is installed for the Migros login window..."
./KoemmerleAtHome.Api --install-playwright

echo "Starting KÖMMERLE At Home..."
echo "Open $url in your browser."
OpenBrowserDelaySeconds=3 ASPNETCORE_URLS=$url ./KoemmerleAtHome.Api
EOF
  chmod +x "$output/start.command"
}

for runtime in "${RUNTIMES[@]}"; do
  publish_runtime "$runtime"
done

echo "macOS release builds written to:"
for runtime in "${RUNTIMES[@]}"; do
  echo "  $OUTPUT_ROOT/$runtime/start.command"
done
