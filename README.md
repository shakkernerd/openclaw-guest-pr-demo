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

Pass one UTF-8 JSON file containing an **array of shipments**. Each shipment has:

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

### Output and exit codes

- **0:** all shipments pass (or the batch is empty); `--help`/`-h` also exits 0.
- **1:** validation errors, including a valid JSON document with the wrong shape.
  The summary and all validation errors go to stdout; processing continues through
  the batch so independent shipments are still reported.
- **2:** missing/extra arguments, unreadable file, or malformed JSON. An actionable
  diagnostic goes to stderr without a stack trace.

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
const { readFileSync } = require("node:fs");

const batch = parseBatchJson(readFileSync("./examples/shipments.json", "utf8"));
const shipment = validateShipment(batch[0]);
console.log(shipment.valid); // true
console.log(validateBatch(batch).valid); // false: the second shipment needs fixes
console.log(parcelLabel(1)); // "1 item" (existing label behavior is unchanged)
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

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`. They retain
the original label checks for 0, 1, and 3 (`0 items`, `1 item`, `3 items`) and cover
split packing, per-SKU shortages/excess, duplicate assignments, malformed input,
numeric limits, immutability, CLI exit codes, and the exact example output above.
