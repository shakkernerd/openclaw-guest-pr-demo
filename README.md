# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The `parcelLabel` helper lives in `parcel-label.js` and formats a count as an item
label. Its behavior is unchanged. The separate packaging planner uses CommonJS
and Node.js built-ins only; no dependency installation is needed.

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
- Boxes fill sequentially in that order. Every box except possibly the last is
  full. Zero-quantity SKUs do not appear in box contents. Empty/all-zero orders
  produce zero boxes, and exact capacity never creates an extra empty box.
- Plans are limited to **100,000 boxes** (`MAX_BOXES`), checked before allocating
  boxes. Increase capacity or split the order if it exceeds this limit. The
  planner works in quantity chunks rather than allocating one object per item.
  Input, SKU strings, and the resulting plan are held in memory; this is not a
  streaming interface or a general-purpose memory limit.
- Extra object fields are ignored; no shipment fields are required or validated.

### Command line

```sh
# Human-readable report from a file
node packaging-cli.js examples/order.json

# Machine-readable JSON from a file
node packaging-cli.js --json examples/order.json

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

- **0**: successful plan or help (`--help`/`-h`, used alone).
- **1**: unreadable input, malformed JSON, invalid order, exceeded limits, or
  output failure (including a broken pipe).
- **2**: unknown/repeated options or extra file arguments. Options are parsed
  before input is read. Only `--json`, `--help`/`-h`, and `--` are supported.

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
SKUs, quantities, or capacity; `RangeError` for aggregate overflow or excessive
box count. Row errors identify the zero-based input index.

## Tests

From the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`. They cover
the original parcel counts 0, 1, and 3 (`0 items`, `1 item`, `3 items`), planner
boundaries and deterministic ordering, generated conservation/capacity checks,
and real child-process CLI input, output, diagnostics, and exit statuses.
