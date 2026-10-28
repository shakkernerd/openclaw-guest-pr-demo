# Parcel event audit

A dependency-free CommonJS library and command-line reconciler for **immutable
parcel-event JSONL exports**. Requires Node.js 22 or newer. Uses only Node built-ins;
no installation, package manifest, project configuration, or network access.
Everything for this tool lives here, independently of any parcel-manifest work.

This is an evidence audit, not a parcel state machine. It never chooses a winning
record for a reused ID, infers missing events, or treats the latest terminal event
as authoritative. Inputs are opened read-only. Reports go to stdout, not to files.

## Quick start: real synthetic examples

Run from the repository root:

```sh
# Out-of-order input; chronological output; no exceptions. Exit 0.
node parcel-event-audit/cli.js parcel-event-audit/examples/export-a.jsonl

# Retry, conflicting ID, and contradictory terminal evidence. Exit 1.
node parcel-event-audit/cli.js \
  parcel-event-audit/examples/export-a.jsonl \
  parcel-event-audit/examples/export-b.jsonl

# Invalid calendar date on line 2; stderr diagnostic, no stdout. Exit 2.
node parcel-event-audit/cli.js parcel-event-audit/examples/malformed.jsonl

node parcel-event-audit/cli.js --help
```

The two-export example has this `summary` (the actual report also includes all
timelines and exception evidence):

```json
{
  "inputRecords": 6,
  "uniqueEvents": 5,
  "retryDuplicates": 1,
  "parcels": 2,
  "conflictingEventIds": 1,
  "contradictoryParcels": 1,
  "exceptions": 2
}
```

`PKG-A` has created, cancelled, and delivered evidence in that chronological
order. Its delivery retry coalesces, retaining `export-a.jsonl:1` and
`export-b.jsonl:1` and their original timestamp spellings. `PKG-B` retains both
timestamps for the conflicting `b-transit` ID. Reversing the two filename
arguments produces byte-identical stdout. The malformed example reports:

```text
parcel-event-audit: "parcel-event-audit/examples/malformed.jsonl":2: occurredAt has an invalid calendar date, time, or offset
```

### Exceptions-only: a mixed batch

```sh
# Default full report: all five parcels. Exit 1.
node parcel-event-audit/cli.js parcel-event-audit/examples/mixed.jsonl

# Filtered report: three affected parcels, explicitly labeled. Still exit 1.
node parcel-event-audit/cli.js --exceptions-only \
  parcel-event-audit/examples/mixed.jsonl
```

Both reports keep the same **global** summary: 11 input records, 9 unique event
variants, 2 retry duplicates, 5 parcels, 1 conflicting event ID, 1 contradictory
parcel, and 2 exceptions. The filtered report adds `"view": "exceptions-only"`
and has these three entries in `parcels`, in this order:

- `TERMINAL`: its entire created/cancelled/delivered timeline, not just the two
  contradictory terminal events.
- `X-LEFT` and `X-RIGHT`: **both** parcels sharing the conflicting `shared-id`.
  Both variants remain in the exception. Each parcel keeps its nonconflicting
  creation event too; `X-LEFT` retains both creation sources on lines 6 and 8.

Omitted from `parcels`: `CLEAN`, which has no exception, and `RETRY-ONLY`, whose
equivalent creation events on lines 2 and 3 are only a benign retry. Their records
still count in the summary. All exception objects and every affected parcel's
complete timeline, terminal evidence, and source provenance are identical to
the full report. This is a view of a complete audit, not a narrower audit.

Adding `examples/malformed.jsonl` to either invocation fails the **whole** audit
with exit 2 and no stdout. Invalid JSON, schema, timestamps, or UTF-8 anywhere
cannot be hidden by the filter, including records on otherwise clean parcels.

## Input contract (version 1)

Each physical line must be one UTF-8 JSON object with **exactly four fields**:

```json
{"eventId":"evt-123","parcelId":"PKG-123","type":"delivered","occurredAt":"2026-10-28T10:00:00Z"}
```

- `eventId`: a globally scoped event identifier across all supplied exports.
- `parcelId`: the parcel identifier.
- Both identifiers must be nonempty, well-formed Unicode strings with no leading
  or trailing whitespace and no U+0000–U+001F or U+007F controls. They are
  case-sensitive; no trimming, case folding, or Unicode normalization occurs.
- `type`: exactly `created`, `in_transit`, `delivered`, or `cancelled`.
- `occurredAt`: the strict timestamp subset below.

Unknown fields, missing fields, non-string values, duplicate JSON member names
(including escaped equivalents), arrays, nulls, comments, blank lines, BOMs,
invalid UTF-8, and trailing non-JSON text are errors. Rejecting unknown fields
prevents silently dropping payload evidence when deciding whether records match.
JSON whitespace around an object, LF or CRLF line endings, and a final newline
are accepted. An empty file is valid and contains zero events. Line numbers are
physical, one-based, and scoped to a source filename.

### Timestamps

Accepted syntax is `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:MM)`, with uppercase
`T`/`Z`, an explicit timezone, and **one to three** fractional digits when present.
Dates use the Gregorian calendar; local and normalized UTC years must be
0001–9999. Hours are 00–23, minutes/seconds 00–59, and numeric offset components
are hours 00–23 and minutes 00–59. Reject impossible dates, leap seconds,
`24:00:00`, timezone-free values, unknown offset `-00:00`, and precision finer
than milliseconds (never silently round it). `Z` and `+00:00` are equivalent.

Output instants use UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Original timestamp strings
are retained in source records. Ordering and equality compare instants, not
local wall-clock strings. Host timezone and locale do not affect results.

### Retries, conflicts, and contradictions

- A retry is the **same event ID, parcel ID, type, and normalized instant**.
  JSON field order, whitespace, and equivalent timezone/fraction spellings do
  not matter. Coalesce these into one event with every occurrence in `sources`,
  including repeats on separate lines in one file.
- Different event IDs are always distinct, even if everything else matches.
- A single event ID with different parcel IDs, types, or instants produces one
  `EVENT_ID_CONFLICT` exception containing all distinct variants. Retries of a
  conflicting variant still coalesce. Every variant remains in the appropriate
  parcel timeline, marked `conflictingEventId: true`. ID scope is global, so
  reuse across parcels is a conflict too. There is no first/last-wins behavior.
- Any parcel with both delivered and cancelled evidence produces one
  `DELIVERY_CANCELLATION_CONTRADICTION` exception, regardless of timestamp order
  or whether the terminal records themselves have conflicting IDs. All matching
  delivery/cancellation events and their sources appear in that exception.
- No other transitions are judged invalid. A missing creation event, multiple
  deliveries under different IDs, or a transit after delivery alone is not an
  exception in this small contract.

## Output contract

One JSON document, pretty-printed with two spaces and a trailing newline. The
default full report is unchanged:

```text
{
  schemaVersion: 1,
  summary: {
    inputRecords, uniqueEvents, retryDuplicates, parcels,
    conflictingEventIds, contradictoryParcels, exceptions
  },
  parcels: [{ parcelId, timeline: [Event], terminalEvidence: [Type] }],
  exceptions: [
    { code: "EVENT_ID_CONFLICT", eventId, variants: [Event] },
    { code: "DELIVERY_CANCELLATION_CONTRADICTION", parcelId,
      delivered: [Event], cancelled: [Event] }
  ]
}

Event = {
  eventId, parcelId, type, occurredAt,
  sources: [{ filename, line, occurredAt }],
  conflictingEventId
}
```

The notation above describes the shape, not literal JSON. All summary fields are
nonnegative integer counts. `uniqueEvents` counts retained **variants**, including
conflicting ones; `retryDuplicates = inputRecords - uniqueEvents`.
`exceptions = conflictingEventIds + contradictoryParcels`, not the number of
bad lines or affected events. Empty results have zero counts and empty arrays.

`terminalEvidence` is `[]`, `["delivered"]`, `["cancelled"]`, or
`["delivered", "cancelled"]`. It reports observed evidence, **not a resolved
status**. Exception events repeat the complete timeline evidence for convenience.

### Filtered report contract

`--exceptions-only` (CLI) or `{ exceptionsOnly: true }` (library) adds the
top-level field `view: "exceptions-only"` and restricts only the `parcels` array
to the union of parcels referenced by ID-conflict variants and contradictory
delivery/cancellation exceptions. Selection happens **after** validating every
input and reconciling the full batch. It never trims a selected timeline or
its sources, and never removes an exception or any of its evidence.

`schemaVersion`, the **global** `summary`, and the entire `exceptions` array stay
unchanged. In particular, `summary.parcels` is the audited total, while
`parcels.length` is the number shown; these can differ. Existing ordering rules
also apply to the subset. Benign retries alone do not select a parcel. An audit
with no exceptions yields `parcels: []`, `exceptions: []`, and the explicit view
label, retaining its global counts (CLI exit 0). An empty export is labeled too.
Omitting the option or passing `false` returns the original full report with
no added `view` field. Filtering is not a streaming or memory-saving mode.

### Determinism and provenance

- All text comparisons use JavaScript UTF-16 code-unit order, never locale sorting.
- Parcels sort by `parcelId`. Events sort by normalized instant, then `eventId`,
  `parcelId`, and `type`. Sources sort by filename, numeric line, then original
  timestamp. `terminalEvidence` lists delivered before cancelled when both exist.
- Exceptions list ID conflicts sorted by ID, then contradictions sorted by parcel
  ID. Their evidence uses the same event ordering.
- File argument order cannot change the report. Input files are validated in
  filename order; the first error in the first invalid source is reported.
- Filenames are preserved exactly as supplied, not resolved, basenamed, or
  anonymized. Supplying the exact same filename twice is rejected to avoid
  accidentally recounting a source. Different path spellings or symlinks are
  distinct source labels; callers should avoid supplying aliases of one file.
- Moving an event to another input line changes its provenance as it should,
  but not its canonical event identity or chronological ordering. The report
  preserves every accepted field's evidence, not raw JSON whitespace or bytes.

## Library API

```js
const { auditExports, auditFiles, InputError } = require("./parcel-event-audit");

// Synchronous and pure: does not mutate supplied objects or access the filesystem.
const report = auditExports([{
  filename: "memory.jsonl",
  text: '{"eventId":"e1","parcelId":"p1","type":"created","occurredAt":"2026-10-28T08:00:00Z"}\n',
}]);
console.log(report.summary.uniqueEvents); // 1

// Asynchronous, read-only file API; returns Promise<Report>.
async function fromFiles() {
  try {
    return await auditFiles(["parcel-event-audit/examples/export-a.jsonl"]);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(error.filename, error.line, error.reason);
    }
    throw error;
  }
}
```

Both APIs accept an optional second argument: `auditExports(sources, options)`
and `auditFiles(filenames, options)`. The default is `{}`; the only supported key
is the boolean `exceptionsOnly`. Invalid option types, nonboolean values, and
unknown keys throw/reject `TypeError` rather than silently choosing a view.
Neither the options nor input arrays/objects are mutated. For example:

```js
// With the exports from the example above; auditExports accepts the same option.
auditFiles(["parcel-event-audit/examples/mixed.jsonl"], { exceptionsOnly: true })
  .then(report => console.log(report.view, report.summary.parcels, report.parcels.length))
  .catch(error => console.error(error.message));
// exceptions-only 5 3
```

Both APIs require a nonempty array and unique, nonempty string filenames.
`auditExports` requires a string `text` per source; callers must decode their own
bytes strictly if using that API. Invalid API argument shapes throw `TypeError`.
Input/schema/encoding errors and file-read failures throw/reject `InputError`,
whose `filename`, `line`, and `reason` are public. `line` is `null` for file-level
errors such as `ENOENT` or duplicate source arguments. Messages quote filenames
so whitespace/control characters cannot masquerade as extra diagnostic lines.

Audit exceptions are **data**, not thrown errors: inspect `report.exceptions`.
No partial report is returned on malformed input. Importing either JavaScript
module has no command-line side effects. There is no mutable global audit state.

## CLI and exit statuses

```text
node parcel-event-audit/cli.js [--exceptions-only] [--] FILE.jsonl [FILE.jsonl ...]
```

- `0`: successful audit with no exceptions, or `--help`/`-h` used alone. Retries
  alone are not exceptions.
- `1`: successful audit with one or more conflicts/contradictions. A complete
  report is still written to stdout; stderr is empty.
- `2`: bad arguments, malformed input, input I/O failure, or output failure.
  A concise diagnostic goes to stderr **if it is writable**, without a stack
  trace. Input failures produce **no stdout**; a stdout failure can of course
  leave a partial write. If stderr also fails (including a closed combined
  `2>&1` pipe), no diagnostic is guaranteed: reporting is best-effort, there is
  no recursive retry or uncaught stream-error stack, and the exit code stays 2.

There is no stdin, output-file, or configuration option. Use `--` for filenames
beginning with `-`. Unknown flags are errors; help cannot be mixed with files.
`--exceptions-only` is a valueless flag accepted anywhere before `--`; repeating
it is harmless. After `--`, that spelling is a literal filename. Neither view
changes exit-status rules: clean audits exit 0 and audits with exceptions exit 1.
Shell redirection is the caller's responsibility: **never redirect stdout onto
an input file** (the shell truncates it before Node runs). Ordinary shell pipelines
can mask the audit exit status; inspect the audit process's status separately.

## Verification and limits

```sh
node --test parcel-event-audit/audit.test.js
node --test parcel-event-audit/views.test.js parcel-event-audit/output.test.js
node --test
```

Tests use `node:test` and `node:assert/strict`, including real subprocess CLI
invocations. They cover arrival order, deterministic permutations and ties,
timestamp equivalence and calendar boundaries, source retention, cross-parcel
ID conflicts, contradictory evidence in either order, malformed data and UTF-8,
duplicate JSON keys, filenames/arguments, exit statuses, and byte-for-byte input
preservation. View tests compare full evidence, totals, cross-parcel conflicts,
benign retries, deterministic ordering and malformed omitted-parcel input.
The focused combined-output regression runs the real CLI with POSIX `sh` fd
duplication (`2>&1`), then closes its reader after a first chunk of a large report.
It verifies exit 2, not an uncaught-failure exit 1; a normal-draining control
verifies complete JSON and exit 0. Those two fd-duplication tests are skipped on
Windows; ordinary CLI/view tests do not need a shell. Once a combined pipe is
closed, later diagnostic text cannot be observed through it; the regression
checks the CLI process status directly, not a downstream consumer's status.
Temporary test files live in the OS temporary directory and are removed, not
added to the contribution. The small example exports are synthetic.

The batch implementation holds parsed records and the full report in memory,
and reads one entire file at a time. It is not a bounded-memory streaming or
external-sort tool; size exports to available memory. It assumes exports remain
immutable while reading and does not attempt snapshots or concurrent-writer
detection. It accepts regular files (including symlinks to regular files), not
directories or special devices. No dependencies, generated reports, or logs
belong in this namespace.
