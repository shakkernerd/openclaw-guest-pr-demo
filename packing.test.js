"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateShipment, validateBatch } = require("./packing.js");

function shipment(id = "SHIP-1001", parcelId = "BOX-1001") {
  return {
    id,
    order: [{ sku: "MUG-BLUE", quantity: 2 }, { sku: "TEA-100G", quantity: 1 }],
    parcels: [{ id: parcelId, items: [{ sku: "MUG-BLUE", quantity: 2 }, { sku: "TEA-100G", quantity: 1 }] }],
  };
}

test("accepts complete packing split across parcels and repeated SKU lines without mutation", () => {
  const input = shipment();
  input.order = [{ sku: "MUG-BLUE", quantity: 1 }, { sku: "MUG-BLUE", quantity: 1 }];
  input.parcels = [
    { id: "BOX-A", items: [{ sku: "MUG-BLUE", quantity: 1 }] },
    { id: "BOX-B", items: [{ sku: "MUG-BLUE", quantity: 1 }] },
  ];
  const before = structuredClone(input);
  assert.deepEqual(validateShipment(input), {
    shipmentId: "SHIP-1001", valid: true, expectedQuantity: 2, packedQuantity: 2, parcelCount: 2, errors: [],
  });
  assert.deepEqual(input, before);
});

test("reports missing, excess, and unordered SKUs even when total counts match", () => {
  const input = shipment();
  input.parcels[0].items = [{ sku: "TEA-100G", quantity: 2 }, { sku: "SPOON", quantity: 1 }];
  const result = validateShipment(input);
  assert.equal(result.valid, false);
  assert.equal(result.expectedQuantity, result.packedQuantity);
  assert.deepEqual(result.errors.map(({ code }) => code), ["MISSING_QUANTITY", "EXCESS_QUANTITY", "EXCESS_QUANTITY"]);
  assert.match(result.errors[0].message, /MUG-BLUE.*pack 2 more.*ordered 2, packed 0/);
  assert.match(result.errors[1].message, /TEA-100G.*remove 1.*ordered 1, packed 2/);
  assert.match(result.errors[2].message, /SPOON.*remove 1.*ordered 0, packed 1/);
});

test("empty parcels list reports every unpacked SKU", () => {
  const input = shipment();
  input.parcels = [];
  const result = validateShipment(input);
  assert.equal(result.packedQuantity, 0);
  assert.equal(result.errors.filter(({ code }) => code === "MISSING_QUANTITY").length, 2);
});

test("duplicate parcel assignment blocks a shipment even if quantities match", () => {
  const input = shipment();
  input.parcels = [
    { id: "BOX-A", items: [{ sku: "MUG-BLUE", quantity: 2 }] },
    { id: "BOX-A", items: [{ sku: "TEA-100G", quantity: 1 }] },
  ];
  const result = validateShipment(input);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "DUPLICATE_PARCEL");
  assert.match(result.errors[0].message, /BOX-A.*parcels\[0\].*parcels\[1\].*unique/i);
});

test("batch blocks every shipment sharing a parcel, including earlier assignments", () => {
  const input = [shipment("S-1", "SHARED"), shipment("S-2", "SHARED"), shipment("S-3", "SHARED"), shipment("S-4", "OWN")];
  const before = structuredClone(input);
  const result = validateBatch(input);
  assert.equal(result.valid, false);
  assert.deepEqual(result.shipments.map(({ valid }) => valid), [false, false, false, true]);
  for (const entry of result.shipments.slice(0, 3)) {
    assert.equal(entry.errors[0].code, "DUPLICATE_PARCEL");
    assert.match(entry.errors[0].message, /shipments\[0\].*shipments\[1\].*shipments\[2\]/);
  }
  assert.equal(result.errors.length, 3);
  assert.deepEqual(input, before);
});

test("batch rejects duplicate shipment IDs without blocking independent shipments", () => {
  const result = validateBatch([shipment("SAME", "P-1"), shipment("SAME", "P-2"), shipment("OTHER", "P-3")]);
  assert.deepEqual(result.shipments.map(({ valid }) => valid), [false, false, true]);
  assert.ok(result.errors.every(({ code }) => code === "DUPLICATE_SHIPMENT"));
});

test("malformed shipment shapes return actionable errors instead of throwing", () => {
  const inputs = [null, [], "shipment", {}, { id: " ", order: [], parcels: {} },
    { id: "S-1", order: [null], parcels: [null, { id: "", items: {} }] }];
  for (const input of inputs) {
    const result = validateShipment(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.every((error) => error.code && error.path && error.message));
  }
});

test("rejects invalid quantities and SKUs on either side without coercion or misleading shortages", () => {
  for (const side of ["order", "packed"]) {
    for (const quantity of [0, -1, 1.5, "2", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const input = shipment();
      const lines = side === "order" ? input.order : input.parcels[0].items;
      lines[0].quantity = quantity;
      const result = validateShipment(input);
      assert.equal(result.valid, false);
      assert.deepEqual(result.errors.map(({ code }) => code), ["INVALID_QUANTITY"]);
      assert.match(result.errors[0].message, /positive safe integer/);
      assert.equal(side === "order" ? result.expectedQuantity : result.packedQuantity, null);
    }
    for (const sku of ["", "  ", 123, null]) {
      const input = shipment();
      (side === "order" ? input.order : input.parcels[0].items)[0].sku = sku;
      assert.equal(validateShipment(input).errors[0].code, "INVALID_SKU");
    }
  }
});

test("rejects unsafe aggregate quantities, even when individual lines are safe", () => {
  for (const side of ["order", "packed"]) {
    const input = shipment();
    const lines = [{ sku: "A", quantity: Number.MAX_SAFE_INTEGER }, { sku: "B", quantity: 1 }];
    if (side === "order") input.order = lines;
    else input.parcels[0].items = lines;
    const result = validateShipment(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(({ code }) => code === "QUANTITY_OVERFLOW"));
    assert.equal(side === "order" ? result.expectedQuantity : result.packedQuantity, null);
  }
});

test("SKU identifiers are case-sensitive and safe as map keys", () => {
  const input = shipment();
  input.order = [{ sku: "__proto__", quantity: 1 }, { sku: "constructor", quantity: 1 }];
  input.parcels[0].items = structuredClone(input.order);
  assert.equal(validateShipment(input).valid, true);
  input.parcels[0].items[0].sku = "__PROTO__";
  assert.deepEqual(validateShipment(input).errors.map(({ code }) => code), ["MISSING_QUANTITY", "EXCESS_QUANTITY"]);
});

test("validates batch root and preserves valid neighbors of malformed shipments", () => {
  for (const input of [null, {}, { shipments: [] }, "not a batch"]) {
    const result = validateBatch(input);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, "INVALID_BATCH");
  }
  assert.deepEqual(validateBatch([]), { valid: true, shipments: [], errors: [] });
  const result = validateBatch([null, shipment()]);
  assert.deepEqual(result.shipments.map(({ valid }) => valid), [false, true]);
  assert.equal(result.errors[0].path, "shipments[0]");
});

test("empty orders and empty parcel contents are invalid, not ready", () => {
  const input = shipment();
  input.order = [];
  input.parcels[0].items = [];
  const result = validateShipment(input);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(({ code }) => code), ["INVALID_ITEMS", "INVALID_ITEMS"]);
  assert.equal(result.expectedQuantity, null);
  assert.equal(result.packedQuantity, null);
});

test("missing identifiers block dispatch even with otherwise correct packing", () => {
  const input = shipment();
  delete input.id;
  delete input.parcels[0].id;
  const result = validateShipment(input);
  assert.equal(result.valid, false);
  assert.equal(result.shipmentId, null);
  assert.deepEqual(result.errors.map(({ code }) => code), ["INVALID_SHIPMENT_ID", "INVALID_PARCEL_ID"]);
  assert.equal(result.expectedQuantity, 3);
  assert.equal(result.packedQuantity, 3);
});

test("quantity overflow is caught across parcels and repeated SKU lines", () => {
  const input = shipment();
  input.order = [{ sku: "A", quantity: Number.MAX_SAFE_INTEGER }];
  input.parcels = [
    { id: "P-1", items: [{ sku: "A", quantity: Number.MAX_SAFE_INTEGER }] },
    { id: "P-2", items: [{ sku: "A", quantity: 1 }] },
  ];
  const result = validateShipment(input);
  assert.equal(result.packedQuantity, null);
  assert.deepEqual(result.errors.map(({ code }) => code), ["QUANTITY_OVERFLOW"]);
});
