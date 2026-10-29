# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively.

## Delivery-address formatting

`delivery-address.js` exports the CommonJS helper `formatDeliveryAddress(lines)`.
Pass a nonempty array of nonblank, single-line strings in the exact order wanted
on the label, including the recipient. The helper joins them with LF (`\n`) and
adds no trailing newline. Accepted strings remain unchanged, including Unicode,
combining characters, capitalization, punctuation, surrounding whitespace, and
duplicate lines. It does not trim or normalize output or mutate the input.

Nonarrays, missing/sparse entries (including inherited-only entries), and
nonstring entries throw `TypeError`; an empty array, blank lines, or embedded
line breaks throw `RangeError`. Blank means empty or whitespace-only according to
JavaScript `String.prototype.trim()`; trimming is used only to check blankness.
Prohibited line breaks are LF (U+000A), CR (U+000D), vertical tab (U+000B), form
feed (U+000C), NEL (U+0085), line separator (U+2028), and paragraph separator
(U+2029). No values are coerced to strings.

Run this consumer example from the repository root:

```sh
node <<'NODE'
const { formatDeliveryAddress } = require("./delivery-address.js");

const label = formatDeliveryAddress([
  "Zoë Martin",
  "12 rue des Écoles",
  "75005 Paris",
  "France",
]);

console.log(label);
NODE
```

Output:

```text
Zoë Martin
12 rue des Écoles
75005 Paris
France
```

`console.log` adds a terminal newline; the returned label has none.

This formats plain caller-supplied text only, not verified or HTML-escaped
address data. It does not verify identity, completeness, postal correctness, or
deliverability, and does not authorize dispatch. Even one nonblank line is
accepted. Callers remain responsible for address verification, safe rendering
in their chosen output context, and dispatch decisions; the existing manual
checks still apply.

`delivery-address.test.js` covers this contract using the same `node --test`
command above.
