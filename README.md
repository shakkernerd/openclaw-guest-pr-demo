# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Input behavior and examples

`parcelLabel` formats its input; it does not validate that the input is a parcel
count. Only the number `1` selects the singular `item`. Numeric strings are
accepted without conversion or trimming, so the string `"1"` produces
`"1 items"`, not `"1 item"`. Leading zeros, decimal notation, and whitespace
are preserved. Callers that need validated numeric counts must validate them
before calling this helper.

Run these examples from the repository root with Node.js 22 or newer:

```sh
node <<'NODE'
const { parcelLabel } = require("./parcel-label.js");

console.log(JSON.stringify(parcelLabel(1)));     // "1 item"
console.log(JSON.stringify(parcelLabel("1")));   // "1 items"
console.log(JSON.stringify(parcelLabel("01")));  // "01 items"
console.log(JSON.stringify(parcelLabel("1.0"))); // "1.0 items"
console.log(JSON.stringify(parcelLabel(" 1 "))); // " 1  items"
NODE
```

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively. Numeric-string boundary tests also verify
that strings are accepted as-is, without numeric coercion or whitespace trimming.

To run only the numeric-string boundary tests:

```sh
node --test --test-name-pattern='numeric strings' parcel-label.test.js
```

There is no `package.json`, package script, or declared build/lint check in this
project; `node --test` is the full existing test-suite command.

## Labels CLI

The [labels CLI](d1-20261028-g3-labels-cli.js) reads a JSON array of nonnegative
safe integer counts from stdin or a saved file and writes one label per line.
Show usage and an example from the repository root:

```sh
node d1-20261028-g3-labels-cli.js --help
```

See the [detailed CLI guide](d1-20261028-g3-cli-guide.md) for runnable commands,
file input, validation rules, and exit codes.
