"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parcelLabels } = require("./d1-20261028-g3-parcel-batch.js");

test("parcelLabels formats an ordinary batch in order without mutating it", () => {
  const counts = [3, 0, 1, 2, 1];
  const original = counts.slice();
  const labels = parcelLabels(counts);

  assert.deepEqual(labels, ["3 items", "0 items", "1 item", "2 items", "1 item"]);
  assert.notStrictEqual(labels, counts);
  assert.deepEqual(counts, original);
});

test("parcelLabels returns a new empty array for empty input", () => {
  const counts = [];
  const labels = parcelLabels(counts);

  assert.deepEqual(labels, []);
  assert.notStrictEqual(labels, counts);
  assert.deepEqual(counts, []);
});

test("parcelLabels accepts frozen arrays", () => {
  const counts = Object.freeze([0, 1, 3]);

  assert.deepEqual(parcelLabels(counts), ["0 items", "1 item", "3 items"]);
  assert.deepEqual(counts, [0, 1, 3]);
  assert.deepEqual(parcelLabels(Object.freeze([])), []);
});

test("parcelLabels accepts the maximum safe integer count", () => {
  assert.deepEqual(parcelLabels([Number.MAX_SAFE_INTEGER]), ["9007199254740991 items"]);
});

test("parcelLabels accepts negative zero as zero without changing the input", () => {
  const counts = [-0];

  assert.deepEqual(parcelLabels(counts), ["0 items"]);
  assert.ok(Object.is(counts[0], -0));
});

test("parcelLabels rejects non-array inputs with TypeError", () => {
  const invalidInputs = [
    undefined, null, 1, "1", {}, { 0: 1, length: 1 },
    new Set([1]), new Uint8Array([1]),
  ];

  for (const counts of invalidInputs) {
    assert.throws(() => parcelLabels(counts), TypeError);
  }
});

test("parcelLabels rejects non-number elements with TypeError", () => {
  const invalidCounts = [
    undefined, null, true, false, "1", " 1 ", "",
    1n, Symbol("1"), new Number(1), [1], {}, () => 1,
  ];

  for (const count of invalidCounts) {
    assert.throws(() => parcelLabels([count]), TypeError);
  }
});

test("parcelLabels rejects fractional and non-finite numbers with TypeError", () => {
  for (const count of [0.5, 1.5, -0.5, Number.MIN_VALUE, NaN, Infinity, -Infinity]) {
    assert.throws(() => parcelLabels([count]), TypeError);
  }
});

test("parcelLabels rejects negative and unsafe integers with RangeError", () => {
  for (const count of [-1, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1, Number.MAX_VALUE]) {
    assert.throws(() => parcelLabels([count]), RangeError);
  }
});

test("parcelLabels rejects mixed invalid batches at every position without mutation", () => {
  const invalidCases = [
    ["1", TypeError], [1.5, TypeError], [NaN, TypeError], [Infinity, TypeError],
    [-1, RangeError], [Number.MAX_SAFE_INTEGER + 1, RangeError],
  ];

  for (const [count, ErrorType] of invalidCases) {
    for (let index = 0; index < 3; index += 1) {
      const counts = [0, 1, 3];
      counts[index] = count;
      const original = counts.slice();

      assert.throws(() => parcelLabels(counts), ErrorType);
      assert.deepEqual(counts, original);
    }
  }
});

test("parcelLabels rejects number-like objects without invoking coercion hooks", () => {
  let coercions = 0;
  const failCoercion = () => {
    coercions += 1;
    throw new Error("coercion hooks must not run");
  };
  const numberLikeValues = [
    { [Symbol.toPrimitive]: failCoercion },
    { valueOf: failCoercion },
    { toString: failCoercion },
    Object.assign(new Number(1), {
      [Symbol.toPrimitive]: failCoercion,
      valueOf: failCoercion,
      toString: failCoercion,
    }),
  ];

  for (const count of numberLikeValues) {
    assert.throws(() => parcelLabels([0, count, 2]), TypeError);
  }
  assert.equal(coercions, 0);
});

test("parcelLabels rejects sparse arrays rather than skipping missing counts", () => {
  assert.throws(() => parcelLabels(new Array(1)), TypeError);
  assert.throws(() => parcelLabels([0, , 2]), TypeError);
});
