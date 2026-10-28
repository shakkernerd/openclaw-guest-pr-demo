## Summary
Add Record Desk, a self-contained offline app in `index.html`. Open it directly or in the Files preview; no server, dependency, installation, external assets, or network requests are needed.

- Import a JSON file or pasted array with unique string IDs and titles; retain additional record fields.
- Approve, reject, flag for follow-up, or return records to unreviewed; add notes and combine title/ID search with decision filters.
- Validate imports before replacing accepted work. Reimported arrays retain reviews by matching ID; omitted IDs are removed. Review exports restore an exact snapshot. Invalid imports and stale asynchronous file reads cannot replace accepted work.
- Restore browser-saved reviews when storage is available; export all records, decisions, and notes regardless of filters.

## Compatibility and structure
The existing `parcelLabel(count)` CommonJS API, behavior, and all three parcel tests are unchanged. State logic, DOM code, and the HTML/CSS template are separate; a built-in-Node-only script produces the included standalone preview. The README documents usage, import semantics, and checks. No sandbox policy, service, dependency, or environment configuration changes.

## Local verification
- `node --test`: 32 passed; four optional browser scenarios explicitly skipped.
- The same suite with the preinstalled Chromium selected via `RECORD_REVIEW_BROWSER`: **36 passed, zero failures or skips**. The isolated container used the documented process-only `RECORD_REVIEW_BROWSER_NO_SANDBOX=1` option; iframe permissions were not relaxed.
- Tests cover atomic rejection, stable-ID reconciliation, export round trips, blocked/corrupt/quota-limited storage, real reload restoration, restrictive iframe operation, file-read races, safe text rendering, and export fallbacks.
- `node build-review.js --check`, `node --check` for the five added JavaScript files, and staged-diff whitespace checks passed.
- Files preview smoke check confirmed four-record import, approval and notes, combined search/filter, duplicate-ID rejection without data loss, the memory-only warning, and selectable export.

## Embedded preview limitations
Files previews may deny browser storage and silently block downloads. The app remains usable in memory, warns users to export before closing/reloading, and offers selectable JSON for manual copying. Download requests are explicitly **not confirmed saves**. Browser storage is a convenience, not a backup; direct-file persistence also varies by browser. The existing Files sandbox policy is unchanged.
