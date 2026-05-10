# Third-Party Notices

This project depends on third-party open-source software. This file is a
human-readable summary for source releases; generated application bundles,
container images, installers, and other distributions should include the
corresponding third-party license notices as well.

Dependency versions were reviewed from:

- `frontend/koemmerle-at-home/package-lock.json`
- `backend/KoemmerleAtHome.Api/obj/project.assets.json`
- the local NuGet package metadata under `~/.nuget/packages`

## Frontend

Direct frontend dependencies are licensed as follows:

| Package | License |
| --- | --- |
| `@angular/*` packages | MIT |
| `@angular-devkit/build-angular` | MIT |
| `@angular/cli` | MIT |
| `@microsoft/signalr` | MIT |
| `chart.js` | MIT |
| `fuse.js` | Apache-2.0 |
| `jasmine-core` and Karma test packages | MIT |
| `jsbarcode` | MIT |
| `jspdf` | MIT |
| `rxjs` | Apache-2.0 |
| `tslib` | 0BSD |
| `typescript` | Apache-2.0 |
| `zone.js` | MIT |

The frontend lockfile also includes transitive dependencies under permissive
licenses such as MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD,
BlueOak-1.0.0, CC0-1.0, Unlicense, and compatible dual-license expressions.

Notable transitive packages with non-standard or dual-license expressions:

| Package | License |
| --- | --- |
| `argparse` | Python-2.0 |
| `caniuse-lite` | CC-BY-4.0 |
| `dompurify` | MPL-2.0 OR Apache-2.0 |
| `fetch-cookie` | Unlicense |
| `node-forge` | BSD-3-Clause OR GPL-2.0 |
| `pako` | MIT AND Zlib |
| `rgbcolor` | MIT OR SEE LICENSE IN FEEL-FREE.md |
| `spdx-exceptions` | CC-BY-3.0 |

Angular production builds are configured to extract third-party licenses into
the build output.

## Backend

Direct backend dependencies are licensed as follows:

| Package | License |
| --- | --- |
| `Microsoft.AspNetCore.OpenApi` | MIT |
| `Microsoft.Playwright` | MIT |
| `System.IdentityModel.Tokens.Jwt` | MIT |
| `Microsoft.EntityFrameworkCore.Sqlite` | MIT |
| `Microsoft.EntityFrameworkCore.Design` | MIT |
| `SixLabors.ImageSharp` | Six Labors Split License |

The restored backend dependency graph is mostly MIT licensed, with
`SQLitePCLRaw.*` packages licensed under Apache-2.0.

### SixLabors.ImageSharp

`SixLabors.ImageSharp` version `3.1.12` uses the Six Labors Split License.
Under that license, ImageSharp may be available under Apache-2.0 for qualifying
open-source, source-available, nonprofit, transitive dependency, or smaller
direct commercial use cases. Other direct commercial use may require a Six
Labors commercial license. Review the ImageSharp license before distributing
ScanAtHome commercially or embedding it in another product.

## Maintenance

Re-check this file whenever dependencies are added, removed, or upgraded.
For release artifacts, include generated third-party notices from the relevant
package managers/build tools in addition to this summary.
