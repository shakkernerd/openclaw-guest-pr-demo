# Courier CSV intake

Dependency-free CommonJS library and CLI for Node.js 22+. Uses the **unchanged**
[`parcel-event-audit`](../parcel-event-audit/README.md) for event validation and
reconciliation. Only the CSV adapter and provenance are new. No installation,
configuration, network, generated intermediate files, or input writes.

## Run from the repository root

```sh
# Clean audit: exit 0.
node courier-csv-intake/cli.js courier-csv-intake/examples/export-a.csv

# Retry, conflicting ID and contradictory terminals: exit 1.
node courier-csv-intake/cli.js \
  courier-csv-intake/examples/export-a.csv \
  courier-csv-intake/examples/export-b.csv

# Located timestamp error: exit 2, stderr only, no stdout.
node courier-csv-intake/cli.js courier-csv-intake/examples/malformed.csv

node courier-csv-intake/cli.js --help
node --test courier-csv-intake/*.test.js
node --test
```

The two-export example has 6 input records, 5 unique event variants, 1 retry,
2 parcels, 1 ID conflict and 1 delivery/cancellation contradiction. Reversing
filenames gives byte-identical JSON. The malformed example identifies CSV
record 2, physical line 3, field 5 (`occurredAt`). All fixtures are synthetic.

CLI: `node courier-csv-intake/cli.js [--exceptions-only] [--] FILE.csv ...`.
`--help`/`-h` must stand alone. Unknown flags fail; use `--` for leading-dash
filenames. No stdin or output-file option. Exit 0 means a complete audit without
exceptions (or help); 1 means a complete audit with exceptions; 2 means invalid
input, bad arguments or I/O failure. JSON is indented two spaces with a final LF.
Do not redirect stdout onto an input: the shell would truncate it before Node
runs. Pipelines can hide exit status; check the audit process itself.

## Header/schema convention

Each file has one header record. These four **exact, case-sensitive names** must
each occur once, in any order:

```csv
eventId,parcelId,type,occurredAt,note
evt-1,PKG-1,delivered,2026-10-28T10:00:00Z,"Received, 雪"
```

Every header name must be nonempty and unique after CSV unquoting. Extra names
are allowed, including Unicode, whitespace and quoted multiline names; they
are retained exactly. Names such as `EventId`, `event_id` or ` eventId` are NOT
aliases for `eventId`. There is no header inference, positional schema without
a header, courier-status mapping, or automatic timestamp conversion.
Every data record must have exactly as many cells as the header.

The four selected values become the auditor's exact four-string event object:

- `eventId`, `parcelId`: nonempty well-formed Unicode, no leading/trailing
  whitespace or U+0000–U+001F/U+007F controls. Case and Unicode spelling matter.
- `type`: exactly `created`, `in_transit`, `delivered`, or `cancelled`.
- `occurredAt`: strict `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:MM)`, uppercase
  T/Z, 1–3 fractional digits if present, explicit timezone, valid Gregorian
  date, local and UTC years 0001–9999. No leap seconds, 24:00, `-00:00`,
  impossible dates or finer-than-millisecond precision. See the auditor contract.

Validation is delegated to the auditor, not an approximate adapter validator.
No values are trimmed, case-folded, Unicode-normalized or guessed.
**Extra columns are evidence, not event identity.** Differences in extra columns
do not create new auditor conflicts: equivalent four-field events still coalesce
as retries, but *every* occurrence, extra value and raw spelling remains available.
Unknown courier data is not interpreted or certified as correct.

## CSV dialect

- Strict UTF-8, comma separator, double-quote quoting; no BOM. Invalid UTF-8
  anywhere, including extra columns or headers, rejects the whole batch.
- Fields can be unquoted or wholly quoted. Inside quoted fields, `""` means
  one literal quote; commas, LF, CRLF and bare CR are data and are preserved.
- Record separators are LF or CRLF (mixed is allowed). Bare CR outside quotes
  is invalid. Physical lines count LF bytes; a quoted bare CR does not increment
  the line number. No backslash escapes, comments, delimiter autodetection,
  or spreadsheet `sep=` preamble.
- Quotes in unquoted fields, unterminated quotes, or any text/space between a
  closing quote and comma/record-ending/EOF are errors. Spaces in unquoted cells
  are data, not padding to remove.
- Final newline optional. An extra blank record is an error, not silently skipped.
  Empty cells, including a trailing comma, are real cells; empty extra cells are
  valid. Empty required values fail event validation. A header-only file is a
  valid zero-event source; an empty file is invalid because its header is missing.

## Report and evidence

The result is `{ schemaVersion: 1, format: "courier-csv-intake", audit, evidence }`.
`audit` retains the auditor's summary, ordered timelines, terminal evidence and
exceptions. Only event `sources` are translated from temporary JSONL coordinates
to original CSV coordinates; no temporary files are created. No winning variant
or resolved parcel status is invented. The existing retry, global ID-conflict
and delivery/cancellation rules are unchanged.

Each `evidence` entry has `filename`, `encoding`, `byteLength`, SHA-256 `sha256`,
`bytesBase64` (the **entire original byte sequence**), `header` and `records`.
Each record has its `record` number, `raw` text excluding its ending, the exact
`terminator`, location span, and an ordered `fields` array. Each field has its
`index`, original unescaped `value`, exact lexical `raw` including CSV quotes,
and span. Data fields also have their original header `name`. Arrays preserve
column order and safely retain names such as `__proto__`.

Every timeline/exception source contains `filename`, `record`, `line`, `endLine`,
`byteStart`, `byteEnd`, original `occurredAt`, and `fields`: a map of the four
required names to their field index and span. Join `(filename, record)` to the
evidence record to inspect **all** courier cells, including retry metadata.

Coordinates: records are one-based and include the header as record 1; field
indices and physical line numbers are one-based. `column`/`endColumn` are
one-based **UTF-8 byte columns**, not Unicode character/display columns. Byte
offsets are zero-based; all `[byteStart, byteEnd)` spans are end-exclusive.
Record spans exclude terminators; field spans exclude commas but include quotes.
`endLine`/`endColumn` locate the exclusive endpoint. Recover exact file bytes with
`Buffer.from(evidence.bytesBase64, "base64")`; the digest is an integrity checksum,
not proof of authenticity. Input files are opened read-only.

Sources sort by exact filename using JS UTF-16 code-unit order. Records/fields
retain input order. Auditor ordering is unchanged; source order corresponds to
CSV record order, including multiline records. There are no time/locale-dependent
fields. Duplicate filename arguments fail; alternate spellings/symlinks are
distinct labels, so avoid supplying aliases for the same file.

`--exceptions-only` / `{ exceptionsOnly: true }` filters **only** `audit.parcels`
after full validation and reconciliation and adds `audit.view: "exceptions-only"`.
Global totals, all exceptions, complete affected timelines and **all CSV evidence**
remain, even for omitted clean parcels. This is not a redaction feature. Reports
contain the entire supplied data; treat them as sensitively as their inputs.

## Library API and failures

```js
const { auditExports, auditFiles, InputError } = require("./courier-csv-intake");

// Pure synchronous API. Require bytes to avoid silently lossy string decoding.
const report = auditExports([{
  filename: "memory.csv",
  bytes: Buffer.from("eventId,parcelId,type,occurredAt\ne1,p1,created,2026-10-28T08:00:00Z\n"),
}]);

// Async read-only regular-file API; use await in an async function.
auditFiles(["courier-csv-intake/examples/export-a.csv"], { exceptionsOnly: true })
  .then(report => console.log(report.audit.summary))
  .catch(error => console.error(error.message));
```

`bytes` accepts Buffer or Uint8Array, copied before parsing. Both APIs require a
nonempty source list and unique nonempty string filenames. They do not mutate
inputs/options. The only option is boolean `exceptionsOnly`; invalid API argument
shapes throw/reject TypeError. Importing either module has no CLI side effects.

Content/I/O failures throw/reject `InputError`, exposing `filename`, `reason`,
`record`, `line`, `column`, `byteOffset`, `fieldIndex`, `fieldName` (unavailable
coordinates are null). Syntax errors point at the offending byte or opening
quote. Encoding/event errors point at the field start; missing cells point at
the record end, and missing headers at the header start. Filenames/names in
diagnostics are JSON-quoted. Sources validate in sorted filename order; within
a source, CSV syntax/encoding is checked first, then headers/row widths, then
auditor event semantics. The first failure in that deterministic order stops
the whole batch, including the exceptions-only view. No partial report returns;
input failures produce zero stdout, not a success report with skipped records.

Output failures exit 2 but can leave partial stdout. Diagnostics are best-effort
if stderr is also broken, including a closed combined `2>&1` pipe.

## Verification and limits

Tests include actual CLI subprocesses (not only library calls), exits 0/1/2,
byte-identical argument-order/timezone/locale results, strict schema/dialect/UTF-8
errors, multiline coordinates, full-vs-filtered evidence, generated CSV round
trips, byte reconstruction, unchanged input files, and broken output pipes.
POSIX-only device/FIFO/combined-pipe checks are guarded on Windows. No third-party
packages are used. Temporary test data stays in OS temp directories and is removed.

This is an in-memory batch tool, not a streaming/size-limited parser. Raw bytes,
raw records, decoded fields and JSON evidence deliberately duplicate data; large
exports can require much more memory than their file size. Event validation runs
per source, then the complete batch is reconciled through the same library. Only
regular files (including symlinks to them) are accepted. Files are assumed immutable
during reading; there is no concurrent-writer snapshot guarantee.
