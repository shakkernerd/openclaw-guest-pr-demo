# Saved batch-report comparison verification

Verified 2026-10-30. Changes intentionally left uncommitted; no publication.

## Scope and starting point

The supplied reviewed integration patch was applied before comparison work.
Existing single-report CSV logic and its focused tests retain that patch's
behavior. The validator production file has no diff. The single-report HTML
adds only a navigation link beyond the reviewed integration; README adds the
comparison contract and verification instructions.

The new standalone entry is `saved-batch-comparison.html`. It reuses the existing
`savedBatchReportCodec` and `SavedBatchReport` acceptance boundary, adds a pure
occurrence comparator/controller, and renders literal before/after fields.
There is no comparison CLI/export, new report schema, app dependency, or network
service. No formatter or draft codec is loaded by comparison.

## Focused automated checks

```sh
node --test saved-batch-comparison.test.js saved-batch-report.test.js validate-address-report.test.js
```

Result: **142 tests passed, 0 failed** (131 integration baseline checks plus 11
comparison tests, with additional cases exercised within those tests).

Coverage includes full-report unique-path counts; exact spelling; no inferred
restaging matches; asymmetric and partially mapped duplicate groups; one-to-one
mapping refusal; all six paired outcomes; exact strings and full error tuples;
unknown fields ignored; unchanged accepted snapshots; empty inputs; independent
read generations; stale success/invalid/error completion; accepted replacement
on either side; and comparison independence from report filtering or rereads.

The two supplied reports are retained byte-for-byte as fixtures, with asserted
SHA-256 values:

- `comparison-original.json`: `2f5788a7894330892e9fdba1c3cf0048bc74954e7734e8644378453e7555e498`
- `comparison-rerun.json`: `da6ed57e9bc272253356c944b94e5d8a914b15b241ebd81627ae9613112e973d`

## Actual browser/data checks

`saved-batch-comparison.browser-check.js` passed in real headless Chromium
156.0.8078.4, opening the production pages via `file://` in an offline context.
Playwright was used only as external test tooling, not added to the app.

Observed with native file inputs and the supplied reports:

| State | Paired | Original-only, not reverified | Rerun-only |
| --- | ---: | ---: | ---: |
| Before explicit mappings | 0 | 5 | 2 |
| After user-confirmed 2→1 and 4→2 | 2 | 3 | 0 |

Both pairs are labelled explicit user mappings and recorded failure→success.
Original occurrences 1, 3, and 5 remain original-only; the two north occurrences
remain separate. No unchanged successes are claimed. Two unpaired north
occurrences also carry the duplicate-ambiguity flag; this is a subset of the
three original-only occurrences, not two extra rows.

The browser harness also verified:

- Filters preserve full counts and do not reread files; conflicts do not alter
  mappings. Tab moves through mapping controls and Enter submits a mapping.
- Invalid/read-failed/pending/cancelled selections and stale completion retain
  mappings and comparison row nodes on either side. New acceptance on either
  side (including the same file) clears mappings. Explicit removal works.
- Remaining duplicates are not auto-paired after one explicit mapping. All six
  paired outcomes render, including still-failed with changed error. Path and
  position changes remain separate. Case and `./` differences are not normalized.
- Exact DOM text preserves Unicode, FEFF, CRLF/LF, quotes, whitespace, and
  formula-like paths. HTML-like input stays text, not elements or requests.
  Escaped-string disclosures reveal exact line endings; unknown fields are ignored.
- Empty accepted reports differ from missing inputs and filters with no matches.
- At 390px viewport width, columns stack and the document has no horizontal
  overflow. Desktop, paired-result, and narrow screenshots were visually inspected.
- Existing single-report CSV downloads actual expected UTF-8 bytes for **all five
  occurrences despite a failure filter**. Retry after invalid/read-failed input
  returns the same bytes. Replacement revokes the prior object URL. Zero results
  export only headers. Lone surrogates refuse export without rejecting the report.
  Controlled download creation failure recovers on retry.
- Zero page errors. Request log contains only the eight local application assets;
  no draft-file or external-network requests. Supplied fixture bytes unchanged.

Local review artifacts (not published):

- `media/comparison-verification/evidence.json` — browser version, checks, request/error log.
- `media/comparison-verification/comparison-desktop.png` — mappings and summary.
- `media/comparison-verification/comparison-paired.png` — actual paired result and saved fields.
- `media/comparison-verification/comparison-mobile.png` — narrow layout.
- CSV downloads in the same directory — initial, retry, empty, recovered.

See README for portable browser-harness invocation. Controlled File read failures,
deferred reads, and dispatched cancel events test state handling, not native
filesystem timing or native picker cancellation. Headless Chromium and keyboard
checks do not establish other-browser, screen-reader, or spreadsheet compatibility.

## Review and final checks

A separate read-only review of the comparator/controller, renderer, and HTML
source snapshots found no blocking semantic issues. CSS, tests, shared boundary,
and CSV behavior were verified by the parent checks above, not that review.
`git diff --check` passed. No commits, staging, or publication were performed.
