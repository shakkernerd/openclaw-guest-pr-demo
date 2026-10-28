# Harbor rota companion

A standalone, dependency-free browser app for the **file-transfer and correction** side of a volunteer rota. All code lives in `e6-harbor/transfer/`; no shared entry point, package manifest, scheduler or repository-root files are changed. All sample people are fictional.

## Run

From the repository root, with **Node 22+** (Node 24 used for verification):

```sh
node e6-harbor/transfer/server.mjs
```

Open **http://127.0.0.1:4173/**. Set `PORT=4174` if needed. The server binds only to loopback and serves an explicit app-asset allowlist. Alternatively serve this folder with any static HTTP server; ES modules require HTTP, not a double-clicked `file://` page. No install, external fonts, CDN, account or build step.

## Use

- Start empty, try the fictional sample, or choose a UTF-8 `.csv` / `.json` file (maximum **2 MiB**). Sample files and a format guide are linked in the app.
- Imports are fully checked, then previewed. **Replace current rota** explicitly confirms replacement; it never merges records. Bad files and cancelled imports leave the current rota intact.
- Search names, roles, dates or IDs. Inspect each volunteer’s assignments and each shift’s crew. Add or edit names, roles, dates, times and assignment checkboxes. IDs remain stable when correcting details. Identically named volunteers remain distinct.
- Editors have explicit labels, native keyboard controls, Escape/cancel, focused validation errors and focus restoration. Removal requires confirmation and explains affected assignments. **Undo last change** restores one previous meaningful edit/import/removal. Unchanged saves or identical imports do not overwrite that checkpoint.
- Export JSON or CSV to keep the complete rota. JSON automatically becomes compact near the 2 MiB limit; CSV can use LF record separators. If one format still exceeds the limit, no unusable download is created: a focused error directs you to the other lossless format. Edits that would make **both** formats too large are rejected before changing the current rota or undo. Data stays in browser memory, not local storage or a service. Closing/reloading loses it. A browser leave warning is requested after any change, even after export because the app cannot verify that a download was kept.

## Lossless v1 interchange

JSON is an object with exactly `version: 1`, `volunteers` and `shifts`:

```json
{
  "version": 1,
  "volunteers": [{ "id": "v1", "name": "Zoë \"Skipper\" Chen" }],
  "shifts": [{
    "id": "s1", "date": "2026-11-07",
    "start": "08:00", "end": "10:30",
    "role": "Quayside welcome", "volunteerIds": ["v1"]
  }]
}
```

CSV uses these exact header names (column order may vary):

```csv
record_type,volunteer_id,volunteer_name,shift_id,date,start,end,role
volunteer,v1,"Zoë ""Skipper"" Chen",,,,,
shift,,,s1,2026-11-07,08:00,10:30,Quayside welcome
assignment,v1,,s1,,,,
```

There are three record types: `volunteer` defines ID/name; `shift` defines ID/date/start/end/role; `assignment` links volunteer ID to shift ID. Other cells must be empty. This deliberately preserves volunteers with no assignments and shifts with no volunteers, unlike a flat one-assignment-per-row table. Records may reference later definitions. Duplicate IDs, duplicate JSON fields, duplicate assignments, missing references, extra fields/columns, ragged rows and malformed quotes are errors, not silent data loss. Blank records are rejected; a final line ending is accepted. A header-only CSV represents an empty rota.

Names and roles are nonblank, well-formed Unicode strings, preserved verbatim (quotes, commas, Unicode, spaces, tabs and quoted newlines included). IDs are 1–80 ASCII letters/digits/dots/underscores/hyphens, starting with a letter/digit. Dates are real `YYYY-MM-DD` dates in years 0001–9999; times are `HH:mm` in **harbor-local wall time**, with end after start on the same date. No timezone conversion occurs. Split overnight shifts across dates. Export retains record and assignment ordering; the UI independently sorts shifts by date/time. JSON formatting and CSV quoting/line endings are canonicalized, not byte-for-byte copies.

**Spreadsheet caution:** lossless CSV does not prefix or alter formula-looking names/roles (`=`, `+`, `-`, `@`, etc.). Do not open untrusted CSV as executable spreadsheet formulas; import all columns as text. Prefer JSON for archives. The app renders imported text as text, not HTML.

## Checks

Run from the repository root; all use built-in Node APIs:

```sh
node --test e6-harbor/transfer/tests/rota.test.mjs
node e6-harbor/transfer/validate.mjs
node e6-harbor/transfer/browser-check.mjs
node --test
```

The data tests exercise the actual importer/exporter/store: quoted/multiline/Unicode data, both formats, empty/unassigned records, stable identity, malformed input, dates/times, references, atomic failure and repeated round trips. `validate.mjs` checks JavaScript syntax, HTML IDs/links, local assets, sample parity, live HTTP responses/MIME types and server boundaries. This is a real validation gate for an unbundled static app.

`browser-check.mjs` launches an **already installed Chromium** via DevTools with no added packages. It checks real file inputs and downloaded contents, import confirmation/cancel, malformed-file preservation after unsaved edits, import cancellation and undo history, no-op saves/imports, corrections, error focus, deletion/undo, keyboard Enter/Escape/Tab/Shift+Tab, control accessible names, text-safe rendering and 320/360px layout bounds. Set `CHROME_BIN=/path/to/chromium` if auto-detection misses it. No browser is downloaded. For sandboxed CI it launches Chromium with `--no-sandbox`; use only this local synthetic test page. Optional `SCREENSHOT_DIR=e6-harbor/transfer/.artifacts` saves screenshots. This is not a full screen-reader or cross-browser accessibility audit.

## Combining with scheduling later

Keep this contribution unmerged until the next review/integration decision. Independently review the scheduling contribution at its exact branch/PR head before integrating it here. If branches conflict, preserve both sets of behavior and tests; do not resolve by wholesale choosing one side. Agree the data adapter/schema and rerun both suites plus browser transfer checks after resolution.

- Serve/link `transfer/index.html` as an independent route, or import the pure functions from `transfer/rota.mjs`: `validateRota`, `importRota(text, 'csv'|'json')`, `exportCSV`, `exportJSON`, `createRotaStore`. They have no DOM or scheduler dependencies. `rotaFingerprint` compares all v1 values and ordering independently of object property order; use `createRotaStore` to retain validation and archive-capacity guarantees.
- Agree a shared versioned schema before connecting the scheduler. This app intentionally rejects unknown fields rather than dropping a colleague’s scheduling metadata. Add an explicit adapter or evolve the schema together; do not assume arbitrary existing CSV/JSON is compatible.
- Out of scope: automatic scheduling, availability/capacity/conflict checks, accounts, persistence, multiuser sync, arbitrary spreadsheet column mapping and overnight shifts. File size is limited to 2 MiB; very large valid rotas may still render slowly.
