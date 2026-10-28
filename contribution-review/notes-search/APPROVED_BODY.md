## What Problem This Solves

The repository provides a parcel-label helper but no interface for reviewing a set of JSON records. Record Desk adds a local workspace where records can be inspected, assigned a decision, annotated, and exported without a server or external assets.

## User Impact

Open `index.html` directly or in Files, then import records with unique string IDs and titles. Reviewers can approve, reject, request follow-up, or leave records unreviewed, add notes, and combine title/ID/note search with a decision filter. Export includes every accepted record and review, regardless of the filter, and retains additional record fields.

Invalid imports preserve accepted work. Reimported arrays retain reviews for matching IDs and remove omitted IDs; importing a review export restores its exact snapshot. Browser storage restores work when available. Embedded Files can block storage and downloads, so the app explains its memory-only state and offers selectable JSON. A download request is never described as a confirmed save.

Notes save as they are typed, while matching results refresh when editing finishes. A record that stops matching stays open with a clear notice. Record selection, decisions, export controls, and disclosures honor the first intended click without moving its target mid-gesture or applying notes to another record.

## Why This Change Was Made

A shared state module owns validation and review transitions, with a DOM adapter and HTML/CSS template. A dependency-free Node build script produces the included standalone HTML so restrictive previews need no relative asset requests. The existing `parcelLabel` API and original tests are unchanged. No service, dependency, or Files sandbox-policy change is introduced.

The README explains import replacement and reconciliation, browser-storage limits, and build/check commands. Storage is a convenience rather than a backup; the app is intended for modest datasets and one review tab at a time. A shared note-finish activation path handles buttons and disclosures without timers, click replay, or activation on pointer-down.

## Evidence

`node --test` passed 33 checks with ten optional browser scenarios explicitly skipped. Selecting the already-installed Chromium ran all 43 checks with no failures or skips. Preview freshness, JavaScript syntax, and whitespace checks passed. Coverage includes atomic rejection, stable-ID reconciliation, export round trips, blocked/corrupt/quota-limited storage, actual reload restoration, restrictive iframe behavior, overlapping file reads, and safe text rendering.

Actual Files interaction verified import, review decisions and notes, combined filtering, rejection without data loss, and complete selectable export under its unchanged restrictions. In a normal browser, the downloaded app restored saved work and produced the expected JSON file, which was inspected and reimported. No app network request or page error was observed.

Independent engineering review is clean on the final checked source. Its pointer finding was reproduced with ordinary trusted mouse input and corrected across record, decision, export, download, and disclosure controls. Focused checks preserve canceled gestures, keyboard behavior, caret position, notes, and record targeting. The browser regression checks a requested download payload; separate real-browser verification confirmed an actual downloaded file. No hosted CI result is claimed.

### Visual evidence

The original repository had no review screen; its existing documentation is retained as the baseline.

<details>
<summary>Repository before the app</summary>

![Existing parcel-helper documentation](https://github.com/user-attachments/assets/717a388c-bded-4146-ac48-d4d6e7b06749)

</details>

The completed interface:

![Record Desk with four imported records, a decision, and a saved note](https://github.com/user-attachments/assets/2bdb8479-f347-4667-b769-67816fb76a51)

An intermediate refinement exposed the first-click export issue. These matching panel captures use the same fixture and dimensions; the final click focuses and selects the complete JSON.

| Before correction: first click misses selection | Final behavior: complete JSON selected |
| --- | --- |
| ![Unfocused export after the missed first click](https://github.com/user-attachments/assets/c4719ddd-31d5-4293-b229-bf29150104aa) | ![Focused full export selection after one click](https://github.com/user-attachments/assets/de7a0f62-34c3-40ef-a149-37a21577cfb6) |

Focused final-source recording of export selection, download, and details actions with edited notes focused:

https://github.com/user-attachments/assets/22fa7cdc-da70-4abd-a03e-3584e17da2e6

<!-- openclaw-publication:9b51554c-6542-4bd2-8291-6227d953503e -->