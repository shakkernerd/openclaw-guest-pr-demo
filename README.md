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

1. ORD-003 | Ada Lovelace | 1 item
2. ORD-001 | Grace Hopper | 3 items
3. ORD-002 | Katherine Johnson | 0 items
```

### Input rules and errors

- Every order must be an object with `id`, `recipient`, and `itemCount`.
- `id` and `recipient` must be nonempty strings. Surrounding whitespace is
  trimmed; line breaks and control characters are rejected to keep each order
  on one readable line.
- IDs must be unique after trimming and are case-sensitive.
- `itemCount` must be a JSON number that is a nonnegative safe integer
  (`0` through `9007199254740991`). Strings, fractions, and larger numbers are
  rejected rather than coerced or accepted with unsafe precision.
- Extra fields are ignored. An empty array (`[]`) succeeds with `Orders: 0`
  and `No orders to dispatch.`

Supply exactly one file path (quote it if it contains spaces). Missing or extra
arguments, unreadable files, malformed JSON, invalid fields, and duplicate IDs
produce an error on stderr and exit status 1, with no partial report on stdout.
Order validation errors identify the one-based input position and offending field.
Successful reports go to stdout with exit status 0, so they can be saved:

```sh
node dispatch-report.js examples/orders.json > dispatch-report.txt
```

The formatter is also available as a CommonJS helper. It returns a string
without a trailing newline and throws on invalid input without changing the batch:

```js
const { createDispatchReport } = require("./dispatch-report.js");
const report = createDispatchReport(orders);
```

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. Tests cover the existing parcel labels, report order and
formatting, empty batches, field validation, duplicate IDs, and CLI success/error
behavior using temporary input files.
