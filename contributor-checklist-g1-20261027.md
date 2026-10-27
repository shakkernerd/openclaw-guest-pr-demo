# Disposable contributor checklist

Temporary contributor reference for `openclaw-guest-pr-demo`. This checklist
documents existing behavior; it does not change the implementation or tests.

## Review the existing source

- [ ] Read `README.md` for the test instructions.
- [ ] Inspect `parcel-label.js` and `parcel-label.test.js`.
- [ ] Confirm that `parcelLabel(count)` uses singular `item` only when
  `count === 1`, and plural `items` otherwise.

The existing zero-, one-, and three-item examples are:

```js
const { parcelLabel } = require("./parcel-label.js");

parcelLabel(0); // "0 items": an empty parcel uses the plural noun.
parcelLabel(1); // "1 item": one item uses the singular noun.
parcelLabel(3); // "3 items": three items use the plural noun.
```

## Run the existing tests

- [ ] Use Node.js 22 or newer, as specified in `README.md`.
- [ ] Run the existing command from the repository root:

  ```sh
  node --test
  ```

  This invokes Node.js’s built-in test runner, which discovers and runs
  `parcel-label.test.js`. The tests use `node:test` and `node:assert/strict`,
  so no dependency installation is needed. The three assertions check
  `parcelLabel(0) === "0 items"`, `parcelLabel(1) === "1 item"`, and
  `parcelLabel(3) === "3 items"`.

- [ ] Confirm that all three tests pass with no failures.

## Keep the change disposable and isolated

- [ ] Keep this checklist as the only new or changed file; leave all existing
  source, tests, and documentation unchanged.
- [ ] Review the diff before any later publication. Do not publish, share the
  conversation, or delegate work as part of creating this checklist.

## Verification recorded for this checklist

On 2026-10-27, `node --test` ran with Node.js v24.22.1: **3 tests passed,
0 failed**, with no cancelled, skipped, or todo tests (exit code 0).
