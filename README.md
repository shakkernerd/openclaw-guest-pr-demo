# openclaw-guest-pr-demo

Turn order quantities into a box-by-box packing plan, or get a compact summary of
box utilization. Compare both packing policies with `--compare`. Supply a JSON
file or pipe an order through standard input; read the text report yourself or
use JSON output in another program. Fix any reported
input error and rerun the same command. The CLI only reads the order, never edits it.

The planner uses CommonJS and Node.js built-ins only; no dependency installation
is needed. The existing `parcelLabel` helper in `parcel-label.js` is unchanged.

## Quickstart

With **Node.js 22 or newer**, run these commands from the repository root:

```sh
# Try the included order: 9 items packed into 3 boxes of capacity 4
node packaging-cli.js examples/order.json

# Use the same plan as JSON, or request only utilization totals
node packaging-cli.js --json examples/order.json
node packaging-cli.js --summary examples/order.json

# Pipe an order instead of naming a file; omitting - also reads stdin
cat examples/order.json | node packaging-cli.js --json -
```

For your own order, save the [input format below](#input) in a file and replace
`examples/order.json` with its path. Use `--mode single-sku` if each box must contain
only one SKU. Successful reports go to stdout and exit 0; errors go to stderr.

### Recover from an input error

Input errors name the quoted filename you supplied, or say `standard input` for
both piped forms. They exit **1**, leave stdout empty (even with `--json`), and do
not echo order contents. For example, this intentionally invalid capacity:

```sh
printf '%s\n' '{"items":[],"maxItemsPerBox":0}' | node packaging-cli.js -
```

produces this diagnostic on stderr:

```text
packaging: standard input: maxItemsPerBox must be a positive safe integer
```

Change the capacity to a positive integer and rerun. This corrected empty order
exits 0 and reports that no boxes are needed:

```sh
printf '%s\n' '{"items":[],"maxItemsPerBox":4}' | node packaging-cli.js -
```

For a file, a diagnostic such as `packaging: "order.json": items[0].quantity must
be a non-negative safe integer` tells you which file and zero-based item to fix.
- **Cannot read input:** check the named path and read permissions; for stdin,
  check the command supplying the input.
- **One valid JSON order required:** fix JSON syntax and supply exactly one JSON
  object, not multiple documents. The parser does not print potentially private
  input snippets.
- **Invalid shape, field, or limit:** use an object with `items` and
  `maxItemsPerBox`, then correct the named field or follow the limit diagnostic.
  Rerun the same file command, or pipe the corrected input again.

See [the input rules](#input) and [all exit statuses](#command-line) below.

## Packaging planner

This is an **item-count** planner, not a physical bin-packing or
shipment-validation tool: it does not consider dimensions, weight, addresses,
or shipping rules.

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

For the CLI (file or stdin, either mode, detailed, summary, or comparison output),
each used `quantity` and `maxItemsPerBox` numeric token must represent a **mathematical
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
SKU strings. For plans and summaries, `--json` writes the same object returned by
the module (below); comparisons contain both unchanged summary objects. JSON is
pretty-printed with a trailing newline. Success writes only to stdout. Errors
write a diagnostic to stderr, without a stack trace; input/argument errors produce
no stdout. Exit statuses are:

- **0**: successful plan, summary, comparison, or help (`--help`/`-h`, used alone).
- **1**: unreadable input, malformed JSON, invalid order, exceeded limits, or
  output failure (including a broken pipe).
- **2**: unknown/repeated options, a missing or invalid `--mode` value, extra
  file arguments, or `--compare` combined with `--summary` or any explicit `--mode`.
  Options are parsed before input is read. Supported options are `--json`,
  `--summary`, `--compare`, `--mode mixed|single-sku`, `--help`/`-h`, and `--`.
  Mode values are case-sensitive; use two arguments (`--mode single-sku`),
  not `--mode=single-sku`.

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

Without `--summary` or `--compare`, omitting `--mode`, or using `--mode mixed`,
leaves the default text and JSON output unchanged: no mode label or `mode` property
is added. In that
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
Without `--summary` or `--compare`, all existing detailed API and CLI output stays
unchanged. Mode is still selected by `--mode`, not an input JSON field.

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

### Compare packing policies (opt-in)

Use `--compare` to report the same order under both policies without generating
individual boxes. The CLI reads the order once and calls the existing
`summarizePackaging` API once for `mixed` and once for `single-sku`. It does not
call the detailed planner, apply `MAX_BOXES`, or do work per box. Input and SKU
aggregation still need to fit in memory, and all existing validation rules apply.
No module API or dependency is added; Node.js 22+ built-ins remain sufficient.

```sh
node packaging-cli.js --compare examples/order.json
node packaging-cli.js --compare --json examples/order.json
cat examples/large-order.json | node packaging-cli.js --compare -
node packaging-cli.js --compare --json -- -order.json
```

Text output is an aligned table, always `mixed` first and `single-sku` second.
Its columns are the existing summary fields: policy (`mode`), capacity
(`maxItemsPerBox`), items (`totalItems`), boxes (`boxCount`), full boxes
(`fullBoxes`), partial boxes (`partialBoxes`), and unused item slots
(`unusedItemSlots`). No percentages, differences, or recommendation are calculated.

For A=1, B=1, capacity=4, this command:

```sh
printf '%s\n' '{"items":[{"sku":"A","quantity":1},{"sku":"B","quantity":1}],"maxItemsPerBox":4}' | node packaging-cli.js --compare
```

prints:

```text
Policy     | Capacity | Items | Boxes | Full | Partial | Unused item slots
mixed      | 4        | 2     | 1     | 0    | 1       | 2
single-sku | 4        | 2     | 2     | 0    | 2       | 6
```

Adding `--json` to the same command prints an object keyed by policy, with each
unchanged seven-field summary nested under its key:

```json
{
  "mixed": {
    "mode": "mixed",
    "maxItemsPerBox": 4,
    "totalItems": 2,
    "boxCount": 1,
    "fullBoxes": 0,
    "partialBoxes": 1,
    "unusedItemSlots": "2"
  },
  "single-sku": {
    "mode": "single-sku",
    "maxItemsPerBox": 4,
    "totalItems": 2,
    "boxCount": 2,
    "fullBoxes": 0,
    "partialBoxes": 2,
    "unusedItemSlots": "6"
  }
}
```

Unused slots remain exact decimal strings, including `"0"` and values beyond the
safe-integer limit. Empty/all-zero orders still return both summaries with zero
counts; capacity must still be positive. Neither result includes a `boxes` array.

`--compare` cannot be combined with `--summary` or **any explicit `--mode`**,
including `--mode mixed`, in either argument order. These conflicts and repeated
`--compare` options exit **2** with empty stdout before reading a file or stdin.
Omitting `--mode` is valid: comparison itself selects both policies. A `mode` or
`compare` field inside the input JSON does not select CLI behavior.

File/stdin selection, `--`, source-labelled input errors (exit 1), output-failure
handling, and trailing newlines follow existing CLI conventions. Without
`--compare`, existing detailed and summary report output is unchanged; help and
argument-error usage text now also document comparison.

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
Comparison tests exercise actual CLI text/JSON, files/stdin, option terminators,
empty/repeated-SKU orders, exact large integers, pre-input conflicts with stdin
left open, malformed/raw fractional input, and broken pipes. Ordinary CLI runs
verify exact, compact text and JSON for maximum-safe-integer box counts within
the existing five-second per-process deadline, with no detailed boxes in the
result. These behavior checks do not instrument internal calls or allocations.
Run the focused comparison and existing CLI/summary compatibility checks with:

```sh
node --test packaging-compare.test.js packaging-cli.test.js packaging-summary.test.js
```
