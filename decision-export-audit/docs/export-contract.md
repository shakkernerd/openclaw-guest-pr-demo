# Export contract: observed tracker v1 and local audit policy

This contract was derived **before parser implementation** from the user-supplied
`review-decisions-review.json`. It is a supported audit profile, not an assertion
that one export describes every format or status the tracker can produce.

## Baseline and observations

The attachment was copied byte-for-byte to
`test/fixtures/review-decisions-review.json`, without reserialization:

- UTF-8 JSON object; 10,874 bytes, including its final LF.
- Locally measured file SHA-256:
  `1d3119bcc05c601dcae42c79cd1e22d0765300d2ce90138b8e4d47483ee7151d`.
- `schemaVersion` is the number `1`; `workspace` is `"review"`.
- 10 decisions, 21 source occurrences, and two declared sources:
  `original` and `revised`.
- `decisions[0]` has status `"Waiting for evidence"`, revision `1`, and
  `updatedAt: "2026-10-28T10:55:10.448Z"`. The other nine have status
  `"Needs review"`, revision `0`, empty notes, and `updatedAt: null`.
- Observed categories: `missing`, `excluded`, `changed`, `ambiguous`.
- Observed dispositions: `non-completed`, `duplicate`, `included`, `malformed`,
  `cancelled`. These describe source rows; `disposition: "malformed"` is NOT
  itself a malformed decision export.
- `id:MAR,007` demonstrates that decision keys/order IDs can contain punctuation.
  `id:MAR-DUP` has two distinct original occurrences and one revised occurrence;
  that is NOT a duplicate decision identity.

The baseline digest identifies these observed file bytes only. It is distinct
from every declared dataset/source/report digest and provides no authorization
or authentication. The fixture is retained verbatim at the user's request.

## Shape and validation policy

All listed fields are required. Objects reject extra own fields with
`UNKNOWN_FIELD`; missing fields use `MISSING_FIELD`. JSON Pointer paths identify
locations (`/decisions/0/status`); duplicate diagnostics also point to the first
occurrence. No coercion, trimming, case folding, or newline normalization occurs.

The shape below is observed. Requiredness, bounds, uniqueness, and rejection of
unknown fields are explicit conservative **local policy**, not inferred tracker
guarantees. No external schemas, source files, or services are consulted.

| Object/location | Fields and accepted types |
| --- | --- |
| Root | `schemaVersion`: exactly 1; `workspace`: nonempty string; `evidence`: object below; `meaning`: string; `decisions`: array (may be empty) |
| `/evidence` | `datasetSha256`: hash; `reviewDate`: real calendar `YYYY-MM-DD`; `csv`, `report`: file declarations; `sources`: nonempty source array |
| `/evidence/csv`, `/evidence/report` | `path`: nonempty string; `sha256`: hash; `bytes`: nonnegative safe integer |
| `/evidence/sources/*` | `version`, `filename`, `sourcePath`: nonempty strings; `sha256`: hash |
| `/decisions/*` | `groupKey`, `orderId`, `status`: nonempty strings; `categories`: nonempty unique string array; `note`: string (empty allowed); `revision`: nonnegative safe integer; `updatedAt`: null or canonical UTC timestamp with milliseconds; `sourceEvidence`: nonempty occurrence array |
| `/decisions/*/sourceEvidence/*` | `version`, `occurrenceKey`, `filename`, `sourcePath`: nonempty strings; `sourceSha256`: hash; `line`, `endLine`: positive safe integers with endLine >= line; `salesIncluded`: boolean; `disposition`: nonempty string |

A hash is exactly 64 lowercase hexadecimal characters (the observed spelling).
Filenames and paths are opaque strings, never resolved or opened. Relative
paths such as `../daily-exceptions/...` are valid declarations, not read targets.
Canonical timestamps must round-trip through `Date.toISOString()` and actual
calendar dates must round-trip; null is not interchangeable with an empty string.
No relationship between revision number and timestamp is presumed.

### Unknown values and identity consistency

- Only the observed status/category/disposition/version vocabulary is *known*.
  Other nonempty strings produce `UNKNOWN_VALUE` **warnings**, remain intact,
  and can be compared. One example cannot establish the tracker's complete enums.
  Warnings never imply acceptance or authorization of the underlying decision.
- An unfamiliar `meaning` string produces `UNRECOGNIZED_MEANING` warning. The
  report's read-only semantics never depend on text supplied by an export.
- `groupKey` is an opaque exact decision identity, unique within an export.
  All observed keys equal `"id:" + orderId`; departures produce a warning rather
  than rejecting potentially valid unobserved key forms. No punctuation parsing.
- Source declaration `version` is unique. Occurrence `version` must refer to one
  unambiguous declaration, with exactly matching filename, sourcePath, and hash.
  Missing references or conflicting declarations are errors.
- Occurrence keys are unique **within each decision**. The sample uses
  `version + ":" + line`; departures produce a warning, not a guessed rule.
  Reuse across different decision keys is reported as a warning.
- Duplicate category strings, source versions, decision groupKeys, and
  per-decision occurrence keys are errors. No first/last-write-wins policy.
- There is no authoritative decision catalogue in the export. A new groupKey
  in an incoming export is `added`, not evidence that the real-world order is
  known or valid. Unknown fields and broken source references are distinguished
  from new decision identities.

## Parsing boundaries

`parseExport` accepts a JSON string or UTF-8 Uint8Array/Buffer, not filenames.
Reject invalid UTF-8, a UTF-8 BOM, malformed JSON, and duplicate JSON object
members (including escaped-equivalent member names) rather than allowing silent
JSON.parse overwrite. Errors have JSON Pointer paths where possible; syntax/
member diagnostics include character offsets when available. Nonfinite numbers
and literals whose decimal value changes on JavaScript number conversion are
rejected (`NUMBER_RANGE` / `NUMBER_PRECISION`), so a fractional revision cannot
round into an accepted integer. Equivalent decimal spellings (1, 1.0, 1e0) and
signed-zero spellings (0, -0, -0.0, -0e10) are not differences. JSON report
snapshots display zero as 0; inputs are never normalized or changed.
The parsed-value library API cannot recover precision already
lost by a caller using a different parser.

Local resource limits: 16 MiB of UTF-8 input and 128 nested containers. The CLI
also limits file reads to 16 MiB. These are implementation limits, not tracker
restrictions. JavaScript library values must be ordinary JSON-compatible data;
objects with executable getters/proxies are outside the library contract.

## Comparison semantics

Both sides are validated independently. An invalid side means `complete: false`,
`summary: null`, and no record classifications; duplicate ambiguity is never
silently resolved. Different workspaces likewise prevent comparison. Current
and incoming validation diagnostics and evidence declarations are kept separate.

For valid exports in the same workspace, match only exact `groupKey`, not array
position, orderId alone, status, timestamps, revision, or hash. Results sort by
code-unit groupKey order. Category order, source declaration order, and occurrence
order are ignored, but membership and every field value remain significant.

- `unchanged`: same matched decision fields, including revision, timestamp, and
  source occurrence fields, ignoring the above set-like orderings.
- `changed`: any matched decision field differs. `statusChanged`, `noteChanged`,
  and `decisionChanged` (status or note) distinguish review edits from metadata
  or evidence-only changes.
- `added`: incoming-only key; `missing`: current-only key. Neither is a proposed
  insertion or deletion operation. Missing sides are explicitly null.
- Field deltas contain separate exact `current` and `incoming` values. Status
  and note deltas preserve empty strings, whitespace, Unicode, and line breaks.
  Missing/null notes are invalid, not normalized to empty strings.
- Occurrence differences match exact occurrenceKey. Identity comprises version,
  occurrenceKey, filename, sourcePath, sourceSha256, line, and endLine. Additions/
  removals also change identity. salesIncluded/disposition changes are evidence
  annotation changes, distinguished from identity changes. The aggregate
  `sourceEvidenceIdentityChanged` flag covers **matched decisions only**. Added
  and missing decisions have null per-record identity flags and no paired
  occurrence deltas; their full present-side snapshot supplies the evidence.
  An all-added or all-missing comparison therefore has aggregate false, not
  a claim that occurrence membership across the whole export is unchanged.
- All root evidence declaration fields are compared separately, including
  dataset hash, review date, CSV/report path/hash/byte length, and sources keyed
  by version. A changed declaration sets `evidenceChanged` and a warning; it does
  not suppress decision comparison or rewrite either side. A decision can be
  unchanged while the enclosing evidence declaration changed.
- Same-key matches under changed evidence remain review candidates, NOT proof
  of the same underlying event. Source identity changes are visible both in
  per-record flags and located deltas; no automatic mapping or reconciliation.
- Workspace and meaning metadata stay separate from per-record classification.

## Provenance and history limits

Declared hashes, byte counts, paths, dates, revisions, and timestamps are
unverified claims. Matching declarations do not establish equal actual source
bytes, origin, integrity, shared ancestry, or authorization. The tool does not
have the underlying evidence and does not fetch it or verify a dataset-hash
algorithm. Actual export-file fingerprints, when supplied by the CLI, describe
only the input bytes read. Neither fingerprint nor declared hash is authority.

`sharedHistory` is always `"unproven"`. Revision 1 versus 9 does not mean incoming
is newer, descended from current, or safe to apply; equal revisions can hide
different statuses/notes. The comparison reports both numbers without choosing
a winner. The `meaning` value is data, not instructions. No report applies a
decision, approves sales, changes dispatch state, merges exports, or mutates input.
