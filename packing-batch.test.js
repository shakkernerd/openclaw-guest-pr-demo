"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { preparePackingBatch } = require("./packing-batch.js");
const { parcelLabel } = require("./parcel-label.js");

test("labels an ordered batch without changing or retaining input records", () => {
  const records = Object.freeze([
    Object.freeze({ id: "third", count: 3 }),
    Object.freeze({ id: "zero", count: 0 }),
    Object.freeze({ id: "first", count: 1 }),
  ]);
  const result = preparePackingBatch(records);
  assert.deepEqual(result, {
    parcels: [
      { id: "third", count: 3, label: "3 items" },
      { id: "zero", count: 0, label: "0 items" },
      { id: "first", count: 1, label: "1 item" },
    ],
    parcelCount: 3,
    totalItemCount: 4,
  });
  result.parcels[0].count = 9;
  assert.equal(records[0].count, 3);
  assert.equal(preparePackingBatch(records).parcels[0].count, 3);
});

test("an empty batch has an explicit zero result", () => {
  assert.deepEqual(preparePackingBatch([]), {
    parcels: [], parcelCount: 0, totalItemCount: 0,
  });
});

test("identifier equality is exact, with no trimming, case folding or Unicode normalization", () => {
  const ids = ["Box", "box", " box ", "box\t", "é", "e\u0301", "__proto__"];
  const result = preparePackingBatch(ids.map((id) => ({ id, count: 0 })));
  assert.deepEqual(result.parcels.map((parcel) => parcel.id), ids);
  assert.equal(result.parcelCount, ids.length);
  assert.equal(result.totalItemCount, 0);
});

test("rejects exact duplicate identifiers, including ones with whitespace", () => {
  for (const id of ["box", " box ", "__proto__"]) {
    assert.throws(() => preparePackingBatch([
      { id, count: 1 }, { id: "other", count: 0 }, { id, count: 2 },
    ]), /parcels\[2\]\.id duplicates an earlier identifier/);
  }
});

test("requires an array of records with exactly their own id and count fields", () => {
  for (const batch of [null, undefined, {}, "[]", 1, true]) {
    assert.throws(() => preparePackingBatch(batch), /batch must be a JSON array/);
  }
  const invalidRecords = [
    null, undefined, [], "box", 1, true, {},
    { id: "box" }, { count: 1 }, { id: "box", count: 1, note: "extra" },
    Object.assign(Object.create({ id: "inherited" }), { count: 1 }),
  ];
  for (const record of invalidRecords) {
    assert.throws(() => preparePackingBatch([record]), /parcels\[0\] must be an object with exactly id and count/);
  }
  assert.throws(() => preparePackingBatch(new Array(1)), /parcels\[0\]/);
});

test("requires string identifiers with at least one non-whitespace character", () => {
  for (const id of ["", " ", "\t\r\n", "\u00a0", null, undefined, 0, false, {}, []]) {
    assert.throws(() => preparePackingBatch([{ id, count: 1 }]), /parcels\[0\]\.id must be a nonempty, non-whitespace string/);
  }
});

test("rejects unsafe, fractional, negative and coerced counts", () => {
  for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "1", null, undefined, true, {}, []]) {
    assert.throws(() => preparePackingBatch([{ id: "box", count }]), /parcels\[0\]\.count must be a nonnegative safe integer/);
  }
});

test("uses the existing formatter unchanged at valid count boundaries", () => {
  for (const count of [0, -0, 1, 3, Number.MAX_SAFE_INTEGER]) {
    const result = preparePackingBatch([{ id: "box", count }]);
    assert.equal(result.parcels[0].count, count);
    assert.equal(result.parcels[0].label, parcelLabel(count));
    assert.equal(result.totalItemCount, count === 0 ? 0 : count);
  }
  // Batch validation must not narrow the standalone helper's existing behavior.
  assert.equal(parcelLabel("1"), "1 items");
  assert.equal(parcelLabel(-1), "-1 items");
  assert.equal(parcelLabel(0.5), "0.5 items");
});

test("allows an exact safe total and rejects overflow before addition", () => {
  const records = [
    { id: "large", count: Number.MAX_SAFE_INTEGER - 1 },
    { id: "last", count: 1 },
    { id: "zero", count: 0 },
  ];
  assert.equal(preparePackingBatch(records).totalItemCount, Number.MAX_SAFE_INTEGER);
  assert.throws(() => preparePackingBatch([...records, { id: "overflow", count: 1 }]), /parcels\[3\]\.count would make totalItemCount exceed Number.MAX_SAFE_INTEGER/);
  assert.throws(() => preparePackingBatch([
    { id: "a", count: Number.MAX_SAFE_INTEGER },
    { id: "b", count: Number.MAX_SAFE_INTEGER },
  ]), RangeError);
});

test("a late validation failure leaves inputs untouched and no state leaks to the next call", () => {
  const records = [{ id: "a", count: 1 }, { id: "b", count: -1 }];
  const original = structuredClone(records);
  assert.throws(() => preparePackingBatch(records), /parcels\[1\]\.count/);
  assert.deepEqual(records, original);
  assert.deepEqual(preparePackingBatch([records[0]]), {
    parcels: [{ id: "a", count: 1, label: "1 item" }],
    parcelCount: 1,
    totalItemCount: 1,
  });
});
