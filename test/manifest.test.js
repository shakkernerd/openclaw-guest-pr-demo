"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createManifest, formatReport, parcelLabel, ManifestError } = require("..");

function fixture() {
  return {
    catalogue: { items: [
      { sku: "SOCK", name: "Thermal socks", location: "B2" },
      { sku: "KIT", name: "Hygiene kit" },
      { sku: "UNUSED", name: "Spare mug" },
    ] },
    orders: { orders: [
      {
        id: "DON-2", recipient: "Example Pantry",
        address: { lines: ["10 Example Road", "Sampleford"], postcode: "ZZ1 1ZZ", country: "UK" },
        items: [{ sku: "SOCK", quantity: 2 }, { sku: "KIT", quantity: 1 }, { sku: "SOCK", quantity: 3 }],
      },
      {
        id: "DON-1", recipient: "Example Shelter",
        address: { lines: ["2 Example Lane"], postcode: "ZZ1 2ZZ", country: "UK" },
        items: [{ sku: "KIT", quantity: 1 }],
      },
    ] },
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("manifest v1 has an explicit stable shape, consolidated picks and complete labels", () => {
  const { catalogue, orders } = fixture();
  const result = createManifest(catalogue, orders);
  assert.deepEqual(result, {
    schemaVersion: 1,
    totals: { orders: 2, cartons: 2, distinctSkus: 2, units: 7 },
    pickList: [
      { sku: "KIT", name: "Hygiene kit", location: null, quantity: 2 },
      { sku: "SOCK", name: "Thermal socks", location: "B2", quantity: 5 },
    ],
    orders: [
      {
        id: "DON-2", recipient: "Example Pantry",
        address: { lines: ["10 Example Road", "Sampleford"], postcode: "ZZ1 1ZZ", country: "UK" },
        items: [{ sku: "KIT", name: "Hygiene kit", quantity: 1 }, { sku: "SOCK", name: "Thermal socks", quantity: 5 }],
        totalUnits: 6,
        carton: { number: 1, total: 1, label: [
          "DONATION DISPATCH", "Order: DON-2", "Carton: 1 of 1", "To: Example Pantry",
          "10 Example Road", "Sampleford", "ZZ1 1ZZ", "UK", "Contents:",
          "  1 x KIT — Hygiene kit", "  5 x SOCK — Thermal socks", "Total: 6 items",
        ].join("\n") },
      },
      {
        id: "DON-1", recipient: "Example Shelter",
        address: { lines: ["2 Example Lane"], postcode: "ZZ1 2ZZ", country: "UK" },
        items: [{ sku: "KIT", name: "Hygiene kit", quantity: 1 }],
        totalUnits: 1,
        carton: { number: 1, total: 1, label: [
          "DONATION DISPATCH", "Order: DON-1", "Carton: 1 of 1", "To: Example Shelter",
          "2 Example Lane", "ZZ1 2ZZ", "UK", "Contents:", "  1 x KIT — Hygiene kit", "Total: 1 item",
        ].join("\n") },
      },
    ],
  });
});

test("report is readable and includes precisely the generated carton labels", () => {
  const { catalogue, orders } = fixture();
  const result = createManifest(catalogue, orders);
  const report = formatReport(result);
  assert.ok(report.startsWith("DONATION STOCKROOM — DISPATCH MANIFEST\n"));
  assert.ok(report.includes("Orders: 2 | Cartons: 2 | SKUs: 2 | Total: 7 items"));
  assert.ok(report.includes("2 x KIT — Hygiene kit | Location: not recorded"));
  assert.ok(report.includes("5 x SOCK — Thermal socks | Location: B2"));
  for (const order of result.orders) assert.ok(report.includes(order.carton.label));
  assert.ok(report.endsWith("\n"));
});

test("manifest does not mutate inputs or keep mutable input references", () => {
  const { catalogue, orders } = freeze(fixture());
  const before = JSON.stringify({ catalogue, orders });
  const result = createManifest(catalogue, orders);
  result.orders[0].address.lines.push("changed output");
  result.orders[0].items[0].quantity = 99;
  assert.equal(JSON.stringify({ catalogue, orders }), before);
});

test("SKU sorting and consolidation do not depend on catalogue or line order", () => {
  const { catalogue, orders } = fixture();
  const before = JSON.stringify(createManifest(catalogue, orders));
  catalogue.items.reverse();
  orders.orders.forEach((order) => order.items.reverse());
  assert.equal(JSON.stringify(createManifest(catalogue, orders)), before);
});

test("empty order batch is a valid no-op", () => {
  const result = createManifest(fixture().catalogue, { orders: [] });
  assert.deepEqual(result, {
    schemaVersion: 1,
    totals: { orders: 0, cartons: 0, distinctSkus: 0, units: 0 },
    pickList: [], orders: [],
  });
  assert.match(formatReport(result), /No orders to dispatch\./);
  assert.doesNotMatch(formatReport(result), /CARTON LABELS/);
});

test("positive safe whole-number quantities are enforced without coercion", async (t) => {
  for (const quantity of [0, -1, 1.5, "2", "", true, null, undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(quantity), () => {
      const { catalogue, orders } = fixture();
      orders.orders[0].items[0].quantity = quantity;
      assert.throws(() => createManifest(catalogue, orders), (error) => {
        assert.ok(error instanceof ManifestError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.equal(error.exitCode, 3);
        assert.match(error.message, /orders\.orders\[0\]\.items\[0\]\.quantity: must be a positive/);
        return true;
      });
    });
  }
});

test("safe integer boundary succeeds; per-order and batch overflow fail", () => {
  const { catalogue, orders } = fixture();
  orders.orders = [orders.orders[0]];
  orders.orders[0].items = [{ sku: "KIT", quantity: Number.MAX_SAFE_INTEGER }];
  assert.equal(createManifest(catalogue, orders).totals.units, Number.MAX_SAFE_INTEGER);
  orders.orders[0].items.push({ sku: "KIT", quantity: 1 });
  assert.throws(() => createManifest(catalogue, orders), /combined quantity exceeds/);
  orders.orders[0].items.pop();
  orders.orders.push(fixture().orders.orders[1]);
  assert.throws(() => createManifest(catalogue, orders), /manifest total: combined quantity exceeds/);
});

test("malformed shapes, duplicate identifiers and unknown SKUs fail with paths", async (t) => {
  const cases = [
    ["null catalogue", (f) => { f.catalogue = null; }, /catalogue: must be an object/],
    ["array catalogue", (f) => { f.catalogue = []; }, /catalogue: must be an object/],
    ["empty catalogue", (f) => { f.catalogue.items = []; }, /catalogue.items: must be a non-empty array/],
    ["missing catalogue items", (f) => { delete f.catalogue.items; }, /catalogue.items/],
    ["null product", (f) => { f.catalogue.items[0] = null; }, /catalogue.items\[0\]/],
    ["blank name", (f) => { f.catalogue.items[0].name = " "; }, /\.name: must be a non-empty string/],
    ["invalid location", (f) => { f.catalogue.items[0].location = 5; }, /\.location/],
    ["duplicate SKU", (f) => { f.catalogue.items.push(f.catalogue.items[0]); }, /duplicate SKU/],
    ["null orders", (f) => { f.orders = null; }, /orders: must be an object/],
    ["missing orders", (f) => { f.orders = {}; }, /orders.orders/],
    ["orders not array", (f) => { f.orders.orders = {}; }, /orders.orders/],
    ["null order", (f) => { f.orders.orders[0] = null; }, /orders.orders\[0\]: must be an object/],
    ["duplicate ID", (f) => { f.orders.orders[1].id = f.orders.orders[0].id; }, /duplicate order ID/],
    ["blank ID", (f) => { f.orders.orders[0].id = ""; }, /\.id/],
    ["blank recipient", (f) => { f.orders.orders[0].recipient = ""; }, /\.recipient/],
    ["whitespace", (f) => { f.orders.orders[0].id = " DON-1"; }, /leading or trailing whitespace/],
    ["missing address", (f) => { delete f.orders.orders[0].address; }, /\.address/],
    ["empty address lines", (f) => { f.orders.orders[0].address.lines = []; }, /\.address.lines/],
    ["blank address line", (f) => { f.orders.orders[0].address.lines[0] = ""; }, /\.lines\[0\]/],
    ["missing postcode", (f) => { delete f.orders.orders[0].address.postcode; }, /\.postcode/],
    ["missing country", (f) => { delete f.orders.orders[0].address.country; }, /\.country/],
    ["empty items", (f) => { f.orders.orders[0].items = []; }, /\.items: must be a non-empty array/],
    ["null line", (f) => { f.orders.orders[0].items[0] = null; }, /\.items\[0\]: must be an object/],
    ["unknown SKU", (f) => { f.orders.orders[0].items[0].sku = "NOT-IN-CATALOGUE"; }, /unknown SKU "NOT-IN-CATALOGUE"/],
    ["case-sensitive SKU", (f) => { f.orders.orders[0].items[0].sku = "sock"; }, /unknown SKU/],
    ["blank SKU", (f) => { f.orders.orders[0].items[0].sku = ""; }, /\.sku: must be a non-empty string/],
  ];
  for (const [name, mutate, message] of cases) {
    await t.test(name, () => {
      const f = fixture();
      mutate(f);
      assert.throws(() => createManifest(f.catalogue, f.orders), message);
    });
  }
});

test("label text rejects control characters and Unicode line separators", () => {
  for (const control of ["\n", "\r", "\t", "\u0000", "\u001b", "\u007f", "\u0085", "\u2028", "\u2029"]) {
    const { catalogue, orders } = fixture();
    orders.orders[0].recipient = "Before" + control + "After";
    assert.throws(() => createManifest(catalogue, orders), /single line without control characters/);
  }
});

test("unpaired Unicode surrogates fail validation while valid pairs are preserved", () => {
  for (const value of ["DON-\ud800", "DON-\ud801", "DON-\udc00", "A\ud800B"]) {
    const { catalogue, orders } = fixture();
    orders.orders[0].id = value;
    assert.throws(() => createManifest(catalogue, orders), /\.id: must contain valid Unicode/);
    orders.orders[0].id = "DON-2";
    catalogue.items[0].sku = value;
    assert.throws(() => createManifest(catalogue, orders), /\.sku: must contain valid Unicode/);
  }
  const { catalogue, orders } = fixture();
  orders.orders[0].recipient = "Example Pantry \ud83e\udde3";
  const result = createManifest(catalogue, orders);
  assert.equal(result.orders[0].recipient, orders.orders[0].recipient);
  assert.ok(result.orders[0].carton.label.includes(orders.orders[0].recipient));
});

test("prototype-like SKUs are safe Map keys; normal Unicode is preserved", () => {
  const { orders } = fixture();
  const catalogue = { items: [
    { sku: "__proto__", name: "Couverture été" },
    { sku: "constructor", name: "Chaussettes" },
  ] };
  orders.orders = [orders.orders[0]];
  orders.orders[0].items = [{ sku: "constructor", quantity: 2 }, { sku: "__proto__", quantity: 1 }];
  const result = createManifest(catalogue, orders);
  assert.deepEqual(result.pickList.map((item) => item.sku), ["__proto__", "constructor"]);
  assert.ok(result.orders[0].carton.label.includes("Couverture été"));
});

test("public parcelLabel is the exact existing export, including legacy permissive behavior", () => {
  assert.equal(parcelLabel, require("../parcel-label.js").parcelLabel);
  for (const [input, expected] of [[0, "0 items"], [1, "1 item"], [3, "3 items"], ["1", "1 items"], [-1, "-1 items"], [1.5, "1.5 items"]]) {
    assert.equal(parcelLabel(input), expected);
  }
});
