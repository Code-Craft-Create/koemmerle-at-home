# Koemmerle at Home v0.4.0

Release notes for changes between `v0.3.0` and `v0.4.0`.

## English

### Highlights

- Added Bring integration to read a Bring shopping list, match items to Migros products, and enqueue selected products for shopping.
- Improved the stickers workflow with export history, reloadable previous exports, filtering for already printed stickers, and removal from the preview.
- Added Migros search to the stickers page, making it easier to add products that are not already in the local product list.
- Added basket controls to "Meine Produkte", including add/remove actions and basket quantity feedback.
- Improved scanning and queue handling with product-scan fixes plus retry/remove actions in the queue overlay.

### Details

- Added backend endpoints and Playwright support for Bring list extraction and Migros product matching.
- Added saved sticker export data via `StickerExport` and `StickerExportsController`.
- Added product `stickerPrintedAt` tracking and settings support for sticker export behavior.
- Improved recipe item search and product scanning UI feedback.
- Added "last ordered date" to the product list and made a small visual refresh.
- Updated backend, frontend, and root version metadata from `0.3.0` to `0.4.0`.

Compared tags: `v0.3.0..v0.4.0`

## Deutsch

### Highlights

- Bring-Integration ergänzt, um eine Bring-Einkaufsliste auszulesen, Einträge Migros-Produkten zuzuordnen und ausgewählte Produkte für den Einkauf einzureihen.
- Der Sticker-Workflow wurde verbessert mit Export-Historie, erneut ladbaren früheren Exporten, Filter für bereits gedruckte Sticker und Entfernen aus der Vorschau.
- Die Sticker-Seite kann nun direkt bei Migros suchen, damit auch Produkte ausserhalb der lokalen Produktliste einfacher hinzugefügt werden können.
- "Meine Produkte" hat Warenkorb-Aktionen erhalten, inklusive Hinzufügen/Entfernen und Anzeige der Menge im Warenkorb.
- Scanning und Queue-Bedienung wurden verbessert, inklusive Korrekturen beim Produktscan sowie Wiederholen/Entfernen in der Queue-Ansicht.

### Details

- Backend-Endpunkte und Playwright-Unterstützung für Bring-Listen-Auslesung und Migros-Produktabgleich wurden ergänzt.
- Gespeicherte Sticker-Exporte wurden mit `StickerExport` und `StickerExportsController` ergänzt.
- Produkte speichern nun `stickerPrintedAt`; zusätzlich gibt es Settings-Unterstützung für das Sticker-Export-Verhalten.
- Rezept-Produktsuche und UI-Rückmeldungen beim Produktscan wurden verbessert.
- Die Produktliste zeigt nun das letzte Bestelldatum und erhielt eine kleine visuelle Überarbeitung.
- Backend-, Frontend- und Root-Version wurden von `0.3.0` auf `0.4.0` aktualisiert.

Verglichene Tags: `v0.3.0..v0.4.0`
