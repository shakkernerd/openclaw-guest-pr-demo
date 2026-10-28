# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The `parcelLabel(count)` helper in `parcel-label.js` returns an item-label string.
It is a named CommonJS export for Node.js, not a directly loadable browser script.

## Usage

Use Node.js 22 or newer and run the examples from the repository root. There is
no `package.json`, dependency installation, or build step. In a POSIX shell:

```sh
node <<'NODE'
const { parcelLabel } = require("./parcel-label.js");

console.log(parcelLabel(0)); // 0 items
console.log(parcelLabel(1)); // 1 item
console.log(parcelLabel(3)); // 3 items
NODE
```

### Integration

Callers must validate or explicitly convert count input before calling
`parcelLabel`; the helper does neither. This caller-side example accepts strings
containing nonnegative safe-integer counts, allowing surrounding whitespace.
`parseCount` is example code, not an exported API.

```sh
node <<'NODE'
const { parcelLabel } = require("./parcel-label.js");

function parseCount(raw) {
  const value = raw.trim();

  if (!value) {
    throw new Error("Enter a parcel count, such as 0 or 3.");
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      "Enter the actual count using digits 0–9 only, such as 3. " +
      "Spaces are allowed around the number, not inside it."
    );
  }

  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error(
      "Maximum supported count: 9007199254740991. Check for a typo. " +
      "If your count is larger, it cannot be accepted; do not reduce it to fit."
    );
  }
  return count;
}

for (const raw of ["0", " 001 ", "3", "   ", "1.5", "9007199254740992"]) {
  try {
    console.log(JSON.stringify(raw), "→", parcelLabel(parseCount(raw)));
  } catch (error) {
    console.log(JSON.stringify(raw), "→", error.message);
  }
}
NODE
```

The first three inputs print `0 items`, `1 item`, and `3 items` alongside the raw
input; the remaining inputs print validation errors.

### Edge cases

Only numeric `1` selects the singular `item` (`count === 1`); other values select
`items`. These direct calls bypass caller validation and show current behavior,
not recommended parcel counts.

```sh
node <<'NODE'
const { parcelLabel } = require("./parcel-label.js");

console.log(parcelLabel("1")); // 1 items (a string is not numeric 1)
console.log(parcelLabel(-1));  // -1 items
console.log(parcelLabel(1.5)); // 1.5 items
console.log(parcelLabel());   // undefined items
NODE
```

## Tests

Run the test suite from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`. They cover
numeric counts 0, 1, and 3, plus string `"1"` remaining plural.
