## What Problem This Solves

The repository currently provides a parcel-label helper but no interface for reviewing a set of JSON records. Record Desk adds a local review workspace where records can be inspected, assigned a decision, annotated, and exported without a server or external assets.

## User Impact

Open `index.html` directly or in Files, then import records with unique string IDs and titles. Reviewers can approve, reject, request follow-up, or leave a record unreviewed, add notes, and combine title/ID/review-note search with a decision filter. Notes apply as you type; leaving the notes field refreshes the matching list and count without changing the record being edited. If it no longer matches, it stays open with a notice so further edits are not silently applied to another record. All buttons and disclosure summaries share one note-exit path: the native click finishes the note before the action, keeping record, decision, export/copy, download, and details controls stable through mouse-up without a timing delay or click replay. Export includes every accepted record and its review, regardless of the current filter. Additional record fields are retained.

Invalid imports preserve accepted work. Reimported record arrays retain decisions and notes for matching IDs; omitted IDs are removed, while a review export restores its exact snapshot. Browser storage restores work when available. Embedded Files can block storage and downloads, so the app explains its memory-only state and provides selectable export JSON. A download request is never described as a confirmed save.

## Why This Change Was Made

A shared state module owns validation and review transitions, with a small DOM adapter and HTML/CSS template. A dependency-free Node build script produces the included standalone HTML, allowing the same app to work in restrictive previews without relative asset requests. The existing `parcelLabel` API and its original tests are unchanged. No service, dependency, or Files sandbox-policy change is introduced.

The README documents stable-ID reconciliation, replacement semantics, storage limitations, and the build/check commands. Browser storage is a convenience rather than a backup; the app is intended for modest datasets and one review tab at a time.

## Evidence

The standard `node --test` run passed 33 checks with ten optional browser scenarios explicitly skipped. Selecting the already-installed Chromium ran all 43 checks successfully, including actual reload restoration, blocked/corrupt/quota-limited storage, restrictive iframe operation, overlapping file reads, safe text rendering, and export fallback. Preview freshness, JavaScript syntax, and whitespace checks also passed. Focused regression coverage verifies case-insensitive, trimmed review-note search combined with decision filters, updated and restored notes, unchanged full exports, and caret preservation while editing. Standalone real-focus/blur and restrictive-iframe checks cover note-finish list/count refresh, retaining the edited record with zero or other matches, re-entering the results, explicit record selection, and keeping subsequent notes and decisions on the intended record. Trusted-pointer regressions press and release at fixed coordinates to verify first-click record selection, Reject targeting, export selection, download requests, and native record/export disclosures, with stable target positions through press, drag-away cancellation, and immediate keyboard-blur refresh. The download regression verifies the requested JSON blob, not a confirmed disk save.

Actual Files interaction confirmed four-record import, approval and note editing, combined search/filter behavior, and duplicate-ID rejection without data loss. The downloaded standalone app restored the review after a real reload and exported the expected JSON file, with no network requests or page errors observed. Independent re-review is paused pending direction, and publication of the captured visual evidence remains pending; no hosted-check result is claimed here.

<!-- openclaw-publication:9b51554c-6542-4bd2-8291-6227d953503e -->