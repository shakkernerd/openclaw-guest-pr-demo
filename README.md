# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Batch dispatch report

With Node.js 22 or newer, run this command from the repository root:

```sh
node dispatch-report.js examples/orders.json
```

The input file must contain a JSON array of orders:

```json
[
  { "id": "ORD-003", "recipient": "Ada Lovelace", "itemCount": 1 },
  { "id": "ORD-001", "recipient": "Grace Hopper", "itemCount": 3 },
  { "id": "ORD-002", "recipient": "Katherine Johnson", "itemCount": 0 }
]
```

Output preserves the input order and reuses `parcel-label.js` for item labels:

```text
Dispatch report
Orders: 3
Total items: 4

1. ORD-003 | Ada Lovelace | 1 item
2. ORD-001 | Grace Hopper | 3 items
3. ORD-002 | Katherine Johnson | 0 items
```

### Select orders by ID

Put the file path first, then repeat `--id <ID>` for each order to include:

```sh
node dispatch-report.js examples/orders.json --id ORD-002 --id ORD-003 --id ORD-002
```

Selections keep the original batch order, not the order of the options. Repeating
an ID selects it only once. Report numbering restarts at 1 without gaps, and both
the order count and total items include only the reported orders:

```text
Dispatch report
Orders: 2
Total items: 1

1. ORD-003 | Ada Lovelace | 1 item
2. ORD-002 | Katherine Johnson | 0 items
```

Quote an ID containing spaces so the shell passes it as one argument. This
example uses the included order with ID `ORD WALK IN` and prints one order with
`Total items: 2`:

```sh
node dispatch-report.js examples/orders-with-spaces.json --id "ORD WALK IN"
```

`--id=<ID>` is also supported; use that form if an ID begins with `--` (for
example, `--id=--desk`). Selection is case-sensitive and trims surrounding
whitespace, while preserving spaces inside an ID. Omit all `--id` options to
report the full batch.

The **entire batch is validated before selection**, including orders that will
not appear in the report. Unknown selected IDs are listed in an error; they do
not silently disappear. For example, this exits with status 1 and no stdout:

```sh
node dispatch-report.js examples/orders.json --id ORD-003 --id UNKNOWN
```

### Exact totals and empty batches

Every report includes `Total items`. Each validated, parsed JavaScript count is
converted to built-in `BigInt` before addition. The total is printed as a plain
decimal integer and stays exact for those accepted counts even above
`Number.MAX_SAFE_INTEGER`; it does not recover precision lost during JSON
parsing (see below). No dependencies are needed. Run the large-count example
(9007199254740991 + 1 + 1):

```sh
node dispatch-report.js examples/orders-large-counts.json
```

It prints `Total items: 9007199254740993`, without rounding. For an empty batch:

```sh
node dispatch-report.js examples/orders-empty.json
```

```text
Dispatch report
Orders: 0
Total items: 0

No orders to dispatch.
```

### Input rules and errors

- Every order must be an object with `id`, `recipient`, and `itemCount`.
- `id` and `recipient` must be nonempty strings. Surrounding whitespace is
  trimmed; line breaks and control characters are rejected to keep each order
  on one readable line.
- IDs must be unique after trimming and are case-sensitive.
- `itemCount` must parse to a JavaScript number that is a nonnegative safe
  integer (`0` through `9007199254740991`). Validation applies to that parsed
  value: strings are not coerced, and fractional, negative, non-finite, or unsafe
  parsed numbers are rejected.
- Extra fields are ignored. An empty array (`[]`) succeeds with `Orders: 0`
  and `Total items: 0`, followed by `No orders to dispatch.`

The CLI uses standard `JSON.parse`, not a lossless numeric parser. The original
numeric spelling may round before validation: for example,
`1.0000000000000001` parses as `1`, `9007199254740991.1` parses as
`9007199254740991`, and `1e-400` parses as `0`. Those parsed values pass the
integer check. Supply counts as ordinary safe integer values such as `0`, `1`,
or `3`, without fractional or extreme exponent spellings; validation does not
check the original numeric spelling.

Supply exactly one file path (quote it if it contains spaces), followed by any
`--id` options. Missing option values, unsupported arguments, unreadable files,
malformed JSON, invalid fields, duplicate batch IDs, and unknown selected IDs
produce an error on stderr and exit status 1, with no partial report on stdout.
Order validation errors identify the one-based input position and offending field.
Successful reports go to stdout with exit status 0, so they can be saved:

```sh
node dispatch-report.js examples/orders.json > dispatch-report.txt
```

### Operator handoff

Retain the original JSON as the source for downstream comparisons. Report IDs
are trimmed display labels, not lossless copies of the source IDs. A downstream
exact-string comparison may treat surrounding whitespace as significant: for
example, the source ID `" ORD-003 "` is displayed as `ORD-003`, but those two
strings are not identical.

Do not reconstruct comparison keys from the printed report. Use the IDs from
the original JSON and follow the downstream system's comparison rules; report
selection and duplicate detection use trimmed IDs and do not define those rules.

### Programmatic use

The formatter is also available as a CommonJS helper. It returns a string
without a trailing newline and throws on invalid input without changing the batch:

```js
const { createDispatchReport } = require("./dispatch-report.js");
const report = createDispatchReport(orders);
const selectedReport = createDispatchReport(orders, ["ORD-002", "ORD-003"]);
```

The optional second argument is an array of IDs. Omitting it reports all orders;
an explicit empty array selects none and returns the zero-order, zero-total
report. Full-batch validation still applies. Neither input array is modified.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. Tests cover the existing parcel labels, report order and
formatting, empty batches, field validation, duplicate IDs, ordered selection,
deduplication, spaced IDs, exact large totals, and CLI success/error behavior
using temporary input files.
