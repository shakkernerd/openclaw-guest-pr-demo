# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.
The fulfillment tool checks ordered quantities against packed items before dispatch.
It uses only Node.js built-ins; no dependency installation or network access is needed.

## Validate a shipment batch

With Node.js 22 or newer, run from this checkout:

```sh
node fulfill.js examples/shipments.json
node fulfill.js --help
```

Pass one UTF-8 JSON file, or `-` to read standard input, containing an **array of
shipments**. Each shipment has:

- `id`: a non-blank string, unique in the batch.
- `order`: a non-empty array of `{ "sku": "MUG-BLUE", "quantity": 2 }` lines.
- `parcels`: an array of `{ "id": "BOX-1001-A", "items": [...] }` objects. Each
  parcel needs a non-blank ID and a non-empty array of the same SKU/quantity lines.
  Use `parcels: []` for an entirely unpacked order.

Quantities must be positive safe integers, not strings, fractions, zero, or negative
numbers. Each shipment's ordered and packed totals must also stay within JavaScript's
safe integer range (at most 9007199254740991). IDs and SKUs are case-sensitive, exact
strings; whitespace is not trimmed. Extra fields (such as recipient metadata) are
ignored, not validated. An empty batch (`[]`) is accepted and reports zero shipments.

The CLI checks quantity tokens against their exact JSON source before accepting
them: `1.0000000000000001` is invalid, even though JavaScript would round it to 1.
Exactly integer-valued decimal and exponent forms such as `1.0`, `1e0`, and `100e-2`
are accepted when the value is in range. Fractional values are reported as
`INVALID_QUANTITY` with exit 1, not as JSON syntax errors.

Syntax is checked by native `JSON.parse`, without a recursive reviver. The precision
check uses an iterative token scan and, when needed, an iterative traversal, so
deeply nested ignored metadata does not fail because of JavaScript recursion depth.
No application nesting limit is imposed; the buffered input and parsing structures
must fit in memory.

Repeated SKU lines are added together, and an order can be split across parcels.
Validation compares **each SKU**, not just the overall count: missing quantities
must be packed, excess quantities (including unordered products) must be removed.
Parcel IDs must be unique across the whole batch, including within one shipment.
Every shipment involved in a duplicate assignment is blocked, including the first.

### Example: a tea-and-mug dispatch batch

The runnable [example batch](examples/shipments.json) has two orders. `SHIP-1001`
contains two blue mugs and one tea pouch, correctly split between two boxes:

```json
{
  "id": "SHIP-1001",
  "order": [
    { "sku": "MUG-BLUE", "quantity": 2 },
    { "sku": "TEA-100G", "quantity": 1 }
  ],
  "parcels": [
    { "id": "BOX-1001-A", "items": [{ "sku": "MUG-BLUE", "quantity": 2 }] },
    { "id": "BOX-1001-B", "items": [{ "sku": "TEA-100G", "quantity": 1 }] }
  ]
}
```

This is one shipment object; wrap it in an array to use it as a batch. The second
order in the example, `SHIP-1002`, has one mug missing and one extra tea pouch.
Both orders have three packed items, but only the first is correctly fulfilled.
Running the example prints:

```text
Shipment fulfillment summary
READY "SHIP-1001": 3 items packed / 3 items ordered; 2 parcels
BLOCKED "SHIP-1002": 3 items packed / 3 items ordered; 1 parcel
  - [MISSING_QUANTITY] shipments[1].parcels: SKU "MUG-BLUE": pack 1 more (ordered 2, packed 1).
  - [EXCESS_QUANTITY] shipments[1].parcels: SKU "TEA-100G": remove 1 (ordered 1, packed 2).
Summary: 1 ready, 1 blocked, 2 shipments.
```

The command intentionally exits **1** for this example. In `SHIP-1002`, change the
packed `MUG-BLUE` quantity from 1 to 2 and `TEA-100G` from 2 to 1, then rerun to
get two ready shipments and exit 0. For a duplicate parcel, the error names the
conflicting ID and every assignment path; correct the ID or remove the duplicated
assignment, then recheck quantities. Paths use zero-based array indexes.

### JSON reports and piped exports

Text remains the default. Add `--json` for dispatch automation; the option can
appear before or after the input filename:

```sh
node fulfill.js --json examples/shipments.json
node fulfill.js examples/shipments.json --json
cat examples/shipments.json | node fulfill.js --json -
cat examples/shipments.json | node fulfill.js -
```

The first three commands produce the same complete
[JSON report](examples/shipments.report.json); the fourth produces the original
text summary. Each intentionally exits 1 because the example includes one blocked
shipment. Substitute your export command for `cat examples/shipments.json` to pipe
a real batch. The command reads stdin until EOF and buffers the whole batch, so
duplicate assignments are checked across all shipments, not one input line at a time.

For exit 0 or 1, `--json` writes exactly one JSON object plus a trailing newline to
stdout, with no human summary mixed in. Its fields are:

- `valid`: overall validation result; true only when the entire batch passes.
- `total`, `ready`, `blocked`: shipment counts, with `ready + blocked === total`.
- `shipments`: results in input order, each containing `shipmentId`, `valid`,
  `expectedQuantity`, `packedQuantity`, `parcelCount`, and `errors`. IDs/counts
  that cannot be determined are `null`, not misleading partial totals.
- `errors`: the flattened list of shipment errors. Every error has an actionable
  `code`, zero-based input `path`, and `message`. For a non-array JSON root,
  `valid` is false, counts are zero, `shipments` is empty, and this list contains
  `INVALID_BATCH`. An empty array instead has `valid: true` and no errors.

Do not infer success from zero blocked shipments alone: check `valid` and the
exit status. Usage, input-read, and JSON syntax errors still exit 2, write only
a diagnostic to stderr, and leave stdout empty, even with `--json`. Help is human
text and exits 0 when written successfully. Output-write failures also exit 2, but
stdout may then be empty or partial. Consumers must check the exit code and discard
any incomplete report after a write failure.

Use `--` to end option parsing for dash-prefixed filenames, for example
`node fulfill.js --json -- -export.json`. A lone `-` always means stdin; use `./-`
for an actual file named dash. Missing input, unknown options, repeated output
options, combining `--json` with `--html`, and extra filenames are usage errors.
No dependencies or shell-specific pipeline features are required by the Node command.

### Offline HTML packing reports

Open the saved [sample HTML report](examples/shipments.report.html) directly in a
browser—no server, installation, network connection, or JavaScript is needed.
It shows the same tea-and-mug batch: one ready shipment and one blocked shipment
with equal overall counts but a missing mug and excess tea. Open the HTML file
itself to try the interactions.

Generate a fresh report with `--html` (before or after the filename):

```sh
node fulfill.js --html examples/shipments.json > packing-report.html
cat examples/shipments.json | node fulfill.js --html - > packing-report.html
```

Both commands intentionally exit **1** for this example **and still produce a
complete report**. Open `packing-report.html` in a browser. Exit 0 means validation
passed. Command/read/syntax errors exit 2 with empty stdout and a stderr diagnostic.
Output-write errors also exit 2; discard the possibly partial report and correct
the output destination before retrying. Do not combine `--html` and `--json`.
Text remains the default.
The shell redirection creates or overwrites the report file; never redirect to
your input JSON file. The command itself does not change the shipment data.

The report shows overall validity, total/ready/blocked counts, ordered and packed
quantities, parcel counts, and every actionable error code, input path, and message.
Blocked shipments come first with their details expanded; ready shipments follow
with collapsed details. Original input indexes are retained in all error paths.
Unknown quantities are labeled **Unknown**, and invalid batch roots show batch
issues rather than a misleading successful empty report.

Use the **Blocked** and **Ready** section links to navigate. Press **Tab** to focus
a shipment summary (labeled with status, ID, quantities, and issue count), then
**Enter** or **Space** to expand or collapse it. Focus has a visible outline;
status uses text as well as color. Native HTML disclosure controls work without
scripts. Shipment IDs, SKUs within messages, and all issue fields are escaped as
plain text—even if they contain markup. The self-contained document contains only
inline CSS and local section links: no external assets, scripts, or services.

This is a static snapshot, not a dispatch control. Apply corrections to the batch
and regenerate it; opening or expanding the report does not revalidate data.

### Output and exit codes

- **0:** all shipments pass (or the batch is empty) and no output-write error was
  reported; `--help`/`-h` also exits 0 when its output is written successfully.
- **1:** validation errors, including a valid JSON document with the wrong shape.
  The text, JSON, or HTML report and all validation errors go to stdout; processing
  continues through the batch so independent shipments are still reported.
- **2:** invalid arguments, unreadable file/stdin, malformed JSON, or an output-write
  failure. An actionable diagnostic goes to stderr without a stack trace. Argument,
  read, and syntax errors leave stdout empty. Write failures (such as a full device
  or a closed pipe) may leave partial output and override either validation status.
  Discard that output, fix the destination, and rerun. Successful writes are allowed
  to drain normally; the CLI does not force an early exit.

Malformed item data produces `unknown` totals rather than misleading partial
counts. Quantity comparisons are skipped for that shipment until both item lists
are valid; schema and duplicate-ID checks still run. The command only reads the
file: it does not alter orders, buy postage, print labels, or dispatch shipments.
`READY` means **packing validation passed**, not that the address or physical
packing has been checked. Follow the [packing guide](packing-guide.md),
[delivery checks](delivery-checks.md), and [label checks](label-checks.md) as well.

## JavaScript API

```js
const { validateShipment, validateBatch } = require("./packing.js");
const { parcelLabel } = require("./parcel-label.js");
const { parseBatchJson } = require("./fulfill.js");
const { formatHtmlReport } = require("./packing-report.js");
const { readFileSync } = require("node:fs");

const batch = parseBatchJson(readFileSync("./examples/shipments.json", "utf8"));
const shipment = validateShipment(batch[0]);
console.log(shipment.valid); // true
console.log(validateBatch(batch).valid); // false: the second shipment needs fixes
console.log(parcelLabel(1)); // "1 item" (existing label behavior is unchanged)
const html = formatHtmlReport(validateBatch(batch)); // Complete standalone HTML string
```

`validateShipment` returns `{ shipmentId, valid, expectedQuantity, packedQuantity,
parcelCount, errors }`. Unknown IDs/counts are `null`; each error has a stable
`code`, a `path`, and an actionable `message`. `validateBatch` returns
`{ valid, shipments, errors }`, with the per-shipment results in input order and
a flattened error list (or `INVALID_BATCH` for a non-array input). Both functions
leave their input unchanged. Use the batch API to catch cross-shipment duplicates;
the single-shipment API can only check assignments within that shipment.

For raw JSON, use `parseBatchJson` before validation, as shown above. It preserves
precision failures as `NaN` quantity values so the validator reports them at the
correct path. The validators alone receive JavaScript values and cannot recover
precision already lost through ordinary `JSON.parse` or numeric literals.

`formatHtmlReport` takes the result of `validateBatch`, does not modify it, and
returns a complete HTML document (without a trailing newline). It only presents
validation results; it does not parse JSON or perform additional validation.
The CLI adds a trailing newline consistently in every output mode.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`. They retain
the original label checks for 0, 1, and 3 (`0 items`, `1 item`, `3 items`) and cover
split packing, per-SKU shortages/excess, duplicate assignments, malformed input,
numeric limits, immutability, CLI exit codes, JSON/HTML reports, file and piped
input, markup escaping, native disclosure structure, and the exact text/JSON/HTML
example output and correction steps above. Regression checks cover deep ignored
metadata, large escaped strings, full output devices, closed pipes, and complete
large reports across all three formats and file/stdin input. The full-device checks
explicitly skip when `/dev/full` is unavailable; the other checks need only Node
built-ins.
