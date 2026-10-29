"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { packingChecklistStatus } = require("./packing-checklist.js");

const EXPECTED_CHECKS = [
  {
    id: "count",
    instruction: "Check that the item count matches the order.",
  },
  {
    id: "packing",
    instruction: "Pack the items securely with suitable cushioning, then seal the parcel.",
  },
  {
    id: "address",
    instruction: "Check that the delivery address is complete and matches the order.",
  },
];

test("default and empty marks leave all checks pending", () => {
  const expected = { complete: false, pending: EXPECTED_CHECKS };
  assert.deepEqual(packingChecklistStatus(), expected);
  assert.deepEqual(packingChecklistStatus(undefined), expected);
  assert.deepEqual(packingChecklistStatus([]), expected);
});

test("pending instructions match the original packing guide in order", () => {
  const guide = readFileSync(join(__dirname, "packing-guide.md"), "utf8");
  const instructions = Array.from(guide.matchAll(/^[0-9]+[.] (.+)$/gm), (match) => match[1]);
  assert.deepEqual(
    packingChecklistStatus().pending.map((check) => check.instruction),
    instructions,
  );
});

test("the documented consumer call reports only the remaining checks", () => {
  const status = packingChecklistStatus(["count"]);
  assert.deepEqual(status, { complete: false, pending: EXPECTED_CHECKS.slice(1) });
});

test("complete is true exactly when all three known IDs are marked", () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const completed = EXPECTED_CHECKS
      .filter((check, index) => mask & (1 << index))
      .map((check) => check.id);
    const pending = EXPECTED_CHECKS.filter((check) => !completed.includes(check.id));
    assert.deepEqual(packingChecklistStatus(completed), {
      complete: mask === 7,
      pending,
    });
  }
});

test("input order never changes the pending guide order", () => {
  assert.deepEqual(packingChecklistStatus(["packing"]), {
    complete: false,
    pending: [EXPECTED_CHECKS[0], EXPECTED_CHECKS[2]],
  });
  const expected = { complete: false, pending: [EXPECTED_CHECKS[1]] };
  assert.deepEqual(packingChecklistStatus(["address", "count"]), expected);
  assert.deepEqual(packingChecklistStatus(["count", "address"]), expected);
  assert.deepEqual(packingChecklistStatus(["address", "packing", "count"]), {
    complete: true,
    pending: [],
  });
});

test("duplicate completion marks are idempotent", () => {
  assert.deepEqual(
    packingChecklistStatus(["count", "count", "count"]),
    packingChecklistStatus(["count"]),
  );
  assert.deepEqual(
    packingChecklistStatus(["address", "count", "address", "packing", "count"]),
    { complete: true, pending: [] },
  );
});

test("non-array completion input throws TypeError", () => {
  for (const input of [null, true, 1, "count", {}, new Set(["count"]), new Uint8Array([1])]) {
    assert.throws(() => packingChecklistStatus(input), TypeError);
  }
});

test("non-string entries and sparse marks throw TypeError without coercion", () => {
  const uncoercible = {
    [Symbol.toPrimitive]() {
      throw new Error("A completion mark must not be coerced.");
    },
  };
  for (const entry of [undefined, null, 0, true, {}, [], new String("count"), Symbol("count"), 1n, uncoercible]) {
    assert.throws(() => packingChecklistStatus(["count", entry]), TypeError);
  }
  assert.throws(() => packingChecklistStatus(new Array(1)), TypeError);
});

test("unknown IDs throw TypeError, even after all checks are marked", () => {
  for (const id of ["", "COUNT", "count ", "label", "__proto__", "toString"]) {
    assert.throws(() => packingChecklistStatus([id]), TypeError);
    assert.throws(() => packingChecklistStatus(["count", "packing", "address", id]), TypeError);
  }
});

test("caller arrays remain unchanged on success and rejection", () => {
  const completed = Object.freeze(["address", "count", "count"]);
  assert.deepEqual(packingChecklistStatus(completed), {
    complete: false,
    pending: [EXPECTED_CHECKS[1]],
  });
  assert.deepEqual(completed, ["address", "count", "count"]);

  const invalid = Object.freeze(["count", "unknown"]);
  assert.throws(() => packingChecklistStatus(invalid), TypeError);
  assert.deepEqual(invalid, ["count", "unknown"]);
});

test("later caller changes do not alter an existing result", () => {
  const completed = ["count"];
  const status = packingChecklistStatus(completed);
  completed.push("packing");
  assert.deepEqual(status, { complete: false, pending: EXPECTED_CHECKS.slice(1) });
  assert.deepEqual(packingChecklistStatus(completed), {
    complete: false,
    pending: [EXPECTED_CHECKS[2]],
  });
});

test("result objects, arrays, and pending records are independent across calls", () => {
  const first = packingChecklistStatus();
  const second = packingChecklistStatus();
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.pending, second.pending);
  for (let index = 0; index < first.pending.length; index += 1) {
    assert.notStrictEqual(first.pending[index], second.pending[index]);
    first.pending[index].id = "changed";
    first.pending[index].instruction = "Changed instruction.";
  }
  first.pending.pop();
  first.complete = true;
  assert.deepEqual(second, { complete: false, pending: EXPECTED_CHECKS });
  assert.deepEqual(packingChecklistStatus(), { complete: false, pending: EXPECTED_CHECKS });

  const complete = packingChecklistStatus(["count", "packing", "address"]);
  complete.pending.push({ id: "changed", instruction: "Changed instruction." });
  assert.deepEqual(packingChecklistStatus(["count", "packing", "address"]), {
    complete: true,
    pending: [],
  });
});
