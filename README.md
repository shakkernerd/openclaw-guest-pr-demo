# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The `parcelLabel` helper lives in `parcel-label.js` and formats a count as an item
label. Its behavior is unchanged. The packaging planner and fulfillment validator
use CommonJS and Node.js built-ins only; no dependency installation is needed.

## Plan, record, validate, report

Use the existing commands in sequence; a proposed plan is **not recorded
fulfillment**. Neither command writes packing records or dispatches shipments.

1. **Plan** the order using `packaging-cli.js` (mixed boxes by default, or
   `--mode single-sku`). Use `--summary` for compact utilization instead of boxes.
2. **Pack and record** the actual contents with unique shipment and parcel IDs.
   Store those observations in the fulfillment batch, separately from the plan.
3. **Validate** that batch using `fulfill.js`. Correct missing/excess SKUs, invalid
   data, and duplicate assignments; then rerun.
4. **Report** the same recorded batch as text, JSON, or offline HTML. Check the
   exit status and overall validity, then complete physical, address, and label
   checks before dispatch. Reports are snapshots, not dispatch authorization.

### Worked handoff using the existing order

```sh
node packaging-cli.js examples/order.json
node packaging-cli.js --summary --json examples/order.json
node packaging-cli.js --mode single-sku examples/order.json
```

This order has B=6 and A=3 at capacity 4. The mixed proposal is B=4, then
B=2/A=2, then A=1; the single-SKU proposal is B=4, then B=2, then A=3.
Both propose 3 boxes and 3 unused item slots, but different contents.

Suppose only the first B=4 parcel has actually been packed and checked. Save
this **recorded** batch as `recorded-shipments.json`, not as a replacement for
the order or plan:

```json
[
  {
    "id": "WORKFLOW-1",
    "order": [
      { "sku": "B", "quantity": 2 },
      { "sku": "A", "quantity": 3 },
      { "sku": "B", "quantity": 4 }
    ],
    "parcels": [
      { "id": "ACTUAL-1", "items": [{ "sku": "B", "quantity": 4 }] }
    ]
  }
]
```

```sh
node fulfill.js recorded-shipments.json
node fulfill.js --json recorded-shipments.json
node fulfill.js --html recorded-shipments.json > recorded-report.html
```

All three commands exit **1** and report 4 packed / 9 ordered, one parcel,
and shortages of B=2 and A=3. A complete proposal does not fill these shortages.
After physically packing and checking the remaining items, explicitly add the
actual parcel records. For example, if following the single-SKU proposal, record
`ACTUAL-2` with B=2 and `ACTUAL-3` with A=3. The unchanged order now validates
as 9 packed / 9 ordered, 3 parcels, exit **0** in all formats. Reuse neither
parcel ID elsewhere in the batch. Never copy proposed boxes into `parcels` as
proof that packing happened. When nothing is packed, record `parcels: []`;
omitting it is invalid, and extra `proposal` or `boxes` fields are ignored.

### Boundaries that intentionally differ

| Concern | Planning | Recorded fulfillment |
| --- | --- | --- |
| Input | One object: `items`, `maxItemsPerBox` | Array of shipments: `id`, `order`, `parcels` |
| Quantities | Non-negative; empty/all-zero orders allowed | Positive; non-empty order and parcel item lists |
| Capacity/mode | Enforced by planner | Not shipment-validation rules |
| Identity | Exact SKU aggregation | Exact SKU matching plus batch-wide shipment/parcel ID uniqueness |
| No file argument | Read stdin | Usage error; stdin requires `-` |
| Output default | Detailed text plan | Text validation report |
| Exit 1 | Input/planning/output failure | Completed report with validation errors |
| Exit 2 | Argument error | Usage/read/JSON/output-write failure |

A summary contains no boxes and cannot be used as a packing record. Fulfillment
checks actual SKU quantities and assignments, not capacity, SKU separation, or
physical packing quality. Recorded parcels may legitimately differ from a proposal;
plan counts and report counts agree only when the actual records match that plan.

Only raw-number scanning and decimal-integrality detection are shared internally
in `exact-json.js`. Native `JSON.parse` still owns syntax and duplicate keys.
Each CLI retains its own field rules, diagnostics, and invalid-value handling.
The exported `parseBatchJson` still marks only fractional tokens rounded to
positive safe integers in `quantity` properties as `NaN` (including nested metadata);
other numbers, root values, numeric strings, and already-invalid quantities keep
their native parsed values. It coerces its input once and does not validate a batch.
Planning also guards fractions rounded to zero because zero is allowed there.
Neither shared scanning nor the module APIs conflate planning with fulfillment.

## Packaging planner

Requires Node.js 22 or newer. This is an **item-count** planner, not a physical
bin-packing or shipment-validation tool: it does not consider dimensions, weight,
addresses, or shipping rules.

### Input

An order is a JSON object with `items` and `maxItemsPerBox`. For example, save this
as `order.json` (or use the included `examples/order.json`):

```json
{
  "items": [
    { "sku": "B", "quantity": 2 },
    { "sku": "A", "quantity": 3 },
    { "sku": "B", "quantity": 4 }
  ],
  "maxItemsPerBox": 4
}
```

- `items` must be an array of objects with a non-blank string `sku` and a
  non-negative safe integer number `quantity`. Zero quantities are allowed.
- `maxItemsPerBox` must be a positive safe integer number, even for empty orders.
- Counts and capacity must be at most `Number.MAX_SAFE_INTEGER`
  (`9007199254740991`). The **combined order total** must also stay within that
  limit. Strings, nulls, fractions, negative quantities, and non-finite or unsafe
  numbers are rejected, not coerced.
- Matching SKUs are combined **before** packing, preserving their first appearance
  in the input, including a first appearance with zero quantity. SKU matching is
  exact and case-sensitive; surrounding whitespace is not trimmed.
- By default, boxes fill sequentially in that order and may mix SKUs. Every box
  except possibly the last is full. Opt-in `single-sku` mode keeps each SKU's
  partial box separate (see below). In both modes, zero-quantity SKUs do not appear
  in box contents, empty/all-zero orders produce zero boxes, and exact capacity
  never creates an extra empty box.
- Detailed plans are limited to **100,000 boxes** (`MAX_BOXES`), checked before allocating
  any boxes. Mixed mode counts `ceil(totalItems / maxItemsPerBox)`; single-SKU mode
  sums `ceil(combinedSkuQuantity / maxItemsPerBox)` over distinct SKUs. Increase
  capacity or split the order if it exceeds this limit; more than 100,000 nonzero
  distinct SKUs always requires splitting in single-SKU mode. The
  planner works in quantity chunks rather than allocating one object per item.
  Input, SKU strings, and the resulting plan are held in memory; this is not a
  streaming interface or a general-purpose memory limit. Summary-only output does
  not allocate boxes and is exempt from this box-count limit (see below).
- Extra object fields are ignored; no shipment fields are required or validated.

#### Exact JSON numbers versus JavaScript Numbers

For the CLI (file or stdin, either mode, detailed or summary output), each used
`quantity` and `maxItemsPerBox` numeric token must represent a **mathematical
integer in decimal**, not merely round to an integer when parsed as a JavaScript
Number. Decimal points and exponents are allowed: `1.0`, `3e0`, and `300e-2`
represent integers and remain valid. Sign, safe-integer, aggregate-total, and
box-count rules above still apply. Zero (including `-0`) is allowed for quantity,
not capacity; numeric strings are not coerced.

For example, raw `2.9999999999999999` as capacity and raw
`1.0000000000000001` as quantity are rejected with exit status 1 and no stdout,
even though ordinary `JSON.parse` rounds them to `3` and `1`. Nonzero fractions
that underflow to zero (such as `1e-400`) are also rejected. The CLI first validates
syntax with native `JSON.parse`, then checks original numeric tokens in a
non-recursive pass that leaves quoted strings untouched. It checks decimal scale
and trailing zeros without allocating huge powers of ten. Tokens that would
otherwise round to valid integers are marked invalid for existing count
validation; native parsing retains escaped keys and last-property-wins behavior.
SKU strings are not interpreted as numbers, and extra/overwritten fields remain
ignored, including deeply nested arrays or objects. No recursive reviver or
`context.source` support is needed. Node.js 22 remains the minimum supported
version. Input and temporary parsing data must still fit in memory; this is not
a streaming parser or an arbitrary-size input guarantee.

The module APIs accept **already-created JavaScript Number values**. Their
`Number.isSafeInteger` contract is unchanged: they cannot recover text lost to
JavaScript literal rounding or a caller's earlier `JSON.parse`. Thus passing
`Number("1.0000000000000001")` to the module is indistinguishable from passing
`1`. Callers handling raw JSON need source-aware validation if they require the
CLI's stronger decimal-input guarantee; neither module accepts numeric strings
or arbitrary-precision quantities.

### Command line

```sh
# Human-readable report from a file
node packaging-cli.js examples/order.json

# Machine-readable JSON from a file
node packaging-cli.js --json examples/order.json

# Integral decimal and exponent spellings are accepted
node packaging-cli.js --json examples/integer-spellings-order.json

# Standard input (no file argument, or explicit -)
cat examples/order.json | node packaging-cli.js
cat examples/order.json | node packaging-cli.js --json -

# Help; -- allows a filename beginning with a dash
node packaging-cli.js --help
node packaging-cli.js --json -- -order.json
```

The default text report for the example is:

```text
Packing plan: 9 items in 3 boxes (capacity: 4 items per box)
Box 1: 4 items
  "B": 4
Box 2: 4 items
  "B": 2
  "A": 2
Box 3: 1 item
  "A": 1
```

SKUs are JSON-quoted in text reports; ASCII and C1 controls, DEL, and Unicode
line/paragraph separators are escaped visibly. JSON output preserves the original
SKU strings. `--json` writes the same object returned by the module (below),
pretty-printed with a trailing newline. Success writes only to stdout. Errors
write a diagnostic to stderr, without a stack trace; input/argument errors produce
no stdout. Exit statuses are:

- **0**: successful plan, summary, or help (`--help`/`-h`, used alone).
- **1**: unreadable input, malformed JSON, invalid order, exceeded limits, or
  output failure (including a broken pipe).
- **2**: unknown/repeated options, a missing or invalid `--mode` value, or extra
  file arguments. Options are parsed before input is read. Supported options are
  `--json`, `--summary`, `--mode mixed|single-sku`, `--help`/`-h`, and `--`. Mode values are
  case-sensitive; use two arguments (`--mode single-sku`), not `--mode=single-sku`.

### CommonJS API

```js
const { planPackaging, MAX_BOXES } = require("./packaging.js");
const order = require("./examples/order.json");
const plan = planPackaging(order.items, order.maxItemsPerBox);
```

The example returns:

```json
{
  "maxItemsPerBox": 4,
  "totalItems": 9,
  "boxes": [
    { "contents": [{ "sku": "B", "quantity": 4 }], "totalItems": 4 },
    { "contents": [{ "sku": "B", "quantity": 2 }, { "sku": "A", "quantity": 2 }], "totalItems": 4 },
    { "contents": [{ "sku": "A", "quantity": 1 }], "totalItems": 1 }
  ]
}
```

Boxes are ordered; their array index plus one is their report number. Each box
contains at most one row per SKU and its own total item count. `boxes.length` is
the total number of boxes. The function does not mutate the input, and returns
fresh output objects each time. It throws `TypeError` for invalid arrays, rows,
SKUs, quantities, capacity, or mode/options; `RangeError` for aggregate overflow
or excessive box count. Row errors identify the zero-based input index.

### Single-SKU boxes (opt-in)

For warehouse orders that must not mix different SKUs in the same box, pass an
optional third argument to the module:

```js
const { planPackaging } = require("./packaging.js");
const order = require("./examples/single-sku-order.json");
const plan = planPackaging(order.items, order.maxItemsPerBox, { mode: "single-sku" });
```

The options argument must be an object. Its `mode` may be `"mixed"` (default) or
`"single-sku"`. Omitted options, `{}`, or `mode: undefined` all keep mixed mode;
other mode values (including `null`, booleans, or unknown strings) throw
`TypeError`, even for an empty order. Existing two-argument callers, and explicit
`{ mode: "mixed" }` calls, retain the exact original output shape.

Single-SKU mode still combines repeated SKU rows in first-appearance order before
packing. Each combined SKU is split across boxes as needed, but its partial box
is never topped up with a different SKU. Zero-quantity rows never create boxes.

For the CLI, select the mode with a flag, **not a field in the order JSON**. The
order input format is unchanged. Try the included A=2, B=2, capacity=3 example:

```sh
node packaging-cli.js --mode single-sku examples/single-sku-order.json
node packaging-cli.js --mode single-sku --json examples/single-sku-order.json
cat examples/single-sku-order.json | node packaging-cli.js --mode single-sku --json -
```

Text output identifies the selected mode:

```text
Packing plan: 4 items in 2 boxes (capacity: 3 items per box)
Mode: single-sku (one SKU per box)
Box 1: 2 items
  "A": 2
Box 2: 2 items
  "B": 2
```

The module result and CLI JSON contain the following extra `mode` field only in
single-SKU mode, including for empty plans:

```json
{
  "maxItemsPerBox": 3,
  "totalItems": 4,
  "boxes": [
    { "contents": [{ "sku": "A", "quantity": 2 }], "totalItems": 2 },
    { "contents": [{ "sku": "B", "quantity": 2 }], "totalItems": 2 }
  ],
  "mode": "single-sku"
}
```

Without `--summary`, omitting `--mode`, or using `--mode mixed`, leaves the default
text and JSON output unchanged: no mode label or `mode` property is added. In that
default mode, the same order packs A=2 and B=1 into the first box, then B=1 into the
second.

### Compact utilization summaries (opt-in)

Use `summarizePackaging(items, maxItemsPerBox, options?)` when only utilization
counts are needed, especially for orders too large for a detailed plan:

```js
const { summarizePackaging } = require("./packaging.js");
const order = require("./examples/order.json");
const summary = summarizePackaging(order.items, order.maxItemsPerBox);
const singleSkuSummary = summarizePackaging(order.items, order.maxItemsPerBox, {
  mode: "single-sku",
});
```

The first call returns this JSON-safe object, with no `boxes` array:

```json
{
  "mode": "mixed",
  "maxItemsPerBox": 4,
  "totalItems": 9,
  "boxCount": 3,
  "fullBoxes": 2,
  "partialBoxes": 1,
  "unusedItemSlots": "3"
}
```

- `mode` is always included in summaries, even for mixed or empty orders.
- `maxItemsPerBox` is the capacity. `totalItems` counts all items across SKU rows.
- `fullBoxes` counts boxes exactly at capacity; `partialBoxes` counts nonempty
  boxes below capacity. Their sum is `boxCount`.
- `unusedItemSlots` is the sum of unfilled capacity across all required boxes.
  It is **always an exact decimal string**, including `"0"`, so its JSON type does
  not change when the value exceeds `Number.MAX_SAFE_INTEGER`. All other counts
  are numbers. Empty and all-zero orders have zero counts and `"0"` unused slots.

The summary API shares the planner's input validation, error types, option
defaults, and first-appearance SKU aggregation. Inputs are not mutated. It still
rejects invalid capacity, quantities, mode/options, or an aggregate order total
greater than `9007199254740991`. It does **not** apply `MAX_BOXES`: for example,
`9007199254740991` items at capacity 1 can be summarized as that many full boxes,
while a detailed plan rejects the same order before allocating boxes.

Calculation uses built-in `BigInt` integer division and remainders on the total in
mixed mode, or each combined SKU quantity in single-SKU mode. A nonzero remainder
creates one partial box and contributes `capacity - remainder` unused slots.
Zero quantities do not create boxes. All box counts remain safe numbers because
each box has at least one item and the total item count is safe. Unused slots are
converted directly from `BigInt` to a decimal string; no raw `BigInt` is returned.
Do not recompute them using Number multiplication: even a safe result can be
wrong if the intermediate `boxCount * capacity` is unsafe.

Summaries perform no per-box allocation or per-box loop. Time is proportional to
input rows plus distinct SKUs, and aggregation retains one Map entry per SKU.
Output has a fixed set of seven scalar fields regardless of the box count. Input
JSON and aggregation still need to fit in memory; this is not streaming input or
support for arbitrary-size numeric quantities.

#### Summary CLI

Add `--summary` for a two-line text report, or combine it with `--json`. It works
with either mode and the same file/stdin input, diagnostics, and exit statuses.
Without `--summary`, all existing detailed API and CLI output stays unchanged.
Mode is still selected by `--mode`, not an input JSON field.

```sh
node packaging-cli.js --summary examples/order.json
node packaging-cli.js --summary --json examples/order.json
cat examples/order.json | node packaging-cli.js --summary --mode single-sku -
node packaging-cli.js --summary --mode single-sku --json examples/single-sku-order.json

# Too many boxes for a detailed plan, but a compact summary works in either mode
node packaging-cli.js --summary --json examples/large-order.json
node packaging-cli.js --summary --mode single-sku examples/large-order.json
```

The first command prints:

```text
Mode: mixed | Capacity: 4
9 items | 3 boxes: 2 full, 1 partial | 3 unused item slots
```

For the same order, single-SKU mode reports 1 full and 2 partial boxes, with the
same 3 unused slots. For `examples/single-sku-order.json` (A=2, B=2, capacity=3),
mixed mode has 1 full and 1 partial box; single-SKU mode has 2 partial boxes.
Both require 2 boxes with 2 unused slots.

#### Exact arithmetic examples

| Order | Capacity | Mode | Full / partial boxes | Exact unused slots (string) |
| --- | ---: | --- | --- | --- |
| A=9007199254740991 | 4503599627370495 | mixed or single-sku | 2 / 1 | `"4503599627370494"` |
| A=1, B=2 | 9007199254740991 | single-sku | 0 / 2 | `"18014398509481979"` |
| A=9007199254740991 | 1 | either | 9007199254740991 / 0 | `"0"` |

The first example's Number multiplication/subtraction would incorrectly produce
`4503599627370493`; the second would produce `18014398509481980`. Summary arithmetic
avoids both errors. Try them directly through stdin:

```sh
printf '%s\n' '{"items":[{"sku":"A","quantity":9007199254740991}],"maxItemsPerBox":4503599627370495}' | node packaging-cli.js --summary --json
printf '%s\n' '{"items":[{"sku":"A","quantity":1},{"sku":"B","quantity":2}],"maxItemsPerBox":9007199254740991}' | node packaging-cli.js --summary --mode single-sku --json -
```

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

## Fulfillment JavaScript API

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

From the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`. They cover
the original parcel counts 0, 1, and 3 (`0 items`, `1 item`, `3 items`), planner
boundaries and deterministic ordering in both modes, generated conservation/capacity
checks, pre-allocation single-SKU box limits, invalid options/modes, legacy-output
compatibility, and real child-process CLI input, output, diagnostics, and exit statuses.
Summary coverage includes both exact-arithmetic examples above, shared validation,
empty/repeated-SKU orders, 660 comparisons against detailed plans, and compact
maximum-safe-integer box counts under a child-process deadline with a box-allocation
guard. Detailed-plan limits remain tested independently. Raw-number regressions
exercise the reported rounded fractions through real files and stdin, both modes
and report types, integral decimal/exponent spellings, underflow, safe boundaries,
escaped/duplicate keys, ignored extras, and the unchanged module Number contract.
Nesting regressions cover 3,000-level arrays and 20,000-level objects in ignored
or overwritten fields through files/stdin, both modes, and both report types;
invalid used counts and malformed JSON must still fail with the right diagnostic.

The fulfillment tests additionally cover split packing, per-SKU shortages/excess,
duplicate assignments, malformed input,
numeric limits, immutability, CLI exit codes, JSON/HTML reports, file and piped
input, markup escaping, native disclosure structure, and the exact text/JSON/HTML
example output and correction steps above. Regression checks cover deep ignored
metadata, large escaped strings, full output devices, closed pipes, and complete
large reports across all three formats and file/stdin input. The full-device checks
explicitly skip when `/dev/full` is unavailable; the other checks need only Node
built-ins.

The integration checks in `packing-workflow.test.js` exercise both planning modes,
detail/summary agreement, proposals with no recorded parcels, explicitly recorded
packing, SKU corrections, and duplicate assignments through the real CLIs. They
compare file/stdin text, JSON, and HTML validation results, retain the distinct
zero/empty-input/error contracts and exported parser behavior, and check that the
shared scanner handles escape-heavy metadata in every planning output mode.
