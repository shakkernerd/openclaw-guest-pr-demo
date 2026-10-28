"use strict";

const { readFileSync } = require("node:fs");
const { validateBatch } = require("./packing.js");
const { parcelLabel } = require("./parcel-label.js");

const usage = "Usage: node fulfill.js <shipments.json>\nValidate packing for a JSON array of shipments. No files are changed.\nExit codes: 0 = ready, 1 = validation errors, 2 = usage/file/JSON error.";
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

function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(usage);
    return 0;
  }
  if (args.length !== 1) {
    console.error(usage);
    return 2;
  }
  const file = args[0];
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`Cannot read ${JSON.stringify(file)} (${error.code || "I/O error"}). Check the path and read permissions.`);
    return 2;
  }
  let shipments;
  try {
    shipments = parseBatchJson(content);
  } catch (error) {
    console.error(`Cannot parse JSON in ${JSON.stringify(file)}: ${JSON.stringify(error.message)}. Fix the JSON syntax and rerun.`);
    return 2;
  }
  const batch = validateBatch(shipments);
  console.log(formatSummary(batch));
  return batch.valid ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { formatSummary, parseBatchJson };
