# KÖMMERLE At Home

KÖMMERLE At Home is a home grocery automation system for Migros Online customers.
Family members, including young kids, scan barcodes at home; the app resolves
the scan to products or recipes, queues the resulting items, and adds them to
the family's Migros shopping list/cart.

For products that do not have a convenient barcode at home, such as produce,
bakery items, frozen goods, or Migros Online products that arrive without
scannable packaging, KÖMMERLE At Home can generate printable barcode stickers.
Stick a generated label near the product's storage place, scan that label later,
and the item flows through the same queue and Migros basket automation.

The project is built as a local-first Angular + ASP.NET Core application. A
small browser session is used to sign in to Migros and capture/refresh the
bearer token; product lookup, order sync, basket reads, and basket writes are
then handled through Migros HTTP endpoints.

## What It Does

- Scan product barcodes and add recognized products to a processing queue.
- Create printable barcode sticker sheets for products and recipes, including
  items found from Migros search that do not yet exist in the local product
  catalog.
- Define "recipes": a barcode can expand into multiple Migros products and
  quantities.
- Process the queue in the background and update the Migros basket/shopping
  list.
- View and adjust the current Migros basket.
- Sync Migros order history and link ordered items back to local products.
- Track product usage, monthly totals, and forecast likely future purchases.
- Manage products, barcodes, thumbnails, categories, recipes, and sticker
  layouts.
- Push live scan, queue, and order-sync updates to the frontend with SignalR.

## Project Structure

```text
backend/KoemmerleAtHome.Api/     ASP.NET Core API, SQLite data store,
                                 Migros integration, background services
frontend/koemmerle-at-home/      Angular frontend
docs/migros-api-payloads/        Captured Migros API payload examples used
                                 while developing the integration
```

## Tech Stack

- Backend: ASP.NET Core, .NET 10, Entity Framework Core, SQLite, SignalR
- Frontend: Angular 21, Angular Material/CDK, RxJS, SignalR client
- Migros session: Playwright persistent Chromium profile for login/token capture
- Charts and exports: Chart.js, jsPDF, JsBarcode

## Local Development

### Prerequisites

- .NET 10 SDK
- Node.js 24 and npm
- PowerShell (`pwsh`) for the Playwright browser install step
- Playwright's Chromium browser installed for the backend project
- A Migros account

### Backend

```bash
dotnet restore backend/KoemmerleAtHome.Api/KoemmerleAtHome.Api.csproj
dotnet build backend/KoemmerleAtHome.Api/KoemmerleAtHome.Api.csproj
pwsh backend/KoemmerleAtHome.Api/bin/Debug/net10.0/playwright.ps1 install chromium
dotnet run --project backend/KoemmerleAtHome.Api --launch-profile http
```

The Playwright install command downloads the Chromium browser used for the
Migros login window. Run it again after cleaning `bin/` or changing target
frameworks if the generated `playwright.ps1` script disappears.

The API listens on `http://localhost:5050` when started with the `http` launch
profile. On startup it creates or updates a local SQLite database named
`koemmerleathome.db` in the per-user app data directory.

When the backend starts, it opens a persistent Chromium window at migros.ch. Log
in there once. The browser profile and bearer token cache are stored in the same
per-user app data directory, and the backend keeps the bearer token fresh while
it is running.

To intentionally keep runtime state somewhere else, pass `DataDirectory` during
startup:

```bash
dotnet run --project backend/KoemmerleAtHome.Api --launch-profile http -- --DataDirectory .
```

### Frontend

```bash
cd frontend/koemmerle-at-home
npm ci --legacy-peer-deps
npm start
```

The Angular dev server runs on `http://localhost:4200` and talks to the backend
at `http://localhost:5050`. The production frontend uses the same origin as the
server that hosts it.

## Ready-to-Run Releases

The backend can serve the production Angular build directly, so release users
only need to start the ASP.NET Core executable and open its URL in a browser.

The release build requires Node.js 20, 22, or 24 for the Angular 21 production
build, plus the .NET 10 SDK for publishing.

Stop any running Angular dev server or frontend build before publishing. The
release scripts run `npm ci`, which replaces files in `node_modules`.

### macOS

Build both macOS variants from the repository root:

```bash
./scripts/publish-macos.sh
```

To build only one architecture, pass a target option:

```bash
./scripts/publish-macos.sh --arm
./scripts/publish-macos.sh --x64
```

The script creates self-contained single-file macOS publishes for:

- Intel Macs: `release/osx-x64/start.command`
- Apple silicon Macs: `release/osx-arm64/start.command`

Run the matching `start.command` file. It starts the backend on
`http://localhost:5050` and installs Playwright's Chromium browser on first run
if it is missing. The backend opens the frontend in the default browser after
startup:

```bash
./release/osx-arm64/start.command
```

Then open `http://localhost:5050` in a browser.

You can also run the executable directly:

```bash
cd release/osx-arm64
DOTNET_BUNDLE_EXTRACT_BASE_DIR="$PWD/.dotnet-bundle" \
  KoemmerleAtHome__DataDirectory="$PWD" \
  ASPNETCORE_URLS=http://localhost:5050 \
  ./KoemmerleAtHome.Api
```

### Linux

Build both Linux variants from the repository root:

```bash
./scripts/publish-linux.sh
```

To build only one architecture, pass a target option:

```bash
./scripts/publish-linux.sh --x64
./scripts/publish-linux.sh --arm64
```

The script creates self-contained single-file Linux publishes for:

- Linux x64: `release/linux-x64/start.sh`
- Linux ARM64: `release/linux-arm64/start.sh`

Run the matching `start.sh` file. It starts the backend on
`http://localhost:5050` and installs Playwright's Chromium browser on first run
if it is missing:

```bash
./release/linux-x64/start.sh
```

Linux needs a desktop session with `xdg-open` available for automatic browser
opening. On minimal systems, install the Playwright host dependencies required
by Chromium before the first login window can open.

### Windows

Build the Windows release from PowerShell at the repository root:

```powershell
.\scripts\publish-windows.ps1
```

The script creates a self-contained single-file Windows publish for:

- Windows x64: `release/win-x64/start.cmd`

Run the matching `start.cmd` file. It starts the backend on
`http://localhost:5050` and installs Playwright's Chromium browser on first run
if it is missing.

## Useful Endpoints

- `POST /api/scan` scans a barcode.
- `GET /api/cart/queue` returns the local processing queue.
- `GET /api/cart/basket` reads the current Migros basket.
- `POST /api/cart/pause` and `POST /api/cart/resume` control background cart
  processing.
- `GET /api/products` manages locally known Migros products.
- `GET /api/recipes` manages barcode-to-multiple-product recipes.
- `POST /api/orders/sync-headers` syncs Migros order headers.
- `GET /api/statistics/forecast` returns purchase forecasts.
- `/hubs/scan` is the SignalR hub for live scan and queue updates.

Development OpenAPI metadata is exposed by the backend when running in the
Development environment.

## Data and Runtime Files

Local runtime state is intentionally kept out of version control:

- `koemmerleathome.db*` stores products, recipes, queue items, orders, and app
  settings.
- `playwright-session/` stores the local Migros browser profile.
- `migros-session/` stores the captured bearer-token cache.
- `bin/`, `obj/`, `.angular/cache/`, and `node_modules/` are generated build or
  dependency folders.

By default these files live outside the downloaded release folder:

- macOS: `~/Library/Application Support/Koemmerle At Home/`
- Windows: `%APPDATA%\Koemmerle At Home\`
- Linux: `$XDG_DATA_HOME/koemmerle-at-home/` or `~/.local/share/koemmerle-at-home/`

Set `DataDirectory` at startup to override this location, for example
`KoemmerleAtHome__DataDirectory="$PWD"` when you deliberately want state next to
the executable.

If the local database schema is older, the backend applies a small set of
startup migrations in `Program.cs`.

## Notes on the Migros Integration

This project depends on Migros web endpoints observed from the Migros website,
including product display, search, shopping-list, and order APIs. These are not
publicly guaranteed APIs, so payloads or authentication behavior may change and
require code updates.

The current implementation uses Playwright for interactive login and token
capture only. Queue processing and basket updates are performed by HTTP services
once an authenticated token is available.

## License

KÖMMERLE At Home is licensed under the Apache License, Version 2.0. See
`LICENSE`.

Third-party dependency notices are summarized in `THIRD-PARTY-NOTICES.md`.

## Contributing

Contributions are welcome under the same Apache-2.0 license. See
`CONTRIBUTING.md`.
