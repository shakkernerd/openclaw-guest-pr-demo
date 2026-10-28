#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { parseOrder } = require("./order-json.js");
const { planPackaging, summarizePackaging } = require("./packaging.js");
const { parcelLabel } = require("./parcel-label.js");

const USAGE = [
  "Usage: node packaging-cli.js [--summary] [--json] [--mode mixed|single-sku] [FILE|-]",
  "       node packaging-cli.js --csv [--mode mixed|single-sku] [FILE|-]",
  "       node packaging-cli.js --check [--mode mixed|single-sku] [FILE|-]",
  "       node packaging-cli.js --compare [--json] [FILE|-]",
  "       node packaging-cli.js --help",
  "",
  "Read an order JSON object with items and maxItemsPerBox.",
  "Omit FILE or use - to read standard input. Text output is the default.",
  "--json       Write the plan, summary, or comparison as JSON instead of text.",
  "--csv        Write the detailed plan as CSV; cannot combine with --json, --summary, --compare, or --check.",
  "--compare    Compare both policy summaries; cannot combine with --mode or --summary.",
  "             Also cannot combine with --csv or --check.",
  "--summary    Write a compact utilization summary, without individual boxes.",
  "--check      Validate only; silent success, no detailed plan or report.",
  "             Accepts orders beyond the detailed-plan box limit.",
  "             Cannot be combined with --csv, --json, --summary, or --compare.",
  "--mode MODE  mixed (default) or single-sku (one SKU per box).",
  "--help, -h   Show this help (use alone).",
  "--           End options, allowing filenames that begin with a dash.",
  "",
  "Exit codes: 0 success/help, 1 input/planning/output error, 2 argument error.",
].join("\n") + "\n";

function parseArguments(args) {
  let file;
  let json = false;
  let csv = false;
  let summary = false;
  let check = false;
  let compare = false;
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
    } else if (options && arg === "--csv") {
      if (csv) throw new Error("repeated option --csv");
      csv = true;
    } else if (options && arg === "--compare") {
      if (compare) throw new Error("repeated option --compare");
      compare = true;
    } else if (options && arg === "--summary") {
      if (summary) throw new Error("repeated option --summary");
      summary = true;
    } else if (options && arg === "--check") {
      if (check) throw new Error("repeated option --check");
      check = true;
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
  // Check explicit selections before defaulting mode or reading any input.
  if (check && (csv || json || summary || compare)) {
    throw new Error("--check cannot be combined with --csv, --json, --summary, or --compare");
  }
  if (csv && (json || summary || compare)) {
    throw new Error("--csv cannot be combined with --json, --summary, or --compare");
  }
  if (compare && (summary || mode !== undefined)) {
    throw new Error("--compare cannot be combined with --mode or --summary");
  }
  return { file, json, csv, summary, check, compare, mode: mode === undefined ? "mixed" : mode, help: false };
}

function readOrder(file) {
  const stdin = file === undefined || file === "-";
  let source;
  try {
    source = readFileSync(stdin ? 0 : file, "utf8");
  } catch (error) {
    throw new Error("cannot read input (" + error.code + ")");
  }
  return parseOrder(source);
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

// Called after normal order validation, only for CSV. UTF-8 cannot preserve lone
// surrogates; check original rows once (including zero quantities), before output.
function validateCsvSkus(items) {
  for (const [index, item] of items.entries()) {
    if (!item.sku.isWellFormed()) {
      throw new TypeError("items[" + index + "].sku contains an unpaired UTF-16 surrogate; CSV requires well-formed Unicode");
    }
  }
}

function csvField(value) {
  const field = String(value);
  return /[",\r\n]/.test(field) ? '"' + field.replace(/"/g, '""') + '"' : field;
}

function csvReport(plan) {
  const rows = ["box,sku,quantity"];
  for (const [index, box] of plan.boxes.entries()) {
    for (const item of box.contents) {
      rows.push([index + 1, item.sku, item.quantity].map(csvField).join(","));
    }
  }
  // Build the entire report before writing, just like existing text/JSON output.
  return rows.join("\r\n") + "\r\n";
}

function comparisonReport(comparison) {
  const rows = [
    ["Policy", "Capacity", "Items", "Boxes", "Full", "Partial", "Unused item slots"],
    ...Object.values(comparison).map(summary => [
      summary.mode, summary.maxItemsPerBox, summary.totalItems, summary.boxCount,
      summary.fullBoxes, summary.partialBoxes, summary.unusedItemSlots,
    ].map(String)),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return rows.map(row => row.map((value, column) =>
    column === row.length - 1 ? value : value.padEnd(widths[column])).join(" | ")).join("\n") + "\n";
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
    if (options.compare) {
      // Reuse the exact summary calculations; never construct a detailed plan.
      const comparison = {
        mixed: summarizePackaging(order.items, order.maxItemsPerBox, { mode: "mixed" }),
        "single-sku": summarizePackaging(order.items, order.maxItemsPerBox, { mode: "single-sku" }),
      };
      process.stdout.write(options.json ? JSON.stringify(comparison, null, 2) + "\n" : comparisonReport(comparison));
      return;
    }
    // Check uses the same validation as summaries, without boxes or the detailed-plan limit.
    const operation = options.summary || options.check ? summarizePackaging : planPackaging;
    const result = operation(order.items, order.maxItemsPerBox, { mode: options.mode });
    if (options.check) return;
    if (options.csv) validateCsvSkus(order.items);
    const report = options.csv ? csvReport : options.summary ? summaryReport : textReport;
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + "\n" : report(result));
  } catch (error) {
    // The CLI owns source context; parsing and planning keep their existing diagnostics.
    const source = options.file === undefined || options.file === "-" ? "standard input" : JSON.stringify(options.file);
    process.stderr.write("packaging: " + source + ": " + error.message + "\n");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
