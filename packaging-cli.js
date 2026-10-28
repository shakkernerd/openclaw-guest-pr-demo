#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { planPackaging } = require("./packaging.js");
const { parcelLabel } = require("./parcel-label.js");

const USAGE = [
  "Usage: node packaging-cli.js [--json] [--mode mixed|single-sku] [FILE|-]",
  "       node packaging-cli.js --help",
  "",
  "Read an order JSON object with items and maxItemsPerBox.",
  "Omit FILE or use - to read standard input. Text output is the default.",
  "--json       Write the packing plan as JSON instead of text.",
  "--mode MODE  mixed (default) or single-sku (one SKU per box).",
  "--help, -h   Show this help (use alone).",
  "--           End options, allowing filenames that begin with a dash.",
  "",
  "Exit codes: 0 success/help, 1 input/planning/output error, 2 argument error.",
].join("\n") + "\n";

function parseArguments(args) {
  let file;
  let json = false;
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
  return { file, json, mode: mode === undefined ? "mixed" : mode, help: false };
}

function readOrder(file) {
  const stdin = file === undefined || file === "-";
  let source;
  try {
    source = readFileSync(stdin ? 0 : file, "utf8");
  } catch (error) {
    throw new Error("cannot read " + (stdin ? "standard input" : JSON.stringify(file)) + " (" + error.code + ")");
  }
  let order;
  try {
    order = JSON.parse(source);
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
    const plan = planPackaging(order.items, order.maxItemsPerBox, { mode: options.mode });
    process.stdout.write(options.json ? JSON.stringify(plan, null, 2) + "\n" : textReport(plan));
  } catch (error) {
    process.stderr.write("packaging: " + error.message + "\n");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
