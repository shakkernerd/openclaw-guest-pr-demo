"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { planPackaging, MAX_BOXES } = require("./packaging.js");

const box = (contents, totalItems) => ({ contents, totalItems });
const row = (sku, quantity) => ({ sku, quantity });

test("combines repeated SKUs in first-appearance order before packing", () => {
  assert.deepEqual(planPackaging([row("B", 2), row("A", 3), row("B", 4)], 4), {
    maxItemsPerBox: 4,
    totalItems: 9,
    boxes: [
      box([row("B", 4)], 4),
      box([row("B", 2), row("A", 2)], 4),
      box([row("A", 1)], 1),
    ],
  });
});

test("empty and all-zero orders have no boxes", () => {
  for (const items of [[], [row("A", 0)]]) {
    assert.deepEqual(planPackaging(items, 3), { maxItemsPerBox: 3, totalItems: 0, boxes: [] });
  }
});

test("zero rows preserve first appearance but never become box contents", () => {
  assert.deepEqual(planPackaging([row("B", 0), row("A", 1), row("B", 1), row("C", 0)], 3).boxes,
    [box([row("B", 1), row("A", 1)], 2)]);
});

test("exact capacity has no extra box; capacity one and partial boxes work", () => {
  assert.deepEqual(planPackaging([row("A", 2), row("B", 2)], 2).boxes,
    [box([row("A", 2)], 2), box([row("B", 2)], 2)]);
  assert.deepEqual(planPackaging([row("A", 2)], 1).boxes,
    [box([row("A", 1)], 1), box([row("A", 1)], 1)]);
  assert.deepEqual(planPackaging([row("A", 2), row("B", 1)], 10).boxes,
    [box([row("A", 2), row("B", 1)], 3)]);
});

test("SKU strings are exact, including object keys and numeric-looking names", () => {
  const items = [row("10", 1), row("2", 1), row("__proto__", 2), row("constructor", 1),
    row("a", 1), row("A", 1), row(" A ", 1), row("__proto__", 1)];
  assert.deepEqual(planPackaging(items, 10).boxes[0].contents,
    [row("10", 1), row("2", 1), row("__proto__", 3), row("constructor", 1), row("a", 1), row("A", 1), row(" A ", 1)]);
});

test("plans are deterministic, do not mutate input, and own their output rows", () => {
  const items = Object.freeze([Object.freeze(row("A", 3)), Object.freeze(row("B", 2))]);
  const first = planPackaging(items, 2);
  assert.deepEqual(first, planPackaging(items, 2));
  first.boxes[0].contents[0].quantity = 99;
  assert.equal(first.boxes[1].contents[0].quantity, 1);
  assert.equal(items[0].quantity, 3);
  assert.equal(planPackaging(items, 2).boxes[0].contents[0].quantity, 2);
});

test("rejects malformed item arrays, rows, and SKUs with useful locations", () => {
  for (const items of [undefined, null, {}, "A", 2]) {
    assert.throws(() => planPackaging(items, 2), /items must be an array/);
  }
  for (const item of [null, undefined, [], "A", 1]) {
    assert.throws(() => planPackaging([item], 2), /items\[0\].*object/);
  }
  assert.throws(() => planPackaging(new Array(1), 2), /items\[0\]/);
  for (const sku of [undefined, null, 42, "", " ", "\n\t"]) {
    assert.throws(() => planPackaging([row(sku, 1)], 2), /items\[0\]\.sku.*non-empty string/);
  }
});

test("quantities must be non-negative safe integer numbers, without coercion", () => {
  for (const quantity of [undefined, null, true, "2", -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n]) {
    assert.throws(() => planPackaging([row("A", quantity)], 2), /items\[0\]\.quantity.*non-negative safe integer/);
  }
});

test("capacity must be a positive safe integer even for empty orders", () => {
  for (const capacity of [undefined, null, false, "2", 0, -0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n]) {
    assert.throws(() => planPackaging([], capacity), /maxItemsPerBox.*positive safe integer/);
  }
});

test("safe integer boundary packs without expanding individual items", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(planPackaging([row("A", max - 1), row("B", 1)], max).boxes,
    [box([row("A", max - 1), row("B", 1)], max)]);
  assert.deepEqual(planPackaging([row("A", max)], max - 1).boxes,
    [box([row("A", max - 1)], max - 1), box([row("A", 1)], 1)]);
  assert.deepEqual(planPackaging([row("A", max - 1), row("A", 1)], max).boxes,
    [box([row("A", max)], max)]);
});

test("rejects aggregate overflow, including repeated SKUs", () => {
  for (const sku of ["A", "B"]) {
    assert.throws(() => planPackaging([row("A", Number.MAX_SAFE_INTEGER), row(sku, 1)], 2), /total.*safe integer/i);
  }
});

test("bounds output before allocating an impractical number of boxes", () => {
  assert.equal(MAX_BOXES, 100000);
  assert.equal(planPackaging([row("A", MAX_BOXES)], 1).boxes.length, MAX_BOXES);
  assert.throws(() => planPackaging([row("A", MAX_BOXES + 1)], 1), /100000 boxes/);
  assert.throws(() => planPackaging([row("A", Number.MAX_SAFE_INTEGER)], 1), /100000 boxes/);
});

test("small generated orders conserve counts, ordering, and box capacity", () => {
  for (let seed = 0; seed < 40; seed += 1) {
    const items = Array.from({ length: 12 }, (_, i) => row(["Z", "2", "A", "__proto__"][(seed + i) % 4], (seed * 7 + i * 3) % 6));
    const totals = new Map();
    for (const item of items) totals.set(item.sku, (totals.get(item.sku) || 0) + item.quantity);
    const expected = [...totals].flatMap(([sku, quantity]) => Array(quantity).fill(sku));
    for (let capacity = 1; capacity <= 9; capacity += 1) {
      const plan = planPackaging(items, capacity);
      assert.equal(plan.totalItems, expected.length);
      assert.equal(plan.boxes.length, Math.ceil(expected.length / capacity));
      const actual = [];
      for (const [i, packed] of plan.boxes.entries()) {
        assert.ok(packed.totalItems > 0 && packed.totalItems <= capacity);
        if (i < plan.boxes.length - 1) assert.equal(packed.totalItems, capacity);
        assert.equal(new Set(packed.contents.map(item => item.sku)).size, packed.contents.length);
        assert.equal(packed.totalItems, packed.contents.reduce((sum, item) => sum + item.quantity, 0));
        for (const item of packed.contents) {
          assert.ok(Number.isSafeInteger(item.quantity) && item.quantity > 0);
          actual.push(...Array(item.quantity).fill(item.sku));
        }
      }
      assert.deepEqual(actual, expected);
    }
  }
});
