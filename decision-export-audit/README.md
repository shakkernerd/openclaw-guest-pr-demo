# Decision export audit

A dependency-free Node.js library and CLI for **read-only review reports** about
exported discrepancy-review decisions. It never applies decisions, merges
exports, changes inputs, follows evidence paths, or performs network requests.

Requires Node.js 22 or newer. No installation, package manager, build step,
configuration change, or executable permission change is needed. Only Node
built-ins are used. The original demo remains unchanged.

## Export contract and baseline

The [contract](docs/export-contract.md) was derived from the actual attachment
before implementing parsing. The original export is preserved byte-for-byte at
`test/fixtures/review-decisions-review.json` (10,874 bytes; SHA-256
`1d3119bcc05c601dcae42c79cd1e22d0765300d2ce90138b8e4d47483ee7151d`).
It contains 10 decisions and 21 source occurrences. Tests pin its bytes/digest.

The contract explicitly separates observed facts from conservative local policy.
Unknown fields, duplicate identities, and inconsistent source references are
errors. Unknown **nonempty string values** for statuses/categories/dispositions/
versions are warnings: this one sample does not establish the tracker's full
vocabulary. They remain exact and comparable, not silently accepted as known.

## CLI

Run from the repository root:

```sh
node decision-export-audit/bin/decision-export-audit.js --help

# Validate the untouched baseline.
node decision-export-audit/bin/decision-export-audit.js validate decision-export-audit/test/fixtures/review-decisions-review.json

# Same-file comparison: 10 unchanged, no changes/additions/missing records.
node decision-export-audit/bin/decision-export-audit.js compare decision-export-audit/test/fixtures/review-decisions-review.json decision-export-audit/test/fixtures/review-decisions-review.json

# Compare your own local exports, with explicit roles.
node decision-export-audit/bin/decision-export-audit.js compare "/path/to/current.json" "/path/to/incoming.json"
```

Reports are pretty-printed JSON on stdout. Structured parse, validation, and I/O
diagnostics are included in reports. Invalid command syntax is printed to stderr.
Help is plain text on stdout. There are no apply/merge/output-file options.

| Exit | Meaning |
| --- | --- |
| 0 | Valid export, complete comparison (including differences/warnings), or help |
| 1 | Invalid export/JSON/UTF-8, size/depth limit, or workspace mismatch |
| 2 | Invalid command/arguments, missing/unreadable/non-regular file |

### Early-closing readers (`head`)

An early-closing reader can cause `EPIPE` on stdout **or stderr**, including when
`2>&1` combines them. The CLI handles only this expected pipe closure quietly,
without a stack trace or a second diagnostic write to the closed stream. It
preserves the command result: **0** for valid/help output, **1** for invalid data
or an incomplete comparison, and **2** for usage or file-read failures. Other
output errors are not silently ignored.

A successful exit here does **not** mean the reader received the whole report.
`head` intentionally discards output; its preview is generally incomplete JSON.
Merged output may also discard diagnostics. For an auditable result, use the
full saved report or capture example rather than the preview.

From the repository root, in Bash (the subshell confines the option change):

```sh
(
  set -o pipefail
  node decision-export-audit/bin/decision-export-audit.js compare decision-export-audit/test/fixtures/review-decisions-review.json decision-export-audit/test/fixtures/incoming-review-decisions.json 2>&1 | head -n 20
)
```

Without `pipefail`, a shell normally reports the last command's status, so a
successful `head` can hide a nonzero CLI result. Bash's `PIPESTATUS[0]`, read
immediately after a pipeline, reports the producer's status separately. No
shell configuration file is changed by the example.

Differences are not command failures. Inspect `summary`, `evidenceChanged`,
`sourceEvidenceIdentityChanged`, all diagnostics, and record deltas. A comparison
with errors has `complete: false`, `summary: null`, and `records: []`; it must not
be read as “zero changes.” With invalid input, both sides' diagnostics remain
separate; metadata/evidence snapshots are null for an invalid side, while a valid
other side retains its own snapshot.

Quote paths containing spaces; prefix leading `-` paths with `./`. Inputs must
be regular local files, at most 16 MiB each. Symlinks to regular files may be
read; declared evidence paths are never opened. Never redirect stdout over an
input: the shell can truncate that file **before** the CLI starts. If saving a
report yourself, use a distinct destination. No report is saved automatically.

## Real colleague-handoff example

Both attached inputs are retained verbatim in `test/fixtures/`. From the
repository root, this command uses the actual baseline and incoming handoff:

```sh
node decision-export-audit/bin/decision-export-audit.js compare decision-export-audit/test/fixtures/review-decisions-review.json decision-export-audit/test/fixtures/incoming-review-decisions.json
```

Expected: **7 unchanged, 2 changed, 0 added, 1 missing**; exit 0, no diagnostics.
MAR-014 changes its note despite revision 1 on both sides. MAR-DUP changes status
and note. MAR-015 is absent from the handoff, not a tracker deletion instruction.
Declared evidence and the 19 occurrences in matched decisions are unchanged;
underlying source files were not verified, and shared history remains unproven.

- [Saved actual CLI stdout](examples/colleague-handoff/comparison.json)
- [Operations review with exact status/note values](examples/colleague-handoff/REVIEW.md)

The full JSON report retains both snapshots and can be verbose. Use the concise
review for operations, not a truncated JSON excerpt. To safely capture or verify
the exact report without redirecting over an input:

```sh
node decision-export-audit/examples/colleague-handoff/capture.js
```

This **example helper**, separate from the read-only audit CLI, checks pinned
input hashes/lengths, runs the real CLI, checks unchanged input bytes, and writes
only a new `examples/colleague-handoff/comparison.json`. An identical existing
report is verified without rewriting; a different existing report is refused.
It accepts no arguments and never regenerates or alters either fixture.

The incoming fixture is 13,709 bytes; SHA-256
`a5b3582c51aede5a77e535783f2caebb8ba26b50c893635c1d351414f5d9bf66`.
These input fingerprints identify bytes, not provenance or authority.

## Library

```js
const { readFileSync } = require("node:fs");
const { parseExport, validateExport, compareExports } = require("./decision-export-audit/lib");

const current = parseExport(readFileSync("current.json"));
const incoming = parseExport(readFileSync("incoming.json"));

if (!current.ok || !incoming.ok) {
  // Keep diagnostics attached to their side; do not compare failed parses.
  console.log({ current: current.diagnostics, incoming: incoming.diagnostics });
} else {
  console.log(validateExport(current.value));
  console.log(compareExports(current.value, incoming.value));
}
```

- `parseExport(string | Uint8Array | Buffer)` returns
  `{ ok, value, diagnostics }`. Failure returns `value: null`; it never returns
  a last-write-wins object after duplicate JSON member names. Invalid UTF-8/BOM,
  malformed JSON, precision-changing numeric conversion, >16 MiB input, and
  >128 nested containers are rejected. Equivalent decimal spellings such as
  1, 1.0, and 1e0 remain equivalent, as do 0, -0, -0.0, and -0e10. Report
  snapshots display zero as 0 without changing the inputs. Prefer this parser:
  a parsed-value API cannot recover precision or duplicate member names already
  lost by another parser.
- `validateExport(value)` accepts parsed JSON-compatible data and returns
  `{ valid, decisionCount, diagnostics }`. It does not coerce or mutate values.
  No input object is retained in this result.
- `compareExports(currentValue, incomingValue)` validates both sides, then
  returns a detached report. It accepts values, not paths or parse-result
  wrappers. Deep-frozen inputs are supported. No side is used as a winner.

Bad data yields diagnostics rather than exceptions. Executable getters/proxies
and other non-JSON JavaScript objects are outside the API contract. The library
performs no filesystem I/O; callers control how bytes are obtained.

### Report interpretation

Every comparison has `readOnly: true`, `sharedHistory: "unproven"`, and explicit
limitations. `complete` means structurally comparable under this contract, NOT
verified provenance, complete real-world evidence, or authority to act.

- `current` / `incoming`: separate validation results, metadata, and evidence
  declarations. CLI reports additionally include each input path and measured
  byte count/SHA-256; these file measurements are not the declared dataset hash.
- `summary`: counts of `unchanged`, `changed`, `added` (incoming only), and
  `missing` (current only). Matches use workspace + exact groupKey. Different
  workspaces stop classification. No real-world order catalogue is available.
- `records`: sorted by exact groupKey, with full, separate `current` and
  `incoming` snapshots. The absent side is null for added/missing records.
- `changes`: exact `{ path, current, incoming }` field deltas. For example,
  `{ "path": "/note", "current": "", "incoming": " \r\n" }` is a real change.
  No trimming, case folding, Unicode normalization, or line-ending conversion.
- `statusChanged`, `noteChanged`, `decisionChanged`: distinguish review edits
  from revision/timestamp, category/orderId, or evidence-only changes. These
  flags are null for added/missing records, which have no paired values.
- `sourceEvidenceChanges`: added/missing/changed occurrences keyed by exact
  occurrenceKey, with deltas and `identityChanged`. Identity fields include
  version, key, filename, sourcePath, sourceSha256, line, and endLine. Changes
  only to salesIncluded/disposition are annotation changes, not identity changes.
  The aggregate `sourceEvidenceIdentityChanged` flag covers matched decisions
  only. Added/missing decisions have null per-record identity flags and empty
  paired occurrence deltas, with evidence preserved in the present-side snapshot.
  All-added/all-missing comparisons have aggregate false; inspect their
  classifications rather than reading that flag as global membership equality.
- `evidenceChanges` / `evidenceChanged`: changes in enclosing declarations,
  separately from decisions. Records can be unchanged while evidence changed.
- `metadataChanges`: changes in workspace/meaning metadata, separately from
  per-record classification. Exported meaning text never changes tool behavior.

Category/source/occurrence ordering is ignored for classification, but original
array order is retained in snapshots. Record order is deterministic code-unit
order, not locale-dependent. Same inputs produce the same report.

Validation diagnostics use actual input JSON Pointers (zero-based array indices).
Comparison paths use **logical keyed locations**, e.g.
`/sourceEvidence/original:15/line` and `/evidence/sources/original/sourcePath`;
these are not literal array-index pointers into the input. `~` and `/` in keys
are escaped as `~0` and `~1`. Root has path `""`. Parser offsets are zero-based
UTF-16 character offsets, not byte offsets.

Diagnostic entries have `severity`, `code`, `path`, `message`, and sometimes
`relatedPaths` or `offset`/`firstOffset`. Useful codes include `UNKNOWN_FIELD`,
`MISSING_FIELD`, `UNKNOWN_VALUE` (warning), `DUPLICATE_DECISION_IDENTITY`,
`DUPLICATE_JSON_MEMBER`, `DUPLICATE_OCCURRENCE`, `DUPLICATE_SOURCE_VERSION`,
`UNKNOWN_SOURCE_REFERENCE`, `SOURCE_REFERENCE_MISMATCH`,
`SOURCE_EVIDENCE_IDENTITY_CHANGED` (warning), and `WORKSPACE_MISMATCH`.

## Safety and provenance limits

- Declared hashes, paths, byte sizes, dates, and timestamps are unverified data.
  Equality is not proof of equal underlying bytes, origin, integrity, or authority.
  No dataset-hash construction algorithm is inferred from the sample.
- Equal revisions can contain different notes/statuses; a higher revision can
  come from an unrelated history. Revisions/timestamps never select precedence.
- Evidence identity changes remain visible even when declared dataset hashes
  stay equal. Same-key matches are review candidates, not verified shared events.
- No apply, merge, approval, source rewrite, evidence retrieval, or publication
  exists in the tool. Inspect the report and make decisions outside it.

## Checks and local contribution

```sh
node --test
# Focused native checks:
node --test decision-export-audit/test/*.test.js
git diff --check
```

Checks include the byte-pinned baseline, strict parsing/duplicates, located
validation, all comparison classifications, exact strings, order independence,
evidence identity vs annotations, unrelated revisions, provenance limits,
deep-frozen inputs, detached reports, and real CLI success/failure/no-write paths.
Tests generate variants in memory or temporary directories; they never rewrite
the baseline. No installs or network access are required.
