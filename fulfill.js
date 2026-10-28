"use strict";

const { readFileSync } = require("node:fs");
const { validateBatch } = require("./packing.js");
const { parcelLabel } = require("./parcel-label.js");
const { formatHtmlReport } = require("./packing-report.js");

const usage = "Usage: node fulfill.js <shipments.json> [--json | --html]\n       node fulfill.js - [--json | --html]\nValidate packing for a JSON array of shipments. No files are changed.\nUse - to read standard input until EOF; --json emits JSON; --html emits a self-contained HTML report.\nOptions may appear before or after the filename. Use -- before a dash-prefixed filename.\nExit codes: 0 = ready, 1 = validation errors, 2 = usage/read/JSON/write error.";
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

// Scan already syntax-validated JSON. Character loops avoid recursive regex
// backtracking on long escaped strings; strings are copied without inspecting digits.
function markRoundedNumbers(content) {
  const parts = [];
  let copied = 0;
  let index = 0;
  const isDigit = character => character >= "0" && character <= "9";
  while (index < content.length) {
    const character = content[index];
    if (character === '"') {
      index += 1;
      while (index < content.length) {
        const next = content[index++];
        if (next === "\\") index += 1; // Skip the escaped character, including a quote.
        else if (next === '"') break;
      }
    } else if (character === "-" || isDigit(character)) {
      const start = index++;
      while (index < content.length && (isDigit(content[index]) || ".eE+-".includes(content[index]))) index += 1;
      const token = content.slice(start, index);
      const value = Number(token);
      if (Number.isSafeInteger(value) && value > 0 && !isExactIntegerToken(token, value)) {
        parts.push(content.slice(copied, start), JSON.stringify(token));
        copied = index;
      }
    } else {
      index += 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(content.slice(copied));
  return parts.join("");
}

function parseBatchJson(content) {
  // Coerce once, as JSON.parse does, then validate syntax before scanning tokens.
  content = `${content}`;
  const parsed = JSON.parse(content);
  const guarded = markRoundedNumbers(content);
  if (guarded === null) return parsed;

  // A second native parse marks suspect numbers as strings only in a parallel
  // tree. Native parsing preserves escaped keys and last-property-wins behavior.
  // Iterate rather than using a recursive reviver, including in ignored metadata.
  const pending = [[parsed, JSON.parse(guarded)]];
  while (pending.length) {
    const [value, marked] = pending.pop();
    if (value === null || typeof value !== "object") continue;
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (key === "quantity" && typeof child === "number" && typeof marked[key] === "string") {
        // Preserve the API sentinel and existing INVALID_QUANTITY diagnostics.
        value[key] = NaN;
      } else if (child !== null && typeof child === "object") {
        pending.push([child, marked[key]]);
      }
    }
  }
  return parsed;
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
  const options = { format: "text", help: false, file: undefined };
  let flags = true;
  for (const arg of args) {
    if (flags && arg === "--") {
      flags = false;
    } else if (flags && ["--json", "--html"].includes(arg)) {
      if (options.format !== "text") return null;
      options.format = arg.slice(2);
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
    process.stdout.write(usage + "\n");
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
  const output = options.format === "json" ? JSON.stringify(jsonReport(batch), null, 2) :
    options.format === "html" ? formatHtmlReport(batch) : formatSummary(batch);
  process.stdout.write(output + "\n");
  return batch.valid ? 0 : 1;
}

if (require.main === module) {
  // console.log ignores stream errors by default. Observe real write failures,
  // and let Node drain successful writes rather than forcing process.exit().
  let outputFailed = false;
  process.stdout.on("error", error => {
    outputFailed = true;
    process.exitCode = 2;
    console.error(`Cannot write to standard output (${error.code || "I/O error"}). Check the output destination and rerun.`);
  });
  const status = main(process.argv.slice(2));
  process.exitCode = outputFailed ? 2 : status;
}

module.exports = { formatSummary, parseBatchJson };
