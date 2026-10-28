"use strict";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isIdentifier = (value) => typeof value === "string" && value.trim().length > 0;

function addError(result, code, path, message) {
  result.errors.push({ code, path, message });
  result.valid = false;
}

function quantities() {
  return { valid: true, total: 0, bySku: new Map() };
}

// Invalid lines make totals unknown; never compare partial data with an order.
function readItems(items, path, counts, result) {
  if (!Array.isArray(items) || items.length === 0) {
    addError(result, "INVALID_ITEMS", path, "Provide a non-empty array of { sku, quantity } items.");
    counts.valid = false;
    return;
  }
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isObject(item)) {
      addError(result, "INVALID_ITEM", itemPath, "Provide an item object with sku and quantity.");
      counts.valid = false;
      continue;
    }
    const skuValid = isIdentifier(item.sku);
    const quantityValid = Number.isSafeInteger(item.quantity) && item.quantity > 0;
    if (!skuValid) {
      addError(result, "INVALID_SKU", `${itemPath}.sku`, "Provide a non-blank SKU string.");
    }
    if (!quantityValid) {
      addError(result, "INVALID_QUANTITY", `${itemPath}.quantity`, "Set quantity to a positive safe integer (1 to 9007199254740991).");
    }
    if (!skuValid || !quantityValid) {
      counts.valid = false;
      continue;
    }
    const total = counts.total + item.quantity;
    if (!Number.isSafeInteger(total)) {
      addError(result, "QUANTITY_OVERFLOW", `${itemPath}.quantity`, "Combined quantity exceeds the safe integer limit; split this shipment into smaller orders.");
      counts.valid = false;
      continue;
    }
    counts.total = total;
    counts.bySku.set(item.sku, (counts.bySku.get(item.sku) || 0) + item.quantity);
  }
}

function rememberAssignment(assignments, id, result, path) {
  if (!isIdentifier(id)) return;
  if (!assignments.has(id)) assignments.set(id, []);
  assignments.get(id).push({ result, path });
}

// Check after collecting the whole batch so the first assignment is blocked too.
function rejectDuplicates(assignments, code, kind) {
  for (const [id, locations] of assignments) {
    if (locations.length < 2) continue;
    const paths = locations.map(({ path }) => path).join(", ");
    const message = `${kind} ID ${JSON.stringify(id)} is assigned at ${paths}; use a unique ${kind.toLowerCase()} ID for each assignment or remove the duplicate.`;
    const affected = new Set();
    for (const { result, path } of locations) {
      if (affected.has(result)) continue;
      addError(result, code, path, message);
      affected.add(result);
    }
  }
}

function inspectShipment(shipment, path, parcelAssignments) {
  const result = {
    shipmentId: null, valid: true, expectedQuantity: null,
    packedQuantity: null, parcelCount: null, errors: [],
  };
  if (!isObject(shipment)) {
    addError(result, "INVALID_SHIPMENT", path, "Provide a shipment object with id, order, and parcels.");
    return result;
  }
  if (isIdentifier(shipment.id)) result.shipmentId = shipment.id;
  else addError(result, "INVALID_SHIPMENT_ID", `${path}.id`, "Provide a non-blank shipment ID string.");

  const ordered = quantities();
  const packed = quantities();
  readItems(shipment.order, `${path}.order`, ordered, result);
  if (!Array.isArray(shipment.parcels)) {
    addError(result, "INVALID_PARCELS", `${path}.parcels`, "Provide a parcels array; use [] if nothing has been packed.");
    packed.valid = false;
  } else {
    result.parcelCount = shipment.parcels.length;
    for (const [index, parcel] of shipment.parcels.entries()) {
      const parcelPath = `${path}.parcels[${index}]`;
      if (!isObject(parcel)) {
        addError(result, "INVALID_PARCEL", parcelPath, "Provide a parcel object with id and items.");
        packed.valid = false;
        continue;
      }
      if (!isIdentifier(parcel.id)) {
        addError(result, "INVALID_PARCEL_ID", `${parcelPath}.id`, "Provide a non-blank parcel ID string.");
      }
      rememberAssignment(parcelAssignments, parcel.id, result, `${parcelPath}.id`);
      readItems(parcel.items, `${parcelPath}.items`, packed, result);
    }
  }
  result.expectedQuantity = ordered.valid ? ordered.total : null;
  result.packedQuantity = packed.valid ? packed.total : null;
  if (ordered.valid && packed.valid) {
    const skus = new Set([...ordered.bySku.keys(), ...packed.bySku.keys()]);
    for (const sku of skus) {
      const expected = ordered.bySku.get(sku) || 0;
      const actual = packed.bySku.get(sku) || 0;
      if (expected === actual) continue;
      const missing = expected > actual;
      const action = missing ? `pack ${expected - actual} more` : `remove ${actual - expected}`;
      addError(result, missing ? "MISSING_QUANTITY" : "EXCESS_QUANTITY", `${path}.parcels`,
        `SKU ${JSON.stringify(sku)}: ${action} (ordered ${expected}, packed ${actual}).`);
    }
  }
  return result;
}

/** Validate one shipment without mutating it. Use validateBatch for cross-shipment IDs. */
function validateShipment(shipment) {
  const assignments = new Map();
  const result = inspectShipment(shipment, "shipment", assignments);
  rejectDuplicates(assignments, "DUPLICATE_PARCEL", "Parcel");
  return result;
}

/** Validate a JSON array of shipments, including globally unique shipment/parcel IDs. */
function validateBatch(shipments) {
  if (!Array.isArray(shipments)) {
    return { valid: false, shipments: [], errors: [{
      code: "INVALID_BATCH", path: "shipments", message: "Provide a JSON array of shipment objects.",
    }] };
  }
  const parcelAssignments = new Map();
  const shipmentAssignments = new Map();
  const results = Array.from(shipments, (shipment, index) => {
    const path = `shipments[${index}]`;
    const result = inspectShipment(shipment, path, parcelAssignments);
    rememberAssignment(shipmentAssignments, result.shipmentId, result, `${path}.id`);
    return result;
  });
  rejectDuplicates(parcelAssignments, "DUPLICATE_PARCEL", "Parcel");
  rejectDuplicates(shipmentAssignments, "DUPLICATE_SHIPMENT", "Shipment");
  const errors = results.flatMap(({ errors }) => errors);
  return { valid: errors.length === 0, shipments: results, errors };
}

module.exports = { validateShipment, validateBatch };
