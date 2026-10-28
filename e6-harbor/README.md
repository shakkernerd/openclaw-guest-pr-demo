# E6 harbor: coordinator start guide

This branch provides the **transfer companion**, a local browser app for importing, inspecting, correcting and archiving a volunteer rota. It is usable on its own. **It is not yet connected to the scheduling app in [PR #23](https://github.com/shakkernerd/openclaw-guest-pr-demo/pull/23).** A shared folder name and `version: 1` do not mean shared file formats.

## 1. Start the companion

From the repository root, with Node.js 22 or newer:

```sh
node e6-harbor/transfer/server.mjs
```

Open **http://127.0.0.1:4173/** in a modern browser. Keep the terminal running; Ctrl+C stops the server. If that port is occupied, use `PORT=4174 node e6-harbor/transfer/server.mjs` and open port 4174. No installation, account, internet service or build is needed. The server listens only on this computer and serves only the companion assets. Do not double-click the HTML file: its JavaScript modules require HTTP.

The page starts empty. Choose **Try a sample rota** to explore without using personal information, or choose your own file. Example downloads are also available in the app and in [transfer/examples](transfer/examples/). All shipped people and rota details are synthetic.

## 2. Import without replacing work accidentally

1. **Export your current work first** if you want an independent backup. Import replacement has only one undo checkpoint, not a history of every rota.
2. Choose a UTF-8 CSV or JSON file, at most **2 MiB**, in the companion's documented format. See the [exact schema and CSV record types](transfer/README.md#lossless-v1-interchange). Arbitrary spreadsheet columns and scheduler storage snapshots are not accepted.
3. Review the preview counts. Choosing a file does not immediately change the current rota.
4. Choose **Replace current rota** only when ready, or **Cancel import** to keep your existing work. This replaces the whole rota; it does not merge records.
5. A malformed/unsupported file produces a focused error. Your current rota and previous meaningful undo stay intact; fix the source file and choose it again. Unknown fields are rejected, never quietly discarded.

CSV has separate volunteer, shift and assignment records, so people without assignments and shifts without crew are retained. Quoted names, commas, Unicode, spaces and quoted multiline text are supported. Keep IDs stable when correcting source files: two people with identical names are still different people.

## 3. Inspect and correct accessibly

Search by name, role, date or ID. Open a volunteer or shift's labeled edit button. Use **Tab / Shift+Tab** between controls, **Space** for assignment checkboxes and the labeled **Save changes** button to commit. Dates are calendar dates and times are harbor-local 24-hour times; there is no timezone conversion. A shift must end after it starts on the same date.

- Labels and errors identify the field; invalid changes keep the editor open and focus the error.
- **Cancel** or **Escape** closes the editor without saving its draft. Escape also cancels the whole editor if a removal confirmation is open.
- Removal asks again and initially focuses **Keep record**. Removing a volunteer also removes that person's assignment links; removing a shift removes its crew links, not the volunteers.
- **Undo last change** restores one previous meaningful save, import or removal. Merely inspecting and saving unchanged values, an identical reimport, an export, or a failed/cancelled import does not consume that checkpoint.
- Layout and dialogs support narrow screens. Native keyboard checks are included, but this is not a complete screen-reader certification.

## 4. Save a recoverable archive

**The companion keeps changes only in this tab's memory. Reloading or closing loses them.** Browser local storage in the separate scheduling app does not save this companion's work.

1. Choose **Export JSON** for the usual archive, or **Export CSV** for the companion's CSV format.
2. Confirm the download actually finished and keep it in a known folder, preferably with a date in the filename. An app download message is not proof that your browser kept the file.
3. To verify an archive, leave the working tab open and open the companion in another tab. Import the downloaded file, confirm the preview, and inspect the expected people, shifts and crew. Do not close the working tab until satisfied.
4. Near the size limit, JSON may be compact and CSV may use LF record separators; values remain intact. If one export format would exceed the import limit, no unusable file is downloaded: the focused error directs you to the other format. Changes exceeding both formats' capacity are rejected before altering the rota or undo.

A leave-page warning is requested after changes, including after export, but browsers may suppress it. **Do not rely on the warning as a backup.** Lossless CSV preserves formula-looking text too; when using spreadsheets, import every column as text instead of executing formulas. Prefer JSON for archives.

## 5. What works together, and what does not

Reviewed scheduling target: **PR #23, head `5cf53e2dbeffc45727577f4fe653b1404098dd90`**. See the [compatibility findings and evidence](transfer/COMPATIBILITY.md).

**Working now:** the companion round-trips its own volunteers, names, shift dates/times/roles and assignment links through CSV and JSON. Its editor and archive workflow are standalone. The scheduler's own design provides weekly planning, eligibility, recurring availability, coverage and browser persistence; those useful constraints should be retained in a later combination.

**Not working integration:** neither app currently offers an end-to-end file exchange with the other. Scheduler JSON has a top-level `assignments` collection and richer volunteer/shift records; companion JSON embeds `volunteerIds` in shifts. The companion has no fields for availability, volunteer qualifications, notes, shift titles/capacity or assignment IDs. Simply deleting those fields would lose useful scheduling data. Hiding them in arbitrary scheduler extension fields is not safe either: known-field edits can replace records and drop those extras. Do not treat a common-field projection as a full archive, invent availability/qualifications, paste one format into the other's browser storage, or assume equal version numbers make them compatible.

Until a deliberate bridge is approved, use the tools separately and retain each one's original data. A later bridge needs a versioned full-fidelity contract, explicit handling of unsupported values and IDs, preview/confirmation, and whole-state scheduling validation before replacing memory or storage. Test round trips in both directions, including availability and unassigned records, plus rejection/undo/storage recovery.

**Combining branches later:** this guide and PR #23 both add `e6-harbor/README.md`, so an add/add conflict is expected. Preserve the scheduler's run instructions, safety rules and evidence alongside this companion guide; do not resolve by choosing one entire file. Keep its core, UI, storage, tests and build approach. Keep the companion under `transfer/`; its loopback server does not currently serve the scheduler. Decide routing/storage ownership deliberately and rerun both suites and real browser transfer checks. This branch does not modify or merge PR #23.

## Checks and limits

From the repository root:

```sh
node --test
node e6-harbor/transfer/validate.mjs
node e6-harbor/transfer/browser-check.mjs
```

The browser check uses an already installed Chromium (set `CHROME_BIN` if needed), never downloads one. Validation checks real syntax, assets, examples and HTTP behavior; this unbundled app needs no packaging build. [Transfer README](transfer/README.md) contains the full schema and test procedures.

Limits: companion-specific v1 schema, 2 MiB files, memory-only data, one-level undo, same-day shifts, no accounts/sync, automatic scheduling or qualification/availability/capacity/overlap checks in the companion. File format preservation is not a claim that an assignment is operationally safe. Only synthetic data is committed.
