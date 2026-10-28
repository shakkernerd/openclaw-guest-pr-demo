"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest, parseManifest } = require("./parcel-manifest.js");

function parcel(overrides = {}) {
  return {
    id: "P-1",
    recipient: "Alex Example",
    street: "10 Example Street",
    postcode: "SW1A 1AA",
    destination: "GB",
    service: "standard",
    itemCount: 1,
    ...overrides,
  };
}

const EMPTY_SUMMARY = { byDestination: [], byService: [], byDestinationAndService: [] };

const EXPECTED_SUMMARY = {
  byDestination: [{ destination: "GB", parcels: 2 }, { destination: "US", parcels: 1 }],
  byService: [{ service: "express", parcels: 1 }, { service: "standard", parcels: 2 }],
  byDestinationAndService: [
    { destination: "GB", service: "express", parcels: 1 },
    { destination: "GB", service: "standard", parcels: 1 },
    { destination: "US", service: "standard", parcels: 1 },
  ],
};

test("valid parcels are normalized, counted, and sorted without mutating input", () => {
  const manifest = [
    parcel({ id: "US-1", destination: " us ", service: " Standard " }),
    parcel({ id: "GB-1", service: "express" }),
    parcel({ id: "GB-2", destination: "gb", itemCount: 12, note: "ignored" }),
  ];
  const original = structuredClone(manifest);
  manifest.forEach(Object.freeze);
  Object.freeze(manifest);
  const report = validateManifest(manifest);
  assert.deepEqual(report, {
    valid: true, totalRows: 3, validRows: 3, invalidRows: 0, errors: [],
    summary: EXPECTED_SUMMARY,
  });
  assert.deepEqual(manifest, original);
  assert.deepEqual(validateManifest([...manifest].reverse()), report);
});

test("mixed rows collect all errors with original one-based row numbers", () => {
  const report = validateManifest([
    parcel(),
    parcel({ id: "bad", recipient: " ", postcode: 123, destination: "United States", itemCount: 0 }),
    null,
    parcel({ id: "P-4", destination: "US", service: "express" }),
    {},
  ]);
  assert.equal(report.valid, false);
  assert.equal(report.totalRows, 5);
  assert.equal(report.validRows, 2);
  assert.equal(report.invalidRows, 3);
  assert.deepEqual(report.errors.map(({ row, field }) => [row, field]), [
    [2, "recipient"], [2, "postcode"], [2, "destination"], [2, "itemCount"],
    [3, "$"],
    [5, "id"], [5, "recipient"], [5, "street"], [5, "postcode"],
    [5, "destination"], [5, "service"], [5, "itemCount"],
  ]);
  assert.ok(report.errors.every(({ message }) => message.length > 10));
  assert.deepEqual(report.summary, {
    byDestination: [{ destination: "GB", parcels: 1 }, { destination: "US", parcels: 1 }],
    byService: [{ service: "express", parcels: 1 }, { service: "standard", parcels: 1 }],
    byDestinationAndService: [
      { destination: "GB", service: "standard", parcels: 1 },
      { destination: "US", service: "express", parcels: 1 },
    ],
  });
});

test("non-object rows are rejected without stopping later validation", () => {
  const report = validateManifest([null, [], "text", 3, true, parcel()]);
  assert.deepEqual(report.errors.map(({ row, field }) => [row, field]),
    [[1, "$"], [2, "$"], [3, "$"], [4, "$"], [5, "$"]]);
  assert.equal(report.validRows, 1);
  assert.equal(report.invalidRows, 5);
});

test("every required text field rejects missing, blank, and non-string values", () => {
  for (const field of ["id", "recipient", "street", "postcode", "destination", "service"]) {
    for (const value of [undefined, null, "", " \n\t ", 123, false, [], {}]) {
      const report = validateManifest([parcel({ [field]: value })]);
      assert.equal(report.valid, false, field + " should reject " + JSON.stringify(value));
      assert.deepEqual(report.errors.map((error) => error.field), [field]);
      assert.deepEqual(report.summary, EMPTY_SUMMARY);
    }
  }
});

test("item counts must be positive safe integers without coercion", () => {
  for (const itemCount of [undefined, null, 0, -1, 1.5, "2", true, NaN, Infinity, 9007199254740992]) {
    const report = validateManifest([parcel({ itemCount })]);
    assert.equal(report.valid, false);
    assert.deepEqual(report.errors.map((error) => error.field), ["itemCount"]);
  }
  for (const itemCount of [1, 3, Number.MAX_SAFE_INTEGER]) {
    assert.equal(validateManifest([parcel({ itemCount })]).valid, true);
  }
});

test("destination codes require exactly two ASCII letters", () => {
  for (const destination of ["G", "GBR", "G1", "G B", "éé"]) {
    const report = validateManifest([parcel({ destination })]);
    assert.equal(report.valid, false);
    assert.equal(report.errors[0].field, "destination");
  }
  assert.equal(validateManifest([parcel({ destination: " zz " })]).valid, true);
});

test("all duplicate IDs are excluded even when one duplicate has other errors", () => {
  const manifest = [
    parcel({ id: " same " }),
    parcel({ id: "same", recipient: "" }),
    parcel({ id: "SAME", service: "express" }),
  ];
  const report = validateManifest(manifest);
  assert.equal(report.validRows, 1);
  assert.equal(report.invalidRows, 2);
  assert.deepEqual(report.errors.filter(({ field }) => field === "id").map(({ row }) => row), [1, 2]);
  assert.match(report.errors[0].message, /rows 1, 2/);
  assert.deepEqual(report.summary.byService, [{ service: "express", parcels: 1 }]);
  assert.deepEqual(validateManifest([...manifest].reverse()).summary, report.summary);
});

test("special object keys remain ordinary IDs and service names", () => {
  const report = validateManifest([
    parcel({ id: "__proto__", service: "__proto__" }),
    parcel({ id: "constructor", service: "constructor" }),
  ]);
  assert.equal(report.valid, true);
  assert.deepEqual(report.summary.byService, [
    { service: "__proto__", parcels: 1 }, { service: "constructor", parcels: 1 },
  ]);
});

test("an empty array is a valid empty manifest", () => {
  assert.deepEqual(parseManifest("[]"), {
    valid: true, totalRows: 0, validRows: 0, invalidRows: 0, errors: [], summary: EMPTY_SUMMARY,
  });
});

test("malformed JSON returns a document diagnostic rather than throwing", () => {
  for (const source of ["", " ", "[", '[{"id":"P-1",}]', "[] trailing", "[NaN]"]) {
    const report = parseManifest(source);
    assert.equal(report.valid, false);
    assert.equal(report.totalRows, 0);
    assert.deepEqual(report.summary, EMPTY_SUMMARY);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].row, null);
    assert.equal(report.errors[0].field, "$");
    assert.match(report.errors[0].message, /^Invalid JSON:/);
  }
});

test("non-array JSON roots produce a document error, not row errors", () => {
  for (const source of ["null", "{}", '{"parcels":[]}', "12", "true", '"text"']) {
    const report = parseManifest(source);
    assert.equal(report.valid, false);
    assert.equal(report.validRows, 0);
    assert.equal(report.invalidRows, 0);
    assert.deepEqual(report.summary, EMPTY_SUMMARY);
    assert.deepEqual(report.errors, [{
      row: null, field: "$", message: "Expected a JSON array of parcel objects.",
    }]);
  }
});


test("repeated destination/service pairs count parcels rather than items", () => {
  const report = validateManifest([
    parcel({ id: "one", itemCount: 100 }),
    parcel({ id: "two", itemCount: 20 }),
    parcel({ id: "three", itemCount: 1 }),
  ]);
  assert.equal(report.validRows, 3);
  assert.deepEqual(report.summary, {
    byDestination: [{ destination: "GB", parcels: 3 }],
    byService: [{ service: "standard", parcels: 3 }],
    byDestinationAndService: [{ destination: "GB", service: "standard", parcels: 3 }],
  });
});


test("large duplicate-ID groups retain every row diagnostic without quadratic messages", () => {
  const count = 1000;
  const report = validateManifest(Array.from({ length: count }, () => parcel({ id: "duplicate" })));
  assert.equal(report.valid, false);
  assert.equal(report.totalRows, count);
  assert.equal(report.validRows, 0);
  assert.equal(report.invalidRows, count);
  assert.deepEqual(report.errors.map(({ row }) => row), Array.from({ length: count }, (_, index) => index + 1));
  assert.ok(report.errors.every(({ field, message }) => field === "id" && message.length < 200));
  assert.match(report.errors[0].message, /rows 1, 2, 3/);
  assert.match(report.errors[0].message, /1000 rows total/);
  assert.deepEqual(report.summary, EMPTY_SUMMARY);
});

test("malformed JSON diagnostics do not contain raw terminal-control characters", () => {
  for (const source of ["\u001b[2J", "\u009b31m", "bad\r\nforged row"]) {
    const report = parseManifest(source);
    assert.equal(report.valid, false);
    assert.equal(report.errors[0].row, null);
    assert.match(report.errors[0].message, /^Invalid JSON:/);
    assert.doesNotMatch(report.errors[0].message, /[\u0000-\u001f\u007f-\u009f]/);
  }
});
