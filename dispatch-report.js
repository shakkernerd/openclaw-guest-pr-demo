"use strict";

const { readFileSync } = require("node:fs");
const { parcelLabel } = require("./parcel-label.js");

function textField(order, field, position) {
  const value = order[field];
  if (!Object.hasOwn(order, field) || typeof value !== "string" || !value.trim()) {
    throw new Error(`Order ${position}: ${field} must be a nonempty string.`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new Error(`Order ${position}: ${field} must be a single line without control characters.`);
  }
  return value.trim();
}

/** Validate a batch before returning its report; never mutate the input. */
function createDispatchReport(orders) {
  if (!Array.isArray(orders)) {
    throw new Error("Orders must be a JSON array.");
  }

  const seenIds = new Set();
  const lines = [];
  for (const [index, order] of orders.entries()) {
    const position = index + 1;
    if (order === null || typeof order !== "object" || Array.isArray(order)) {
      throw new Error(`Order ${position}: must be an object.`);
    }

    const id = textField(order, "id", position);
    const recipient = textField(order, "recipient", position);
    if (!Object.hasOwn(order, "itemCount") ||
        !Number.isSafeInteger(order.itemCount) || order.itemCount < 0) {
      throw new Error(`Order ${position}: itemCount must be a nonnegative safe integer.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Order ${position}: duplicate id ${JSON.stringify(id)}.`);
    }
    seenIds.add(id);
    lines.push(`${position}. ${id} | ${recipient} | ${parcelLabel(order.itemCount)}`);
  }

  return [
    "Dispatch report",
    `Orders: ${orders.length}`,
    "",
    ...(lines.length ? lines : ["No orders to dispatch."]),
  ].join("\n");
}

function main(args) {
  if (args.length !== 1) {
    throw new Error("Usage: node dispatch-report.js <orders.json>");
  }

  const filename = args[0];
  let source;
  try {
    source = readFileSync(filename, "utf8");
  } catch (error) {
    throw new Error(`Cannot read orders file ${JSON.stringify(filename)}: ${error.message}`);
  }

  let orders;
  try {
    orders = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${JSON.stringify(filename)}: ${error.message}`);
  }
  console.log(createDispatchReport(orders));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createDispatchReport };
