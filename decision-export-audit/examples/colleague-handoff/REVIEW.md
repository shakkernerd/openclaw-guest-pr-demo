# Operations review: simulated colleague handoff

**Review only — nothing was applied to the tracker.** The actual CLI exited 0
with no stderr or diagnostics: **7 unchanged, 2 changed, 0 added, 1 missing**.
Current has 10 decisions; incoming has 9. The seven unchanged decisions are
MAR,007, MAR-003, MAR-013, MAR-CUR, MAR-DATE, MAR-PRICE, and MAR-QTY.

[comparison.json](comparison.json) is the unmodified 35,795-byte CLI stdout, not
a hand-built report. The following status/note values are quoted exactly; `""`
means an empty note, whereas `incoming: null` means the entire record is absent.

## MAR-014 — changed note, unchanged status and revision

```json
{
  "current": {
    "status": "Waiting for evidence",
    "note": "Request the original dispatch log to confirm whether and when this order was dispatched. Missing timestamps mean the dispatch status is unknown."
  },
  "incoming": {
    "status": "Waiting for evidence",
    "note": "Request the original dispatch log and carrier handover receipt. Until both are checked, missing timestamps leave dispatch status unknown."
  }
}
```

The incoming request adds the carrier handover receipt. Revision is **1 → 1**;
that did not hide the note change. updatedAt is
`2026-10-28T10:55:10.448Z` → `2026-10-28T12:50:00.000Z`.
The sender identifies this as an independent copy; the file itself cannot prove
ancestry. Neither equal revisions nor the later timestamp establishes shared
history, precedence, or permission to apply the request.

## MAR-DUP — changed status and note

```json
{
  "current": {
    "status": "Needs review",
    "note": ""
  },
  "incoming": {
    "status": "Waiting for evidence",
    "note": "Request the individual invoices for each duplicate occurrence before deciding which records need correction; keep all source occurrences visible."
  }
}
```

Revision is **0 → 1**; updatedAt is `null` → `2026-10-28T12:50:00.000Z`.
All three source occurrences remain visible and unchanged: `original:17`,
`original:18`, and `revised:17`. No duplicate occurrence was discarded or chosen
as the correct invoice/order, and no operational correction was made.

## MAR-015 — missing from incoming, not a deletion instruction

```json
{
  "current": {
    "status": "Needs review",
    "note": ""
  },
  "incoming": null
}
```

The current record has revision 0, updatedAt null, and source occurrences
`original:16` and `revised:16`; it remains intact in the current-side snapshot.
Missing means only “present in current, absent from this handoff.” It does not
mean approved, resolved, cancelled, removed from the tracker, or changed to an
empty/null status or note. Confirm the omission with the colleague before any
separate follow-up; this report does not authorize a deletion or other action.

## Evidence and provenance limits

- Root evidence declarations compare equal (`evidenceChanged: false`). Every
  occurrence in the 9 matched decisions is unchanged (19 matched occurrences).
- `sourceEvidenceIdentityChanged: false` covers matched decisions only. The
  current export has 21 occurrences versus incoming 19 because MAR-015 is
  omitted. That flag does not claim globally identical membership.
- Current and incoming declarations/snapshots remain separate. CSV/report/source
  paths were not opened; source bytes, authenticity, and declared hash construction
  were not verified. Matching declared hashes are not authorization.
- `sharedHistory: "unproven"` is intentional. Measured input-file fingerprints
  below identify the bytes compared, not a trusted author or shared lineage.
- Both attachments and both fixture copies are preserved byte-for-byte.

## Inputs and reproduction

Current: `../../test/fixtures/review-decisions-review.json` — **10,874 bytes**; SHA-256
`1d3119bcc05c601dcae42c79cd1e22d0765300d2ce90138b8e4d47483ee7151d`.

Incoming: `../../test/fixtures/incoming-review-decisions.json` — **13,709 bytes**; SHA-256
`a5b3582c51aede5a77e535783f2caebb8ba26b50c893635c1d351414f5d9bf66`.

From the repository root, reproduce the actual CLI output on stdout:

```sh
node decision-export-audit/bin/decision-export-audit.js compare decision-export-audit/test/fixtures/review-decisions-review.json decision-export-audit/test/fixtures/incoming-review-decisions.json
```

To capture/verify it without shell redirection:

```sh
node decision-export-audit/examples/colleague-handoff/capture.js
```

The fixed example helper checks pinned input bytes, invokes the real CLI, and
checks inputs again. It creates only `comparison.json` if absent, accepts an
already-identical report without rewriting it, and refuses to overwrite a
different report. It takes no arguments; it never selects an input as output.
The comparison library/CLI itself still performs no filesystem writes.
