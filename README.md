# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.
The number `1`, the exact string `"1"`, and the BigInt `1n` produce `1 item`.
All other values use `items`.

```js
const { parcelLabel } = require("./parcel-label.js");

parcelLabel(1);   // "1 item"
parcelLabel(0n);  // "0 items"
parcelLabel(1n);  // "1 item"
parcelLabel(3n);  // "3 items"
```

## Using counts from callers

With `parcelLabel` imported above:

```js
const formCount = "1"; // A form field's input.value.
parcelLabel(formCount); // "1 item"

const aggregatedCount = [9007199254740992n, 1n].reduce(
  (total, count) => total + count, 0n
);
parcelLabel(aggregatedCount); // "9007199254740993 items"

parcelLabel("01"); // "01 items"
parcelLabel(" 1 "); // " 1  items"
```

Keep the aggregate as a BigInt: converting it to `Number` can round values above
`Number.MAX_SAFE_INTEGER`. The helper displays its exact decimal digits without
the `n` suffix. It formats rather than parses or trims string counts, so padding
and whitespace stay intact; the usual separator adds another space before `items`.

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
