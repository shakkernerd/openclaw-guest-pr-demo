"use strict";

const { readFileSync } = require("node:fs");
const { parcelLabel } = require("./parcel-label.js");

function singleLineText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(label + " must be a nonempty string.");
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new Error(label + " must be a single line without control characters.");
  }
  return value.trim();
}

function textField(order, field, position) {
  return singleLineText(
    Object.hasOwn(order, field) ? order[field] : undefined,
    "Order " + position + ": " + field,
  );
}

/** Validate the entire batch before selecting orders; never mutate the input. */
function createDispatchReport(orders, selectedIds) {
  if (!Array.isArray(orders)) {
    throw new Error("Orders must be a JSON array.");
  }

  const seenIds = new Set();
  const validated = [];
  for (const [index, order] of orders.entries()) {
    const position = index + 1;
    if (order === null || typeof order !== "object" || Array.isArray(order)) {
      throw new Error("Order " + position + ": must be an object.");
    }

    const id = textField(order, "id", position);
    const recipient = textField(order, "recipient", position);
    if (!Object.hasOwn(order, "itemCount") ||
        !Number.isSafeInteger(order.itemCount) || order.itemCount < 0) {
      throw new Error("Order " + position + ": itemCount must be a nonnegative safe integer.");
    }
    if (seenIds.has(id)) {
      throw new Error("Order " + position + ": duplicate id " + JSON.stringify(id) + ".");
    }
    seenIds.add(id);
    validated.push({ id, recipient, itemCount: order.itemCount });
  }

  let selected;
  if (selectedIds !== undefined) {
    if (!Array.isArray(selectedIds)) {
      throw new Error("Selected IDs must be an array of strings.");
    }
    selected = new Set();
    for (const [index, id] of selectedIds.entries()) {
      selected.add(singleLineText(id, "Selected ID " + (index + 1)));
    }
    const unknown = [...selected].filter((id) => !seenIds.has(id));
    if (unknown.length) {
      throw new Error("Unknown order IDs: " + unknown.map((id) => JSON.stringify(id)).join(", ") + ".");
    }
  }

  const reported = validated.filter((order) => selected === undefined || selected.has(order.id));
  // Convert each safe count before summing: a Number accumulator can lose items.
  const totalItems = reported.reduce((total, order) => total + BigInt(order.itemCount), 0n);
  const lines = reported.map((order, index) =>
    (index + 1) + ". " + order.id + " | " + order.recipient + " | " + parcelLabel(order.itemCount),
  );
  return [
    "Dispatch report",
    "Orders: " + reported.length,
    "Total items: " + totalItems,
    "",
    ...(lines.length ? lines : ["No orders to dispatch."]),
  ].join("\n");
}

function main(args) {
  const usage = "Usage: node dispatch-report.js <orders.json> [--id <ID>]...";
  if (!args.length || args[0].startsWith("--")) {
    throw new Error(usage);
  }

  const filename = args[0];
  const selectedIds = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--id") {
      const id = args[index + 1];
      if (id === undefined || id.startsWith("--")) {
        throw new Error("--id requires an order ID. " + usage);
      }
      selectedIds.push(id);
      index += 1;
    } else if (argument.startsWith("--id=")) {
      selectedIds.push(argument.slice(5));
    } else {
      throw new Error("Unexpected argument " + JSON.stringify(argument) + ". " + usage);
    }
  }

  let source;
  try {
    source = readFileSync(filename, "utf8");
  } catch (error) {
    throw new Error("Cannot read orders file " + JSON.stringify(filename) + ": " + error.message);
  }

  let orders;
  try {
    orders = JSON.parse(source);
  } catch (error) {
    throw new Error("Invalid JSON in " + JSON.stringify(filename) + ": " + error.message);
  }
  console.log(createDispatchReport(orders, selectedIds.length ? selectedIds : undefined));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("Error: " + error.message);
    process.exitCode = 1;
  }
}

module.exports = { createDispatchReport };
