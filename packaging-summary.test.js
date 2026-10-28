"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { planPackaging, summarizePackaging, MAX_BOXES } = require("./packaging.js");

const row = (sku, quantity) => ({ sku, quantity });
const modes = ["mixed", "single-sku"];
const max = Number.MAX_SAFE_INTEGER;

test("summary reports all utilization fields for both packing modes", () => {
  const items = [row("A", 2), row("B", 2)];
  assert.deepEqual(summarizePackaging(items, 3), {
    mode: "mixed", maxItemsPerBox: 3, totalItems: 4, boxCount: 2,
    fullBoxes: 1, partialBoxes: 1, unusedItemSlots: "2",
  });
  assert.deepEqual(summarizePackaging(items, 3, { mode: "single-sku" }), {
    mode: "single-sku", maxItemsPerBox: 3, totalItems: 4, boxCount: 2,
    fullBoxes: 0, partialBoxes: 2, unusedItemSlots: "2",
  });
});

test("summary aggregates repeated SKUs before counting full and partial boxes", () => {
  const items = [row("B", 0), row("A", 1), row("B", 1), row("A", 2), row("C", 0)];
  assert.deepEqual(summarizePackaging(items, 3, { mode: "single-sku" }), {
    mode: "single-sku", maxItemsPerBox: 3, totalItems: 4, boxCount: 2,
    fullBoxes: 1, partialBoxes: 1, unusedItemSlots: "2",
  });
  for (const mode of modes) {
    assert.deepEqual(summarizePackaging([row("A", 3), row("B", 6)], 3, { mode }), {
      mode, maxItemsPerBox: 3, totalItems: 9, boxCount: 3,
      fullBoxes: 3, partialBoxes: 0, unusedItemSlots: "0",
    });
  }
});

test("empty and zero-only summaries have zero counts and string unused slots", () => {
  for (const mode of modes) {
    for (const items of [[], [row("A", 0), row("B", -0)]]) {
      assert.deepEqual(summarizePackaging(items, max, { mode }), {
        mode, maxItemsPerBox: max, totalItems: 0, boxCount: 0,
        fullBoxes: 0, partialBoxes: 0, unusedItemSlots: "0",
      });
    }
  }
});

test("summary stays exact when an unsafe intermediate product would corrupt a safe result", () => {
  const capacity = 4503599627370495;
  for (const mode of modes) {
    const summary = summarizePackaging([row("A", max)], capacity, { mode });
    assert.deepEqual(summary, {
      mode, maxItemsPerBox: capacity, totalItems: max, boxCount: 3,
      fullBoxes: 2, partialBoxes: 1, unusedItemSlots: "4503599627370494",
    });
    assert.notEqual(String(summary.boxCount * capacity - max), summary.unusedItemSlots);
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  }
});

test("single-SKU unused slots can exceed MAX_SAFE_INTEGER and remain exact", () => {
  const items = [row("A", 1), row("B", 2)];
  assert.deepEqual(summarizePackaging(items, max, { mode: "single-sku" }), {
    mode: "single-sku", maxItemsPerBox: max, totalItems: 3, boxCount: 2,
    fullBoxes: 0, partialBoxes: 2, unusedItemSlots: "18014398509481979",
  });
  assert.equal(summarizePackaging(items, max).unusedItemSlots, "9007199254740988");
});

test("summary handles MAX_SAFE_INTEGER boxes without per-box work or allocation", () => {
  // Run with a process deadline: a synchronous per-box loop cannot be timed out
  // by node:test alone. Instrument box allocation in the child as well.
  const script = [
    'const { summarizePackaging } = require("./packaging.js");',
    'const push = Array.prototype.push;',
    'Array.prototype.push = function (...values) {',
    '  if (values.some(value => value && Array.isArray(value.contents))) throw new Error("summary allocated a box");',
    '  return Reflect.apply(push, this, values);',
    '};',
    'const result = ["mixed", "single-sku"].map(mode => summarizePackaging([{sku:"A",quantity:Number.MAX_SAFE_INTEGER}],1,{mode}));',
    'process.stdout.write(JSON.stringify(result));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: __dirname, encoding: "utf8", timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summaries = JSON.parse(result.stdout);
  for (const [index, mode] of modes.entries()) {
    assert.deepEqual(summaries[index], {
      mode, maxItemsPerBox: 1, totalItems: max, boxCount: max,
      fullBoxes: max, partialBoxes: 0, unusedItemSlots: "0",
    });
    assert.throws(() => planPackaging([row("A", max)], 1, { mode }), /100000 boxes/);
  }
  assert.ok(result.stdout.length < 600);
});

test("summary handles many distinct SKUs beyond the detailed-plan box limit", () => {
  const items = Array.from({ length: MAX_BOXES + 1 }, (_, index) => row(String(index), 1));
  const summary = summarizePackaging(items, max, { mode: "single-sku" });
  assert.deepEqual(summary, {
    mode: "single-sku", maxItemsPerBox: max, totalItems: items.length,
    boxCount: items.length, fullBoxes: 0, partialBoxes: items.length,
    unusedItemSlots: (BigInt(items.length) * (BigInt(max) - 1n)).toString(),
  });
  assert.equal(Object.hasOwn(summary, "boxes"), false);
  assert.throws(() => planPackaging(items, max, { mode: "single-sku" }), /100000 boxes/);
});

test("summary and planner reject the same invalid inputs with the same errors", () => {
  const cases = [];
  for (const items of [undefined, null, {}, "A", 1]) cases.push([items, 3]);
  for (const item of [null, undefined, [], 1, "A", {}]) cases.push([[item], 3]);
  cases.push([new Array(1), 3]);
  for (const sku of [undefined, null, "", " \n\t", 1, {}]) cases.push([[row(sku, 1)], 3]);
  for (const quantity of [undefined, null, true, "1", -1, 0.5, NaN, Infinity, -Infinity, max + 1, 1n]) {
    cases.push([[row("A", quantity)], 3]);
  }
  for (const capacity of [undefined, null, false, "3", 0, -0, -1, 0.5, NaN, Infinity, -Infinity, max + 1, 1n]) {
    cases.push([[], capacity]);
  }
  for (const options of [null, [], false, 1, "mixed", () => {}]) cases.push([[], 3, options]);
  for (const mode of [null, false, 0, "", "single", "Mixed", "mixed ", [], {}, 1n, Symbol("mixed")]) {
    cases.push([[], 3, { mode }]);
  }
  for (const mode of modes) {
    for (const sku of ["A", "B"]) cases.push([[row("A", max), row(sku, 1)], max, { mode }]);
  }
  for (const args of cases) {
    let expected;
    try { planPackaging(...args); } catch (error) { expected = error; }
    assert.ok(expected, "invalid test case must fail in the planner");
    assert.throws(() => summarizePackaging(...args), { name: expected.name, message: expected.message });
  }
});

test("summary uses existing option defaults and never mutates or shares input", () => {
  const items = Object.freeze([Object.freeze(row("__proto__", 2)), Object.freeze(row("2", 1))]);
  const options = Object.freeze({ mode: "single-sku" });
  const first = summarizePackaging(items, 3, options);
  assert.deepEqual(first, summarizePackaging(items, 3, options));
  first.totalItems = 99;
  assert.equal(summarizePackaging(items, 3, options).totalItems, 3);
  for (const value of [undefined, {}, { mode: undefined }, { mode: "mixed" }]) {
    assert.deepEqual(summarizePackaging(items, 3, value), summarizePackaging(items, 3));
  }
  assert.deepEqual(summarizePackaging([{ sku: "A", quantity: 2, ignored: true }], 3),
    summarizePackaging([row("A", 2)], 3));
});

test("summary agrees with detailed plans across 660 generated mode/capacity cases", () => {
  for (let seed = 0; seed < 30; seed += 1) {
    const items = Array.from({ length: 10 }, (_, index) => row(["B", "A", "__proto__"][(seed + index) % 3], (seed * 7 + index * 3) % 9));
    for (let capacity = 1; capacity <= 11; capacity += 1) {
      for (const mode of modes) {
        const plan = planPackaging(items, capacity, { mode });
        const fullBoxes = plan.boxes.filter(box => box.totalItems === capacity).length;
        const unused = plan.boxes.reduce((sum, box) => sum + BigInt(capacity) - BigInt(box.totalItems), 0n);
        assert.deepEqual(summarizePackaging(items, capacity, { mode }), {
          mode, maxItemsPerBox: capacity, totalItems: plan.totalItems,
          boxCount: plan.boxes.length, fullBoxes,
          partialBoxes: plan.boxes.length - fullBoxes, unusedItemSlots: unused.toString(),
        });
      }
    }
  }
});
