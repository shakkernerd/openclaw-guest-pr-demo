# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.
The number `1`, the exact string `"1"`, and the BigInt `1n` produce `1 item`, so
counts supplied as strings (for example, from form fields) or BigInts (for
example, from aggregations) use the same singular label. All other values use
`items`. The count is displayed without trimming or numeric conversion; for
example, `"01"` remains `01 items`, and `3n` produces `3 items`.

```js
const { parcelLabel } = require("./parcel-label.js");

parcelLabel(1);   // "1 item"
parcelLabel("1"); // "1 item"
parcelLabel("3"); // "3 items"
parcelLabel(0n);  // "0 items"
parcelLabel(1n);  // "1 item"
parcelLabel(3n);  // "3 items"
```

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3 as numbers, strings,
and BigInts, expecting `0 items`, `1 item`, and `3 items`, respectively. They also
check that other values such as `"01"`, `"1.0"`, `" 1 "`, and `true` are not
coerced to the singular form.
