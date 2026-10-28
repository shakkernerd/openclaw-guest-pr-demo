# Validated parcel batches

`d1-20261028-g3-parcel-batch.js` exports the CommonJS function
`parcelLabels(counts)`. It returns a new array of labels in input order, using
the existing `parcelLabel` helper without changing that helper's behavior.

## Input contract

- Pass an array of nonnegative safe integer **numbers**, from `0` through
  `Number.MAX_SAFE_INTEGER` (`9007199254740991`), inclusive.
- Empty arrays return a new empty array. Frozen arrays are supported.
- Negative zero (`-0`) is accepted and labeled `0 items`.
- A non-array input, or any non-number, fractional, or non-finite element,
  throws `TypeError`. This includes numeric strings, boxed numbers, `NaN`,
  infinities, and missing elements in sparse arrays.
- Negative or unsafe integer elements throw `RangeError`. Type checks happen
  first: for example, `-0.5` and `-Infinity` throw `TypeError`, not `RangeError`.
- Values are not coerced, and number-like objects' coercion hooks are not called.
- The caller's array is not mutated, including when an invalid batch throws.
  A batch containing an invalid element throws rather than returning partial labels.

## Runnable examples

Use Node.js 22 or newer and run from the repository root. No installation or
dependencies are needed.

```sh
node <<'NODE'
const assert = require("node:assert/strict");
const { parcelLabels } = require("./d1-20261028-g3-parcel-batch.js");

const counts = Object.freeze([0, 1, 3]);
const labels = parcelLabels(counts);
assert.deepEqual(labels, ["0 items", "1 item", "3 items"]);
assert.deepEqual(counts, [0, 1, 3]);
assert.deepEqual(parcelLabels([]), []);
assert.deepEqual(parcelLabels([Number.MAX_SAFE_INTEGER]), ["9007199254740991 items"]);
console.log(JSON.stringify(labels)); // ["0 items","1 item","3 items"]
console.log("Valid batch examples passed.");
NODE
```

Rejections do not coerce values:

```sh
node <<'NODE'
const assert = require("node:assert/strict");
const { parcelLabels } = require("./d1-20261028-g3-parcel-batch.js");

assert.throws(() => parcelLabels(1), TypeError);
assert.throws(() => parcelLabels([0, "1", 2]), TypeError);
assert.throws(() => parcelLabels([1.5]), TypeError);
assert.throws(() => parcelLabels([Infinity]), TypeError);
assert.throws(() => parcelLabels([-1]), RangeError);
assert.throws(() => parcelLabels([Number.MAX_SAFE_INTEGER + 1]), RangeError);

let coercions = 0;
const numberLike = {
  [Symbol.toPrimitive]() {
    coercions += 1;
    return 1;
  },
};
assert.throws(() => parcelLabels([numberLike]), TypeError);
assert.equal(coercions, 0);
console.log("Invalid batch examples passed; no coercion hooks ran.");
NODE
```

## Validation commands

Run just the batch tests:

```sh
node --test d1-20261028-g3-parcel-batch.test.js
```

Run the full suite, including the unchanged original tests:

```sh
node --test
```

Both commands use the existing built-in `node:test` runner and
`node:assert/strict`. The project has no `package.json`, package scripts, or
declared build/lint checks. No configuration or tooling changes are required.
