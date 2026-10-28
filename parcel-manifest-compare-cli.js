#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { parseManifest } = require("./parcel-manifest.js");
const { parcelLabel } = require("./parcel-label.js");

const FIELDS = ["recipient", "street", "postcode", "destination", "service", "itemCount"];
const USAGE = [
  "Usage: node parcel-manifest-compare-cli.js [--json] <before.json|-> <after.json|->",
  "       node parcel-manifest-compare-cli.js --help",
  "",
  "Compare two manifests by trimmed, case-sensitive parcel IDs.",
  "Both inputs must pass validation before any comparison is produced.",
  "Use --json for a machine-readable report, or -- before dash-prefixed filenames.",
  "Use - for either input to read stdin; only one input may be -.",
  "",
  "Exit codes: 0 = compared/help (even with differences), 1 = invalid manifest,",
  "            2 = usage or read error.",
  "",
].join("\n");

function parseArguments(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  const files = [];
  let json = false;
  let positionalOnly = false;
  for (const arg of args) {
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
    } else if (!positionalOnly && arg === "--json") {
      json = true;
    } else if (!positionalOnly && arg.startsWith("-") && arg !== "-") {
      throw new Error("Unknown option " + JSON.stringify(arg) + ". Use --help for usage.");
    } else {
      files.push(arg);
    }
  }
  if (files.length !== 2 || files.some((file) => file === "")) {
    throw new Error("Provide exactly two inputs: before.json after.json; use - for one input to read stdin.");
  }
  if (files.filter((file) => file === "-").length > 1) {
    throw new Error("Only one input may be - (stdin); provide a filename for the other input.");
  }
  return { json, files };
}

function loadInput(file) {
  let source;
  try {
    source = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (error) {
    return {
      file,
      readError: true,
      validation: {
        valid: false, totalRows: null, validRows: null, invalidRows: null,
        errors: [{ row: null, field: "$", message: "Cannot read " + (file === "-" ? "stdin" : "file") + " (" + (error.code || "read failed") + ")." }],
      },
    };
  }
  const validation = parseManifest(source);
  return {
    file, readError: false, validation,
    // Reuse the existing validator unchanged; only valid JSON is parsed again.
    parcels: validation.valid ? JSON.parse(source) : null,
  };
}

function normalizeParcel(parcel) {
  return {
    id: parcel.id.trim(),
    recipient: parcel.recipient.trim(),
    street: parcel.street.trim(),
    postcode: parcel.postcode.trim(),
    destination: parcel.destination.trim().toUpperCase(),
    service: parcel.service.trim().toLowerCase(),
    itemCount: parcel.itemCount,
  };
}

/** Called only after both complete inputs have passed validation. */
function compareParcels(before, after) {
  const index = (parcels) => new Map(parcels.map((parcel) => {
    const normalized = normalizeParcel(parcel);
    return [normalized.id, normalized];
  }));
  const previous = index(before);
  const current = index(after);
  const comparison = { added: [], removed: [], changed: [], unchanged: 0 };
  const ids = [...new Set([...previous.keys(), ...current.keys()])].sort();
  for (const id of ids) {
    if (!previous.has(id)) {
      comparison.added.push(current.get(id));
    } else if (!current.has(id)) {
      comparison.removed.push(previous.get(id));
    } else {
      const changes = FIELDS.filter((field) => previous.get(id)[field] !== current.get(id)[field])
        .map((field) => ({ field, before: previous.get(id)[field], after: current.get(id)[field] }));
      if (changes.length) comparison.changed.push({ id, changes });
      else comparison.unchanged += 1;
    }
  }
  return comparison;
}

function buildReport(before, after) {
  const inputs = {};
  const errors = [];
  for (const [input, loaded] of [["before", before], ["after", after]]) {
    const { valid, totalRows, validRows, invalidRows } = loaded.validation;
    inputs[input] = { file: loaded.file, valid, totalRows, validRows, invalidRows };
    for (const error of loaded.validation.errors) {
      errors.push({ input, file: loaded.file, ...error });
    }
  }
  const valid = before.validation.valid && after.validation.valid;
  return {
    valid,
    inputs,
    errors,
    comparison: valid ? compareParcels(before.parcels, after.parcels) : null,
  };
}

function formatInput(file) {
  return file === "-" ? "stdin (-)" : JSON.stringify(file);
}

function formatReport(report) {
  const lines = ["Comparing " + formatInput(report.inputs.before.file) + " -> " + formatInput(report.inputs.after.file)];
  if (!report.valid) {
    lines.push("Comparison not performed: fix the input errors and retry.");
    return lines.join("\n") + "\n";
  }
  lines.push("Parcels: " + report.inputs.before.totalRows + " before, " + report.inputs.after.totalRows + " after.");
  for (const [label, parcels] of [["Added", report.comparison.added], ["Removed", report.comparison.removed]]) {
    lines.push(label + ": " + parcels.length);
    for (const parcel of parcels) {
      lines.push("  " + JSON.stringify(parcel.id) + ": " + JSON.stringify(parcel.destination) +
        " / " + JSON.stringify(parcel.service) + " (" + parcelLabel(parcel.itemCount) + ")");
    }
  }
  lines.push("Changed: " + report.comparison.changed.length);
  for (const { id, changes } of report.comparison.changed) {
    lines.push("  " + JSON.stringify(id) + ":");
    for (const { field, before, after } of changes) {
      lines.push("    " + field + ": " + JSON.stringify(before) + " -> " + JSON.stringify(after));
    }
  }
  lines.push("Unchanged: " + report.comparison.unchanged);
  return lines.join("\n") + "\n";
}

function main(args) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    process.stderr.write("Error: " + error.message + "\n" + USAGE);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Always inspect both inputs, even when the first cannot be read or validated.
  const before = loadInput(options.files[0]);
  const after = loadInput(options.files[1]);
  const report = buildReport(before, after);
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    for (const error of report.errors) {
      const location = error.row === null ? "Manifest" : "Row " + error.row;
      process.stderr.write(error.input + " " + formatInput(error.file) + " " + location +
        " [" + error.field + "]: " + error.message + "\n");
    }
    process.stdout.write(formatReport(report));
  }
  if (before.readError || after.readError) return 2;
  return report.valid ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
