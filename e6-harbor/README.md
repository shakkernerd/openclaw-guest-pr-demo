# Harbor — a local volunteer rota

A useful, dependency-free rota for a small harbor crew. Everything lives in this folder; the existing repository files are untouched. No accounts, cloud, telemetry, CDNs, external fonts, runtime libraries, dependency installation, or application network calls. Import/export is deliberately left to the independently developed companion. See `INTEGRATION.md` for the current access blocker and the contract that still needs comparison.

## Try it immediately

Open **`e6-harbor/index.html`** directly in a modern browser. No server or build is required. From the repository root, for example:

```sh
# macOS
open e6-harbor/index.html

# Linux desktop
xdg-open e6-harbor/index.html
```

The first visit starts with **26 October–1 November 2026**: six volunteers, ten shifts, eleven assignments, and five open crew places. The **Demo week** button navigates there; it does **not** reset edits.

### A quick tour

1. Open **Morning launch → Assign crew** on Monday. Maya is blocked because her other shifts overlap; Ian is eligible. Assign Ian and watch coverage update.
2. Maya already has **08:00–10:00** and **10:00–12:00** duties. This is intentional: back-to-back shifts are allowed.
3. Edit **Open the harbor** to end at **10:01**. The app rejects the edit and names the conflicting shift. The original assignment and time stay intact.
4. Open **Volunteers** to add or edit names, eligible roles, notes, and repeating weekly availability. Unchecked weekdays mean unavailable.
5. Add shifts, filter by role or missing crew, change weeks, and remove/reassign crew. Deleting a shift or volunteer asks for confirmation and explains the number of assignments removed.

## Exact check commands

Requires **Node.js 22+** for development checks. Do **not** run an install command; there are no dependencies. Run these from the repository root:

```sh
# Focused scheduling and persistence tests
node --test e6-harbor/tests/*.test.js

# Syntax, local-resource, dependency and static packaging verification
node e6-harbor/scripts/build.cjs

# Real-browser interaction, keyboard, narrow-layout and offline checks
node e6-harbor/scripts/browser-check.cjs

# Run the same browser checks against the packaged artifact
HARBOR_APP_DIR=e6-harbor/dist node e6-harbor/scripts/browser-check.cjs

# Include the original repository tests as well
node --test
```

The browser check needs an **already installed** Chrome/Chromium. It detects common Linux/macOS locations and the local sandbox browser. If yours is elsewhere:

```sh
CHROMIUM_PATH=/absolute/path/to/chromium node e6-harbor/scripts/browser-check.cjs
```

On macOS, for example:

```sh
CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node e6-harbor/scripts/browser-check.cjs
```

The browser runner uses only Node built-ins and Chromium’s debugging **OS pipe**, not a server, socket, or automation package. It uses a disposable profile, forces the page offline, disables background networking and DNS resolution, and fails if the app attempts any network request. It never downloads a browser. It launches with `--no-sandbox` for this isolated container; use it only against these trusted local files. The temporary profile is deleted afterwards. Screenshots are written to ignored `e6-harbor/artifacts/`.

Equivalent scripts from inside the folder are `npm test`, `npm run build`, and `npm run test:browser`; npm is optional.

### What is checked

- **26 focused tests** exercise the actual shared app domain and storage modules: all overlap shapes; exact boundaries; different people/dates; role/availability restrictions; duplicates and capacity; assignment replacement; atomic rejected edits; cascading deletion; schema/date validation; scoped coverage; persistence; corrupt-data preservation; storage denial/quota failure; and stale-tab detection.
- **22 browser checks** load the actual app and use its forms: seed rendering, forward/reverse Tab, Enter/Escape and focus return, forced invalid assignment rejection, valid assignments, shift/volunteer editing, back-to-back duties, escaped user text, filters/search, confirmation/deletion, reload persistence, 360px/320px layouts and editors, corrupt/blocked storage warnings, and no page errors or network requests. Coordinator scenarios compare the entire saved snapshot byte-for-byte after rejected changes, exercise valid role/availability changes and back-to-back reassignment, fill then unfill a shift, and reload the exact resulting rota. Keyboard regressions verify that opening or updating crew never focuses a destructive Remove button, repeated Enter leaves assignments intact, the safe focus target is visible, and confirmation is inside the modal. Boundary-date reloads must recover explicitly without overwriting saved bytes; supported boundary weeks must render.
- The static build syntax-checks JavaScript, verifies local-only asset references and zero package dependencies, validates the demo, then copies five assets byte-for-byte to `dist/`. `dist/manifest.json` records their sizes and SHA-256 hashes. The output is directly openable as `dist/index.html`; nothing is uploaded.
- Automated checks are not a complete screen-reader or cross-browser accessibility audit. The browser suite was exercised in local Chromium; other modern browsers are not claimed as tested.

## Scheduling rules and intentional limits

- Monday–Sunday weeks; dates are calendar dates, not UTC instants. Schedule times are **harbor-local, 24-hour wall-clock times**. Native date/time form controls follow your browser locale and may show AM/PM. No timezone conversion, daylight-saving arithmetic, or travel time is applied.
- Shifts have one date, one required role, and 1–20 crew places. Start must precede end on the same day; overnight shifts are not supported. Shift dates are limited to **1900-01-08 through 9999-12-20**, matching the editors and leaving room to render complete weeks. Out-of-range saved snapshots are protected and shown as a recoverable warning, never silently overwritten. Add parallel shifts when an activity needs different roles.
- The three fixed roles are **Dock lead**, **Launch crew**, and **Shore support**. Volunteers can hold multiple roles.
- Availability repeats weekly with one continuous window per enabled weekday. It must cover the entire shift, including exact start/end boundaries. No one-off exceptions or split windows yet. An empty availability list means unavailable, not unrestricted.
- Overlap is strict interval intersection: `a.start < b.end && b.start < a.end` on the same date. Therefore `08:00–10:00` and `10:00–12:00` do not overlap.
- The app blocks ineligible/unavailable crew, duplicate assignments, overfilling, and overlapping assignments. It also rejects shift and volunteer edits that would invalidate existing assignments. Unassign affected duties first if an availability or qualification really changes.
- Coverage counts **crew places**, not distinct people. The four summary figures always cover the entire selected week, even when the shift list is filtered.
- Names are not identifiers; two people can share a name. IDs remain stable on edits.

## Local data and accessibility

Data is saved under localStorage key **`e6-harbor.rota.v1`** after each successful edit. Use one editing tab and one browser profile. There is no multi-user sync, locking service, backup, or export yet. Sequential stale-tab saves are detected and protected, but localStorage comparison is not an atomic cross-tab transaction.

File-URL storage behavior depends on the browser. Moving the folder, changing profiles, private browsing, or clearing browser data can make saved data unavailable. A prominent warning appears if saving is blocked or full; those edits live only in the current tab. Invalid saved data is never automatically replaced: a temporary demo is displayed with a warning, and writes are disabled for that session. Keep the tab open if it contains unsaved work.

For an intentional demo reset, first preserve any data you want to keep. In this app’s browser developer console, `localStorage.removeItem("e6-harbor.rota.v1"); location.reload();` removes only this app’s saved rota. This is destructive and is **not** run by the app or build.

The UI uses real buttons, labeled inputs, native modal dialogs, visible focus indicators, a skip link, focus-contained editors, Escape-to-close, focus restoration, live status messages, focused validation errors, and text as well as color for coverage states. All views and editors reflow without horizontal scrolling at 320px and 360px. Dialogs scroll vertically. Browser Print provides a simplified schedule.

## Integration boundary for the companion

No companion worktree files were read or changed. Integration is deferred; its actual schema remains unverified because this session cannot access that branch/chat (details in `INTEGRATION.md`). The current contract is deliberately explicit:

```text
{
  version: 1,
  volunteers: [{ id, name, roles: string[], availability: [{ day, start, end }], notes }],
  shifts: [{ id, title, date, start, end, role, required, notes }],
  assignments: [{ id, shiftId, volunteerId }]
}
```

`day` is 0=Monday through 6=Sunday. Dates use `YYYY-MM-DD`; times use zero-padded `HH:mm`. IDs must be nonempty unique strings within each collection (max 80 characters); assignment references must exist. Names/titles are required (max 80), notes are strings (max 500). Role strings must exactly match the fixed roles above. Availability and assignment invariants are enforced during validation.

- `core.js` exports the same API as `window.HarborCore` in the browser and `require("./core.js")` in Node.
- `validateState(state)` validates the entire snapshot and throws on failure. It does not coerce, silently repair, or strip unknown fields. A future importer should select/map supported fields deliberately and validate **before** replacing data.
- `saveVolunteer`, `saveShift`, `saveAssignment`, and `remove` return a **new validated state**. Failed edits leave the input untouched. `saveAssignment` supports replacement using an existing assignment ID; the UI provides remove/add editing.
- `assignmentIssues(state, shiftId, volunteerId, ignoreAssignmentId?)` returns readable reasons. `coverage(state, shifts?)` computes filled, required, open, covered, and total shifts.
- `storage.js` owns the storage key and browser-failure handling. `app.js` is only the UI adapter. No import/export buttons or speculative companion API were added.

Future integration should retain stable IDs, review schema/version handling, reject partial or conflicting snapshots atomically, and add round-trip tests before enabling imports.
