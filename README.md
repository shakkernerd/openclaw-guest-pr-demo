# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The `parcelLabel` helper in `parcel-label.js` formats counts as item labels.
Its existing behavior is unchanged: `0 items`, `1 item`, and `3 items`.

## Parcel manifest CLI

With Node.js 22 or newer, validate a JSON manifest and summarize **valid parcels
only**, by destination, service, and destination/service pair. No dependencies
or installation are required.

```sh
node parcel-manifest-cli.js examples/manifest.json
node parcel-manifest-cli.js --json examples/manifest.json
cat examples/manifest.json | node parcel-manifest-cli.js --json -
node parcel-manifest-cli.js --help
```

Use `--` before a filename beginning with a dash. Files are read as UTF-8; `-`
explicitly selects stdin. The CLI reads the entire manifest into memory.

### Manifest format

The root must be an array; each element represents one parcel:

```json
[
  {
    "id": "P-1",
    "recipient": "Alex Example",
    "street": "10 Example Street",
    "postcode": "SW1A 1AA",
    "destination": "GB",
    "service": "standard",
    "itemCount": 2
  }
]
```

- All seven fields are required. `id`, `recipient`, `street`, `postcode`,
  `destination`, and `service` must be non-empty strings after trimming.
- `destination` must be two ASCII letters, normalized to uppercase. This checks
  code format, not membership in an up-to-date country registry.
- `service` may be any non-empty string, normalized to lowercase for grouping.
  Surrounding whitespace is ignored; carrier-specific service names are allowed.
- `itemCount` must be a positive safe integer (1–9007199254740991), not a string.
  Summary counts represent **parcels**, not the sum of item counts.
- IDs are case-sensitive after trimming. **Every row** sharing a duplicate ID is
  invalid, even if one of those rows also has other errors.
- Extra fields are ignored. An empty array is valid. Input is never modified.

This is structural validation, not address verification: postcode/address
presence is checked, but deliverability and carrier eligibility are not.

### Invalid rows and partial summaries

```sh
node parcel-manifest-cli.js examples/manifest-mixed.json
# Exit 1; stdout includes: Parcels: 5 total, 3 valid, 2 invalid.
# stderr identifies Row 2 [recipient], Row 2 [itemCount], and Row 3 [$].

node parcel-manifest-cli.js --json examples/manifest-mixed.json > report.json
# Still exits 1, but report.json contains errors AND the valid-parcel summary.
```

All detected row errors are reported, not just the first. Row numbers are
**one-based positions in the original array**, never renumbered after filtering.
Default mode sends the summary to stdout and diagnostics to stderr.

`--json` sends one JSON report to stdout and no validation diagnostics to stderr:

- `valid`: whether the entire manifest passed.
- `totalRows`, `validRows`, `invalidRows`: row counts (not error counts).
- `errors`: objects with `row`, `field`, and an actionable `message`.
- `summary.byDestination`: `{ "destination": "GB", "parcels": 2 }` entries.
- `summary.byService`: `{ "service": "standard", "parcels": 2 }` entries.
- `summary.byDestinationAndService`: entries with `destination`, `service`, and
  `parcels` for each combination.

Summary arrays sort by normalized destination/service using ascending JavaScript
string order, not locale-dependent sorting. Pair entries sort by destination,
then service. Summary ordering and counts are independent of input order;
error row numbers intentionally follow the original input. `$` denotes the
whole row/document. Malformed JSON or a non-array root produces a document error
with `row: null`, zero row counts, and empty summaries; syntax-error wording may
vary by Node version. Invalid JSON cannot be partially recovered.

Exit statuses:

- **0**: valid manifest (including `[]`), or help.
- **1**: invalid JSON, invalid root, or one or more invalid rows. Valid rows still
  contribute to the summary when the root is an array.
- **2**: usage or file/stdin read failure. These errors go to stderr with no
  stdout report, even with `--json`.

### Filter summaries

Use `--destination CODE` and/or `--service NAME` to inspect a subset. Repeat either
option to select several values:

```sh
node parcel-manifest-cli.js --destination GB examples/manifest.json
# Summary: 2 GB parcels; overall counts remain 3 total, 3 valid, 0 invalid.

node parcel-manifest-cli.js --json --destination gb --service STANDARD examples/manifest.json
# Combined filters: 1 GB/standard parcel; validRows is still 3.

node parcel-manifest-cli.js --destination GB --destination US --service standard examples/manifest.json
# (GB OR US) AND standard: 2 parcels.

node parcel-manifest-cli.js --json --destination GB --destination US --service standard --service express examples/manifest.json
# (GB OR US) AND (standard OR express): all 3 parcels, each counted once.

node parcel-manifest-cli.js --destination CA examples/manifest.json
# No matching parcels; empty summary, exit 0 because the entire input is valid.

node parcel-manifest-cli.js --json --destination US examples/manifest-mixed.json
# Summary: 1 US parcel; still exit 1 with all original row 2/3 diagnostics.
```

Filters use exact matches after trimming and case normalization, just like parcel
values (destination uppercase, service lowercase). Repeated destinations match
**any destination**; repeated services match **any service**. When both groups
are supplied, **both groups must match**: OR within each group, AND between groups.
Duplicate normalized values are ignored, never double-counted. For example,
`--destination GB --destination " gb "` is identical to `--destination GB`.

Options may appear before or after the filename but before `--`. The forms
`--destination=GB` and `--service=express` also work; use `--service=--priority`
for a service name beginning with a dash. Missing/blank values (including a blank
repeat such as `--service standard --service=" "`) and malformed country codes
are usage errors (exit 2), not ignored filters.

**Only the summary is filtered.** `valid`, `totalRows`, `validRows`, `invalidRows`,
`errors`, original row numbers, and the exit status still describe the entire
input. Empty matches produce empty summary arrays, not a validation error.
Duplicate IDs are still checked across all rows, including excluded destinations.

Filtered text reports identify the active filters. Filtered JSON reports add
a top-level `filters` object, for example
`"filters": { "destination": ["GB", "US"], "service": "standard" }`. A group with
one unique value remains a string for compatibility; multiple unique values
are a sorted array. Text reports use the same representation. Filter metadata
and summary ordering are independent of option order or duplicate values.
Unfiltered and single-value reports remain unchanged. The library validator
remains unfiltered.

### Library API

```js
const { validateManifest, parseManifest } = require("./parcel-manifest.js");
const report = validateManifest(require("./examples/manifest.json"));
const emptyReport = parseManifest("[]"); // Same report shape, including parse errors.
```

## Compare two manifests

Use the separate comparison command with the **before** input first and the
**after** input second. Existing validation/filter commands are unchanged.

```sh
node parcel-manifest-compare-cli.js examples/manifest.json examples/manifest-today.json
# Added: CA-1; removed: GB-2; changed: US-1 (service and itemCount); unchanged: 1.

node parcel-manifest-compare-cli.js --json examples/manifest.json examples/manifest-today.json

# Pipe yesterday (before) into a readable comparison:
cat examples/manifest.json | node parcel-manifest-compare-cli.js - examples/manifest-today.json

# Pipe today (after) into a JSON comparison:
cat examples/manifest-today.json | node parcel-manifest-compare-cli.js --json examples/manifest.json -

node parcel-manifest-compare-cli.js --help
```

- IDs match after trimming and remain **case-sensitive**. Changing an ID is a
  removal plus an addition. All result categories sort by trimmed ID using
  ascending JavaScript string order, independent of manifest row order.
- Comparison uses the seven documented manifest fields. Surrounding whitespace
  is trimmed from all strings; destination (country code) is uppercased and service
  lowercased, consistently with validation. These formatting differences alone
  count as **unchanged**.
- `recipient`, `street`, and `postcode` remain **case-sensitive** after trimming;
  internal whitespace is preserved. For example, `"Alex"` versus `"alex"` and
  `"SW1A 1AA"` versus `"sw1a 1aa"` are changes; `" gb "` versus `"GB"` is not.
- Extra metadata is ignored even when added, removed, or edited. Only changes to
  the documented fields affect the comparison.
- Changed parcels list each differing field with its normalized old (`before`)
  and new (`after`) values, in this order: recipient, street, postcode, destination,
  service, itemCount. Text prints `field: old -> new`; JSON keeps numbers numeric.
- Text includes `Unchanged: N`; JSON includes `comparison.unchanged`. This counts
  matching IDs with no meaningful field changes, including formatting-only and
  metadata-only differences; added/removed parcels are not included.
- Both inputs must fully validate, including unique trimmed IDs. **Any invalid
  input blocks the entire comparison**—invalid rows never become apparent
  additions or removals. Both inputs are inspected even if the first fails.

```sh
node parcel-manifest-compare-cli.js --json examples/manifest-mixed.json examples/manifest-today.json
# Exit 1; comparison is null, with before-file diagnostics for original rows 2/3.

cat examples/manifest-mixed.json | node parcel-manifest-compare-cli.js --json examples/manifest.json -
# Exit 1; comparison is null, with after/stdin diagnostics for original rows 2/3.
```

Text mode prints the comparison to stdout and errors to stderr. `--json` emits
one report to stdout, with no validation/read diagnostics on stderr:

- `valid`: whether **both inputs** are valid, not whether they are identical.
- `inputs.before` / `inputs.after`: filename (or `"-"` for stdin), validity, and
  full-input row counts.
- `errors`: `{ input, file, row, field, message }`; `input` is `before` or `after`,
  and `row` is the original **one-based** array position. Document/read errors use
  `row: null`. Unreadable inputs have null row counts. Stdin errors use `file: "-"`
  in JSON; text identifies `before stdin (-)` or `after stdin (-)`.
- `comparison`: `null` on any input error; otherwise `added` and `removed` contain
  normalized parcel objects, `changed` contains `{ id, changes }` objects with
  `{ field, before, after }` entries, and `unchanged` is a parcel count.

Exit **0** means a completed comparison (even with differences), or help;
**1** means invalid input; **2** means usage/read failure (read failures take
precedence over validation errors). Read failures still produce a JSON report
with `--json`; usage errors produce only stderr. Each argument may name a UTF-8 file, read fully into memory. Use `-` for
exactly one argument to read that manifest from standard input; two `-` arguments
must produce a usage error. Invalid-input diagnostics must identify the before
or after input and retain its original row number. Use `--` before filenames
beginning with a dash. Comparison does not apply summary filters.

Two `-` operands are rejected before reading stdin, with exit 2 and a message to
provide a filename for one input. `-` still selects stdin after `--`; use `./-`
to read a literal file named `-`. Without a `-` operand, stdin is ignored.

## Tests

Run the project checks from the repository root:

```sh
node --test
git diff --check
```

Tests use built-in `node:test` and `node:assert/strict`; no installation is needed.
They preserve the existing parcel-label checks and cover malformed/mixed-validity
manifests, field validation, duplicates, deterministic summaries, and real CLI
subprocesses (files, stdin, JSON output, diagnostics, exit statuses, and summary-only
filters with repeated groups, deduplication, and combined/empty matches). Comparison
tests exercise real commands, deterministic diffs, old/new field values, unchanged
counts, per-field casing/whitespace rules, ignored metadata, and diagnostics from
both invalid inputs, including piped input on either side and early rejection
of two stdin operands.
