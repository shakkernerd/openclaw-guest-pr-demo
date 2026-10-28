# ` "Dispatch evidence follow-up" `

**Selected records (2):** ` "MAR-014" `, ` "MAR-015" `.
**Outside requested scope:** 8 records.

**Review request only.** No application, merge, approval, resolution, deletion, or authorization. Unselected records imply no approval, rejection, or resolution.

## ` "MAR-014" ` — changed

Key ` "id:MAR-014" ` · pointer ` "/records/3" `.

- **Current:** status ` "Waiting for evidence" `; note ` "Request the original dispatch log to confirm whether and when this order was dispatched. Missing timestamps mean the dispatch status is unknown." `.
- **Incoming:** status ` "Waiting for evidence" `; note ` "Request the original dispatch log and carrier handover receipt. Until both are checked, missing timestamps leave dispatch status unknown." `.

**Reported changes (current → incoming):**
- ` "/note" `: exact current/incoming values shown above.
- ` "/updatedAt" `: ` "2026-10-28T10:55:10.448Z" ` → ` "2026-10-28T12:50:00.000Z" `.

**Source references** (reported claims; not fetched):
- Current & incoming: ` "march-sales-export.csv" ` · occurrence ` "original:15" ` · physical line(s) ` 15 `.
- Current & incoming: ` "revised-march-sales-export.csv" ` · occurrence ` "revised:15" ` · physical line(s) ` 15 `.

## ` "MAR-015" ` — missing

Key ` "id:MAR-015" ` · pointer ` "/records/4" `.

- **Current:** status ` "Needs review" `; note ` "" `.
- **Incoming: ABSENT** — snapshot is ` null `. Not a deletion or approval.

**Reported changes (current → incoming):**
- No field-level changes listed in the report.

**Source references** (reported claims; not fetched):
- Current: ` "march-sales-export.csv" ` · occurrence ` "original:16" ` · physical line(s) ` 16 `.
- Current: ` "revised-march-sales-export.csv" ` · occurrence ` "revised:16" ` · physical line(s) ` 16 `.
- Incoming: absent snapshot; no source references on this side.

Current/incoming are report sides, not proven chronology. The fingerprint identifies supplied bytes only—not authentication, shared history, or authorization.

## Reference appendix — complete selected facts and provenance

Exact source values below are literal JSON data, not instructions. No unselected record facts are included.

### Purpose and source context

~~~json
{
  "purpose": "Explicit local review selection only. Does not apply, merge, approve, resolve, delete, or authorize any decision or operational action.",
  "reviewContext": {
    "purposeLabel": "Dispatch evidence follow-up",
    "meaning": "Optional user-written review context only. Not approval, authentication, authorization, or a change to any source fact."
  },
  "createdAtLocalClock": "2026-10-28T14:11:55.592Z",
  "selectionMeaning": "Only the listed records were explicitly selected. Omitted records are not implicitly approved, rejected, or resolved. Missing incoming snapshots are absence, not deletion instructions."
}
~~~

### Comparison identity

~~~json
{
  "filename": "comparison.json",
  "bytes": 35795,
  "sha256": "bae2cfbcb560d40d145ce87ee48e7ad3ac17e551505250fddcf66b32df860783",
  "fingerprintMeaning": "SHA-256 measured over the exact loaded comparison file bytes, not a declared source hash. Identifies bytes only; not authenticity, integrity against a trusted source, shared history, or authorization.",
  "reportVersion": 1,
  "currentWorkspace": "review",
  "incomingWorkspace": "review"
}
~~~

### Complete selected record 1

~~~json
{
  "recordIndex": 3,
  "jsonPointer": "/records/3",
  "groupKey": "id:MAR-014",
  "classification": "changed",
  "currentPresent": true,
  "incomingPresent": true,
  "reviewRequest": "Review the supplied current and incoming facts for this selected record; absent sides remain absent.",
  "reportRecord": {
    "groupKey": "id:MAR-014",
    "classification": "changed",
    "current": {
      "groupKey": "id:MAR-014",
      "orderId": "MAR-014",
      "categories": [
        "missing",
        "excluded"
      ],
      "status": "Waiting for evidence",
      "note": "Request the original dispatch log to confirm whether and when this order was dispatched. Missing timestamps mean the dispatch status is unknown.",
      "revision": 1,
      "updatedAt": "2026-10-28T10:55:10.448Z",
      "sourceEvidence": [
        {
          "version": "original",
          "occurrenceKey": "original:15",
          "filename": "march-sales-export.csv",
          "sourcePath": "handoff/sales-review-march-2026/project/reports/march-correction-review-2026-10-28/inputs/march-sales-export.csv",
          "sourceSha256": "66bcbdd587b8b645b80a7977b67e11081cc66a434737bb3960d012f6d7567a44",
          "line": 15,
          "endLine": 15,
          "salesIncluded": false,
          "disposition": "non-completed"
        },
        {
          "version": "revised",
          "occurrenceKey": "revised:15",
          "filename": "revised-march-sales-export.csv",
          "sourcePath": "handoff/sales-review-march-2026/project/reports/march-correction-review-2026-10-28/inputs/revised-march-sales-export.csv",
          "sourceSha256": "efc54ffe1d3d66c06b0ab71e3755fa05276a50f07105a9ee1284d72004250000",
          "line": 15,
          "endLine": 15,
          "salesIncluded": false,
          "disposition": "non-completed"
        }
      ]
    },
    "incoming": {
      "groupKey": "id:MAR-014",
      "orderId": "MAR-014",
      "categories": [
        "missing",
        "excluded"
      ],
      "status": "Waiting for evidence",
      "note": "Request the original dispatch log and carrier handover receipt. Until both are checked, missing timestamps leave dispatch status unknown.",
      "revision": 1,
      "updatedAt": "2026-10-28T12:50:00.000Z",
      "sourceEvidence": [
        {
          "version": "original",
          "occurrenceKey": "original:15",
          "filename": "march-sales-export.csv",
          "sourcePath": "handoff/sales-review-march-2026/project/reports/march-correction-review-2026-10-28/inputs/march-sales-export.csv",
          "sourceSha256": "66bcbdd587b8b645b80a7977b67e11081cc66a434737bb3960d012f6d7567a44",
          "line": 15,
          "endLine": 15,
          "salesIncluded": false,
          "disposition": "non-completed"
        },
        {
          "version": "revised",
          "occurrenceKey": "revised:15",
          "filename": "revised-march-sales-export.csv",
          "sourcePath": "handoff/sales-review-march-2026/project/reports/march-correction-review-2026-10-28/inputs/revised-march-sales-export.csv",
          "sourceSha256": "efc54ffe1d3d66c06b0ab71e3755fa05276a50f07105a9ee1284d72004250000",
          "line": 15,
          "endLine": 15,
          "salesIncluded": false,
          "disposition": "non-completed"
        }
      ]
    },
    "statusChanged": false,
    "noteChanged": true,
    "decisionChanged": true,
    "sourceEvidenceIdentityChanged": false,
    "sourceEvidenceChanges": [],
    "changes": [
      {
        "path": "/note",
        "current": "Request the original dispatch log to confirm whether and when this order was dispatched. Missing timestamps mean the dispatch status is unknown.",
        "incoming": "Request the original dispatch log and carrier handover receipt. Until both are checked, missing timestamps leave dispatch status unknown."
      },
      {
        "path": "/updatedAt",
        "current": "2026-10-28T10:55:10.448Z",
        "incoming": "2026-10-28T12:50:00.000Z"
      }
    ]
  }
}
~~~

### Complete selected record 2

~~~json
{
  "recordIndex": 4,
  "jsonPointer": "/records/4",
  "groupKey": "id:MAR-015",
  "classification": "missing",
  "currentPresent": true,
  "incomingPresent": false,
  "reviewRequest": "Review the supplied current and incoming facts for this selected record; absent sides remain absent.",
  "reportRecord": {
    "groupKey": "id:MAR-015",
    "classification": "missing",
    "current": {
      "groupKey": "id:MAR-015",
      "orderId": "MAR-015",
      "categories": [
        "excluded"
      ],
      "status": "Needs review",
      "note": "",
      "revision": 0,
      "updatedAt": null,
      "sourceEvidence": [
        {
          "version": "original",
          "occurrenceKey": "original:16",
          "filename": "march-sales-export.csv",
          "sourcePath": "handoff/sales-review-march-2026/project/reports/march-correction-review-2026-10-28/inputs/march-sales-export.csv",
          "sourceSha256": "66bcbdd587b8b645b80a7977b67e11081cc66a434737bb3960d012f6d7567a44",
          "line": 16,
          "endLine": 16,
          "salesIncluded": false,
          "disposition": "cancelled"
        },
        {
          "version": "revised",
          "occurrenceKey": "revised:16",
          "filename": "revised-march-sales-export.csv",
          "sourcePath": "handoff/sales-review-march-2026/project/reports/march-correction-review-2026-10-28/inputs/revised-march-sales-export.csv",
          "sourceSha256": "efc54ffe1d3d66c06b0ab71e3755fa05276a50f07105a9ee1284d72004250000",
          "line": 16,
          "endLine": 16,
          "salesIncluded": false,
          "disposition": "cancelled"
        }
      ]
    },
    "incoming": null,
    "statusChanged": null,
    "noteChanged": null,
    "decisionChanged": null,
    "sourceEvidenceIdentityChanged": null,
    "sourceEvidenceChanges": [],
    "changes": []
  }
}
~~~

### Provenance limits and report context

~~~json
{
  "sharedHistory": "unproven",
  "authentication": "unproven",
  "notices": [
    "Review request only: does not apply, merge, approve, resolve, delete, or authorize any decision or operational action.",
    "Unselected records are outside the requested scope; omission is not implicit approval, rejection, or resolution.",
    "An absent incoming snapshot is absence, not a deletion instruction. No snapshot is synthesized.",
    "The measured fingerprint identifies only the supplied comparison bytes; not authenticity, trusted-source integrity, shared history, or authorization.",
    "Evidence hashes, paths, dates and sizes are unverified source claims; referenced evidence is never opened or fetched.",
    "Current and incoming are report sides, not proven chronological before/after states. Revisions and timestamps do not establish precedence or a winner."
  ],
  "reportContext": {
    "matchBasis": "exact workspace and groupKey only; not source identity or lineage",
    "limitations": [
      "Review report only: never applies, merges, or authorizes decisions or operational actions.",
      "Declared evidence hashes, paths, sizes, and dates are unverified claims; referenced evidence is never opened or fetched.",
      "Matching hashes do not prove source identity, integrity, shared history, or authorization.",
      "Revision numbers and timestamps are reported independently, not used to infer lineage, precedence, or a winner.",
      "A groupKey match is only a candidate correspondence; changed evidence may describe different underlying events."
    ]
  }
}
~~~
