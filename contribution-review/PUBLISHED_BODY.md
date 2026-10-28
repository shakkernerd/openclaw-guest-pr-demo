## What Problem This Solves

The repository currently provides a parcel-label helper but no interface for reviewing a set of JSON records. Record Desk adds a local review workspace where records can be inspected, assigned a decision, annotated, and exported without a server or external assets.

## User Impact

Open `index.html` directly or in Files, then import records with unique string IDs and titles. Reviewers can approve, reject, request follow-up, or leave a record unreviewed, add notes, and combine title/ID search with a decision filter. Export includes every accepted record and its review, regardless of the current filter. Additional record fields are retained.

Invalid imports preserve accepted work. Reimported record arrays retain decisions and notes for matching IDs; omitted IDs are removed, while a review export restores its exact snapshot. Browser storage restores work when available. Embedded Files can block storage and downloads, so the app explains its memory-only state and provides selectable export JSON. A download request is never described as a confirmed save.

## Why This Change Was Made

A shared state module owns validation and review transitions, with a small DOM adapter and HTML/CSS template. A dependency-free Node build script produces the included standalone HTML, allowing the same app to work in restrictive previews without relative asset requests. The existing `parcelLabel` API and its original tests are unchanged. No service, dependency, or Files sandbox-policy change is introduced.

The README documents stable-ID reconciliation, replacement semantics, storage limitations, and the build/check commands. Browser storage is a convenience rather than a backup; the app is intended for modest datasets and one review tab at a time.

## Evidence

The standard `node --test` run passed 32 checks with four optional browser scenarios explicitly skipped. Selecting the already-installed Chromium ran all 36 checks successfully, including actual reload restoration, blocked/corrupt/quota-limited storage, restrictive iframe operation, overlapping file reads, safe text rendering, and export fallback. Preview freshness, JavaScript syntax, and whitespace checks also passed.

Actual Files interaction confirmed four-record import, approval and note editing, combined search/filter behavior, and duplicate-ID rejection without data loss. The downloaded standalone app restored the review after a real reload and exported the expected JSON file, with no network requests or page errors observed. Independent engineering review and publication of the captured visual evidence are in progress; no hosted-check result is claimed here.

<!-- openclaw-publication:9b51554c-6542-4bd2-8291-6227d953503e -->