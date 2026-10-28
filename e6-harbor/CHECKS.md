# Initial contribution verification record

This records the initial contribution. For the subsequent local copy-week feature and its current checks, see `COPY-WEEK-CHECKS.md`.

Run in this workspace on 2026-10-28 using Node.js v24.22.1 and the already installed Google Chrome for Testing 156.0.8078.4. No dependency installation, browser download, or web server.

| Check | Observed result |
| --- | --- |
| `node --test e6-harbor/tests/*.test.js` | 26 passed, 0 failed, 0 skipped |
| `node --test` (final full run) | 29 passed: 26 app tests + 3 existing tests; 0 failed/skipped |
| `node e6-harbor/scripts/build.cjs` | 5 static assets verified and packaged byte-for-byte; SHA-256 manifest generated |
| `node e6-harbor/scripts/browser-check.cjs` | 22/22 passed against source, with page networking forced offline |
| `HARBOR_APP_DIR=e6-harbor/dist node e6-harbor/scripts/browser-check.cjs` | 22/22 passed against the packaged app |
| Browser request/error inspection | No app network requests, page exceptions, or console errors in the final runs |
| SHA-256 comparison to pre-build snapshot | All 7 original tracked files unchanged |

## Busy-week coordinator walkthrough

The real Chromium app was exercised through rendered forms, not a mock DOM. Screenshots of the actual conflict, availability, assignment, recovery, and narrow layouts were inspected.

- Moved assigned Harbor opening from 08:00–10:00 to 09:30–10:30, conflicting with Maya’s Welcome desk assignment. The edit was rejected; the **entire localStorage snapshot and rendered schedule** were unchanged, including after reload. The message now explicitly says no changes applied, names the conflicting shift/date/time, and suggests changing time or removing/reassigning crew.
- Moved Welcome desk to 12:00–14:00 and replaced Maya with Theo immediately after his 09:00–12:00 launch assignment. Back-to-back reassignment succeeded.
- Tried removing Ben’s required role and reducing his availability below the assigned shift end. Both rejected changes preserved the entire saved snapshot. Adding a qualified role and changing availability to a valid window succeeded.
- Filled Shore tidy-up, then removed the new assignment. Counts moved 1/2 → 2/2 → 1/2 and the full saved snapshot returned to its prior valid value. Reload restored both the exact data and rendered rota.
- Exercised populated/full crew dialogs with Enter and auto-repeat Enter. Safe initial/post-mutation focus never lands on Remove, is visible within the scrolling dialog, and confirmation is in a modal live region.
- Loaded previously domain-valid but unrenderable 9999-12-27 through 9999-12-31 snapshots. They now show recoverable protected-data warnings, retain original bytes, and render a temporary demo without exceptions. Both supported boundary dates render complete seven-day weeks.

## Findings corrected during verification

Actionable conflict remedies and explicit rollback wording were added after a real failing coordinator test. Independent review reproduced destructive initial/updated crew-dialog focus and accepted-but-unrenderable upper-bound dates; both received dedicated regressions. Visual follow-up also removed suppressed scrolling that could hide safe focus, and clarified temporary-versus-persisted startup status. Browser checks wait for the native dialog-close rendering lifecycle before asserting restored focus; that timing race was not an application defect.

This is not a complete screen-reader audit or cross-browser certification. All views/editors were checked at 320px and 360px; independent review also challenged scheduling rules and keyboard behavior in an isolated source snapshot. See `REVIEW.md` for the review outcome and source hashes. Companion compatibility remains unverified: see the explicit blocker and alignment questions in `INTEGRATION.md`.

Raw final output is retained locally in ignored `artifacts/`: `unit-checks.txt`, `build-check.txt`, `browser-source-checks.txt`, and `browser-package-checks.txt`, along with screenshots. Exact commands and intentional limitations are in `README.md`.
