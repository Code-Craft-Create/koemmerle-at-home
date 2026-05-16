const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const versionFile = path.join(rootDir, "VERSION");
const frontendDir = path.join(rootDir, "frontend", "koemmerle-at-home");
const propsFile = path.join(rootDir, "Directory.Build.props");

const version = (process.env.APP_VERSION || fs.readFileSync(versionFile, "utf8")).trim();

if (!version) {
  console.error("VERSION must not be empty");
  process.exit(1);
}

if (!/^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("VERSION must be a semantic version like 1.2.3 or 1.2.3-beta.1");
  process.exit(1);
}

const core = version.split(/[+-]/)[0];
const parts = core.split(".");
while (parts.length < 4) parts.push("0");
const assemblyVersion = parts.slice(0, 4).join(".");

for (const filePath of [
  path.join(frontendDir, "package.json"),
  path.join(frontendDir, "package-lock.json"),
]) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  json.version = version;

  if (json.packages && json.packages[""]) {
    json.packages[""].version = version;
  }

  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

const xml = `<Project>
  <PropertyGroup>
    <Version>${version}</Version>
    <AssemblyVersion>${assemblyVersion}</AssemblyVersion>
    <FileVersion>${assemblyVersion}</FileVersion>
    <InformationalVersion>${version}</InformationalVersion>
  </PropertyGroup>
</Project>
`;

fs.writeFileSync(propsFile, xml);

console.log(`Synced version ${version}`);
