#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { planPackaging, summarizePackaging } = require("./packaging.js");
const { parcelLabel } = require("./parcel-label.js");

const USAGE = [
  "Usage: node packaging-cli.js [--summary] [--json] [--mode mixed|single-sku] [FILE|-]",
  "       node packaging-cli.js --help",
  "",
  "Read an order JSON object with items and maxItemsPerBox.",
  "Omit FILE or use - to read standard input. Text output is the default.",
  "--json       Write the plan or summary as JSON instead of text.",
  "--summary    Write a compact utilization summary, without individual boxes.",
  "--mode MODE  mixed (default) or single-sku (one SKU per box).",
  "--help, -h   Show this help (use alone).",
  "--           End options, allowing filenames that begin with a dash.",
  "",
  "Exit codes: 0 success/help, 1 input/planning/output error, 2 argument error.",
].join("\n") + "\n";

function parseArguments(args) {
  let file;
  let json = false;
  let summary = false;
  let mode;
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (options && (arg === "--help" || arg === "-h")) {
      if (args.length !== 1) throw new Error("help option must be used alone");
      return { help: true };
    }
    if (options && arg === "--") {
      options = false;
    } else if (options && arg === "--json") {
      if (json) throw new Error("repeated option --json");
      json = true;
    } else if (options && arg === "--summary") {
      if (summary) throw new Error("repeated option --summary");
      summary = true;
    } else if (options && arg === "--mode") {
      if (mode !== undefined) throw new Error("repeated option --mode");
      const value = args[index + 1];
      if (value !== "mixed" && value !== "single-sku") {
        throw new Error("--mode requires mixed or single-sku");
      }
      mode = value;
      index += 1;
    } else if (options && arg.startsWith("-") && arg !== "-") {
      throw new Error("unknown option " + JSON.stringify(arg));
    } else {
      if (file !== undefined) throw new Error("expected at most one FILE argument");
      file = arg;
    }
  }
  return { file, json, summary, mode: mode === undefined ? "mixed" : mode, help: false };
}

// Called only with a numeric token from already syntax-validated JSON.
function isIntegerToken(token) {
  const [coefficient, exponent = "0"] = token.toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = (whole + fraction).replace("-", "");
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") end -= 1;
  if (end === 0) return true; // Zero is integral at any exponent.
  const trailingZeros = digits.length - end;
  // The threshold is bounded by token length. Huge exponents may become +/-Infinity
  // here without affecting this comparison; never allocate a power of ten.
  return Number(exponent) >= fraction.length - trailingZeros;
}

function parseOrderJson(source) {
  // Validate syntax FIRST so the token pass cannot repair malformed JSON.
  // No reviver: native parsing handles deeply nested ignored data without a
  // recursive JavaScript walk or a dependency on reviver context.source.
  const parsed = JSON.parse(source);
  const guarded = source.replace(/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token[0] === '"' || !Number.isSafeInteger(Number(token)) || isIntegerToken(token)) return token;
    // Internal invalid-count sentinel: reuse the planner's existing validation
    // only if this value is used. Extra/overwritten fields remain ignored.
    return "null";
  });
  // Native parsing preserves escaped keys and last-property-wins semantics.
  return guarded === source ? parsed : JSON.parse(guarded);
}

function readOrder(file) {
  const stdin = file === undefined || file === "-";
  let source;
  try {
    source = readFileSync(stdin ? 0 : file, "utf8");
  } catch (error) {
    throw new Error("cannot read input (" + error.code + ")");
  }
  let order;
  try {
    order = parseOrderJson(source);
  } catch {
    throw new Error("input must contain one valid JSON order");
  }
  if (order === null || typeof order !== "object" || Array.isArray(order)) {
    throw new TypeError("order must be an object with items and maxItemsPerBox");
  }
  return order;
}

function textReport(plan) {
  const count = plan.boxes.length;
  const lines = ["Packing plan: " + parcelLabel(plan.totalItems) + " in " + count +
    (count === 1 ? " box" : " boxes") + " (capacity: " + parcelLabel(plan.maxItemsPerBox) + " per box)"];
  if (plan.mode === "single-sku") lines.push("Mode: single-sku (one SKU per box)");
  if (count === 0) lines.push("No boxes needed.");
  for (const [index, box] of plan.boxes.entries()) {
    lines.push("Box " + (index + 1) + ": " + parcelLabel(box.totalItems));
    for (const item of box.contents) {
      // JSON quoting handles C0 controls; also escape DEL, C1 and line separators.
      const quotedSku = JSON.stringify(item.sku).replace(/[\u007f-\u009f\u2028\u2029]/g,
        character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
      lines.push("  " + quotedSku + ": " + item.quantity);
    }
  }
  return lines.join("\n") + "\n";
}

function summaryReport(summary) {
  return "Mode: " + summary.mode + " | Capacity: " + summary.maxItemsPerBox + "\n" +
    parcelLabel(summary.totalItems) + " | " + summary.boxCount +
    (summary.boxCount === 1 ? " box: " : " boxes: ") + summary.fullBoxes + " full, " +
    summary.partialBoxes + " partial | " + summary.unusedItemSlots +
    (summary.unusedItemSlots === "1" ? " unused item slot\n" : " unused item slots\n");
}

function main() {
  // Do not force process.exit(): piped output must finish flushing first.
  process.stdout.on("error", error => {
    process.stderr.write("packaging: cannot write output (" + error.code + ")\n");
    process.exitCode = 1;
  });
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write("packaging: " + error.message + "\n" + USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    const order = readOrder(options.file);
    const operation = options.summary ? summarizePackaging : planPackaging;
    const result = operation(order.items, order.maxItemsPerBox, { mode: options.mode });
    const report = options.summary ? summaryReport : textReport;
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + "\n" : report(result));
  } catch (error) {
    // The CLI owns source context; parsing and planning keep their existing diagnostics.
    const source = options.file === undefined || options.file === "-" ? "standard input" : JSON.stringify(options.file);
    process.stderr.write("packaging: " + source + ": " + error.message + "\n");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
