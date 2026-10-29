# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Packing checklist status

`packingChecklistStatus(completedChecks = [])` is exported from
`packing-checklist.js` using CommonJS. It reports the caller's recorded completion
of the three existing [packing-guide steps](packing-guide.md):

| ID | Instruction |
| --- | --- |
| `count` | Check that the item count matches the order. |
| `packing` | Pack the items securely with suitable cushioning, then seal the parcel. |
| `address` | Check that the delivery address is complete and matches the order. |

Pass an array of these exact string IDs. Omitting the argument (or passing
`undefined` or `[]`) leaves all three steps pending. Duplicate IDs are harmless.
The result is `{ complete, pending }`: `complete` is true exactly when all three
known IDs are marked, and `pending` contains fresh `{ id, instruction }` records
for unchecked steps in the original guide order, regardless of input order.
The helper does not mutate the input or share mutable result objects across calls.

```js
const { packingChecklistStatus } = require("./packing-checklist.js");

const status = packingChecklistStatus(["count"]);
console.log(status);
// {
//   complete: false,
//   pending: [
//     {
//       id: "packing",
//       instruction: "Pack the items securely with suitable cushioning, then seal the parcel."
//     },
//     {
//       id: "address",
//       instruction: "Check that the delivery address is complete and matches the order."
//     }
//   ]
// }
```

A non-array argument, any non-string entry, or any unknown ID throws `TypeError`;
values are not coerced or trimmed. For example, `packingChecklistStatus("count")`,
`packingChecklistStatus([1])`, and `packingChecklistStatus(["COUNT"])` all throw.

This is a record of checklist marks, **not physical verification**. It does not
validate numeric item counts, inspect a parcel or address, format labels,
authorize printing or dispatch, or assign work. `complete: true` means only that
the caller supplied all three IDs. The existing `parcelLabel` behavior is unchanged.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively.

Packing checklist tests cover default, partial, and complete marks; guide text and
ordering; duplicate IDs; invalid input; and input/result independence. They also
exercise the documented consumer call through the exported helper.

Run the new helper's syntax checks and focused tests with:

```sh
node --check packing-checklist.js
node --check packing-checklist.test.js
node --test packing-checklist.test.js
```

This fixture has no separate build system or build step.
