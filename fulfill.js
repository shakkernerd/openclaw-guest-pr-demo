"use strict";

const { readFileSync } = require("node:fs");
const { validateBatch } = require("./packing.js");
const { parcelLabel } = require("./parcel-label.js");

const usage = "Usage: node fulfill.js <shipments.json> [--json]\n       node fulfill.js - [--json]\nValidate packing for a JSON array of shipments. No files are changed.\nUse - to read standard input until EOF; --json emits one JSON result instead of text.\nOptions may appear before or after the filename. Use -- before a dash-prefixed filename.\nExit codes: 0 = ready, 1 = validation errors, 2 = usage/file/JSON error.";
const countLabel = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const itemLabel = (count) => count === null ? "unknown" : parcelLabel(count);
const errorLine = ({ code, path, message }) => `  - [${code}] ${path}: ${message}`;

// JSON.parse rounds numbers before validation. Compare the original decimal token
// to its positive safe-integer value without expanding untrusted exponents.
function isExactIntegerToken(source, value) {
  const [mantissa, exponent = "0"] = source.toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const coefficient = (whole + fraction).replace(/^0+/, "");
  const significant = coefficient.replace(/0+$/, "");
  const zeros = Number(exponent) - fraction.length + coefficient.length - significant.length;
  const expected = String(value);
  return zeros >= 0 && significant.length + zeros === expected.length &&
    significant + "0".repeat(zeros) === expected;
}

function parseBatchJson(content) {
  return JSON.parse(content, (key, value, context) => {
    if (key === "quantity" && Number.isSafeInteger(value) && value > 0 &&
        !isExactIntegerToken(context.source, value)) {
      // Let the existing validator report INVALID_QUANTITY at the correct path.
      return NaN;
    }
    return value;
  });
}

function formatSummary(batch) {
  const lines = ["Shipment fulfillment summary"];
  for (const [index, shipment] of batch.shipments.entries()) {
    const id = shipment.shipmentId === null ? `(entry ${index + 1})` : JSON.stringify(shipment.shipmentId);
    const parcels = shipment.parcelCount === null ? "unknown parcels" : countLabel(shipment.parcelCount, "parcel");
    lines.push(`${shipment.valid ? "READY" : "BLOCKED"} ${id}: ${itemLabel(shipment.packedQuantity)} packed / ${itemLabel(shipment.expectedQuantity)} ordered; ${parcels}`);
    for (const error of shipment.errors) lines.push(errorLine(error));
  }
  if (batch.shipments.length === 0) {
    for (const error of batch.errors) lines.push(errorLine(error));
  }
  const ready = batch.shipments.filter(({ valid }) => valid).length;
  const total = batch.shipments.length;
  lines.push(`Summary: ${ready} ready, ${total - ready} blocked, ${countLabel(total, "shipment")}.`);
  return lines.join("\n");
}

function parseArgs(args) {
  const options = { json: false, help: false, file: undefined };
  let flags = true;
  for (const arg of args) {
    if (flags && arg === "--") {
      flags = false;
    } else if (flags && arg === "--json") {
      if (options.json) return null;
      options.json = true;
    } else if (flags && ["--help", "-h"].includes(arg)) {
      options.help = true;
    } else if (flags && arg.startsWith("-") && arg !== "-") {
      return null;
    } else {
      if (options.file !== undefined) return null;
      options.file = arg;
    }
  }
  return options;
}

function jsonReport(batch) {
  const total = batch.shipments.length;
  const ready = batch.shipments.filter(({ valid }) => valid).length;
  return {
    valid: batch.valid, total, ready, blocked: total - ready,
    shipments: batch.shipments, errors: batch.errors,
  };
}

function main(args) {
  const options = parseArgs(args);
  if (!options || (!options.help && options.file === undefined)) {
    console.error(usage);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const file = options.file;
  const source = file === "-" ? "standard input" : JSON.stringify(file);
  let content;
  try {
    content = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (error) {
    console.error(`Cannot read ${source} (${error.code || "I/O error"}). Check the input source and read permissions.`);
    return 2;
  }
  let shipments;
  try {
    shipments = parseBatchJson(content);
  } catch (error) {
    console.error(`Cannot parse JSON in ${source}: ${JSON.stringify(error.message)}. Fix the JSON syntax and rerun.`);
    return 2;
  }
  const batch = validateBatch(shipments);
  console.log(options.json ? JSON.stringify(jsonReport(batch), null, 2) : formatSummary(batch));
  return batch.valid ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { formatSummary, parseBatchJson };
