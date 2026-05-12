#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$ROOT_DIR/VERSION"
FRONTEND_DIR="$ROOT_DIR/frontend/koemmerle-at-home"
PROPS_FILE="$ROOT_DIR/Directory.Build.props"

VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"

if [[ -z "$VERSION" ]]; then
  echo "VERSION must not be empty" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
  echo "VERSION must be a semantic version like 1.2.3 or 1.2.3-beta.1" >&2
  exit 1
fi

ASSEMBLY_VERSION="$(node -e '
const version = process.argv[1];
const core = version.split(/[+-]/)[0];
const parts = core.split(".");
while (parts.length < 4) parts.push("0");
console.log(parts.slice(0, 4).join("."));
' "$VERSION")"

node -e '
const fs = require("fs");
const [version, packagePath, lockPath] = process.argv.slice(1);

for (const path of [packagePath, lockPath]) {
  const json = JSON.parse(fs.readFileSync(path, "utf8"));
  json.version = version;

  if (json.packages && json.packages[""]) {
    json.packages[""].version = version;
  }

  fs.writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}
' "$VERSION" "$FRONTEND_DIR/package.json" "$FRONTEND_DIR/package-lock.json"

node -e '
const fs = require("fs");
const [propsPath, version, assemblyVersion] = process.argv.slice(1);
const xml = `<Project>
  <PropertyGroup>
    <Version>${version}</Version>
    <AssemblyVersion>${assemblyVersion}</AssemblyVersion>
    <FileVersion>${assemblyVersion}</FileVersion>
    <InformationalVersion>${version}</InformationalVersion>
  </PropertyGroup>
</Project>
`;

fs.writeFileSync(propsPath, xml);
' "$PROPS_FILE" "$VERSION" "$ASSEMBLY_VERSION"

echo "Synced version $VERSION"
