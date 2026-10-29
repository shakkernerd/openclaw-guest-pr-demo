"use strict";

const { ManifestError } = require("./errors.js");

function invalid(path, message) {
  throw new ManifestError("INVALID_INPUT", `${path}: ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object.");
  }
}

function array(value, path, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid(path, `must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
}

function text(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(path, "must be a non-empty string.");
  }
  if (!value.isWellFormed()) {
    invalid(path, "must contain valid Unicode without unpaired surrogates.");
  }
  if (value !== value.trim()) {
    invalid(path, "must not have leading or trailing whitespace.");
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    invalid(path, "must be a single line without control characters.");
  }
  return value;
}

function validateCatalogue(catalogue) {
  object(catalogue, "catalogue");
  array(catalogue.items, "catalogue.items");
  const bySku = new Map();
  for (const [index, item] of catalogue.items.entries()) {
    const path = `catalogue.items[${index}]`;
    object(item, path);
    const sku = text(item.sku, `${path}.sku`);
    if (bySku.has(sku)) invalid(`${path}.sku`, `duplicate SKU ${JSON.stringify(sku)}.`);
    bySku.set(sku, {
      sku,
      name: text(item.name, `${path}.name`),
      location: item.location === undefined ? null : text(item.location, `${path}.location`),
    });
  }
  return bySku;
}

function validateOrders(document, catalogue) {
  object(document, "orders");
  array(document.orders, "orders.orders", true);
  const ids = new Set();
  const orders = [];
  for (const [index, order] of document.orders.entries()) {
    const path = `orders.orders[${index}]`;
    object(order, path);
    const id = text(order.id, `${path}.id`);
    if (ids.has(id)) invalid(`${path}.id`, `duplicate order ID ${JSON.stringify(id)}.`);
    ids.add(id);
    const recipient = text(order.recipient, `${path}.recipient`);
    object(order.address, `${path}.address`);
    array(order.address.lines, `${path}.address.lines`);
    const lines = [];
    for (const [lineIndex, line] of order.address.lines.entries()) {
      lines.push(text(line, `${path}.address.lines[${lineIndex}]`));
    }
    const address = {
      lines,
      postcode: text(order.address.postcode, `${path}.address.postcode`),
      country: text(order.address.country, `${path}.address.country`),
    };
    array(order.items, `${path}.items`);
    const items = [];
    for (const [itemIndex, item] of order.items.entries()) {
      const itemPath = `${path}.items[${itemIndex}]`;
      object(item, itemPath);
      const sku = text(item.sku, `${itemPath}.sku`);
      if (!catalogue.has(sku)) invalid(`${itemPath}.sku`, `unknown SKU ${JSON.stringify(sku)}.`);
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        invalid(`${itemPath}.quantity`, "must be a positive safe whole number (1 to 9007199254740991), not a string.");
      }
      items.push({ sku, quantity: item.quantity });
    }
    orders.push({ id, recipient, address, items });
  }
  return orders;
}

function addQuantities(left, right, path) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) invalid(path, "combined quantity exceeds the safe whole-number limit (9007199254740991).");
  return sum;
}

module.exports = { validateCatalogue, validateOrders, addQuantities };
