#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { parseManifest } = require("./parcel-manifest.js");

const USAGE = [
  "Usage: node parcel-manifest-cli.js [--json] [--destination CODE]... [--service NAME]... <manifest.json|->",
  "       node parcel-manifest-cli.js --help",
  "",
  "Validate a JSON array of parcels and summarize valid rows only.",
  "Use - to read stdin, --json for a machine-readable report, and -- before",
  "a filename beginning with a dash. See README.md for the row schema.",
  "--destination and --service filter summary counts only; validation is always",
  "for the entire input. Filters are trimmed and case-insensitive. Repeat filters",
  "to match any value within a group (OR); destination and service groups use AND.",
  "",
  "Exit codes: 0 = valid/help, 1 = invalid manifest, 2 = usage or read error.",
  "",
].join("\n");

function parseArguments(args) {
  let json = false;
  let source;
  const filters = {};
  let positionalOnly = false;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { help: true };
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
    } else if (!positionalOnly && arg === "--json") {
      json = true;
    } else if (!positionalOnly && (
      arg === "--destination" || arg.startsWith("--destination=") ||
      arg === "--service" || arg.startsWith("--service=")
    )) {
      const equals = arg.indexOf("=");
      const option = equals === -1 ? arg : arg.slice(0, equals);
      const field = option.slice(2);
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined || (equals === -1 && value.startsWith("-")) || !value.trim()) {
        throw new Error(option + " requires a non-empty value (use " + option + "=VALUE for values beginning with a dash).");
      }
      if (field === "destination" && !/^[a-zA-Z]{2}$/.test(value.trim())) {
        throw new Error("--destination requires a two-letter country code, for example GB or US.");
      }
      const normalized = field === "destination" ? value.trim().toUpperCase() : value.trim().toLowerCase();
      if (!filters[field]) filters[field] = new Set();
      filters[field].add(normalized);
    } else if (!positionalOnly && arg.startsWith("-") && arg !== "-") {
      throw new Error("Unknown option " + JSON.stringify(arg) + ". Use --help for usage.");
    } else if (source !== undefined) {
      throw new Error("Expected exactly one manifest filename or - for stdin.");
    } else {
      source = arg;
    }
  }
  if (source === undefined || source === "") {
    throw new Error("Provide a manifest filename or - for stdin.");
  }
  return { json, source, filters };
}

/** Filter only the validated summary, never the input rows or diagnostics. */
function filterReport(report, filters) {
  if (Object.keys(filters).length === 0) return report;

  // Canonical metadata is independent of option order and duplicate values.
  const applied = {};
  for (const field of ["destination", "service"]) {
    if (filters[field]) {
      const values = [...filters[field]].sort();
      // Preserve the existing single-value report format.
      applied[field] = values.length === 1 ? values[0] : values;
    }
  }
  const pairs = report.summary.byDestinationAndService.filter(({ destination, service }) =>
    (filters.destination === undefined || filters.destination.has(destination)) &&
    (filters.service === undefined || filters.service.has(service)));
  const destinations = new Map();
  const services = new Map();
  for (const { destination, service, parcels } of pairs) {
    destinations.set(destination, (destinations.get(destination) || 0) + parcels);
    services.set(service, (services.get(service) || 0) + parcels);
  }
  return {
    ...report,
    filters: applied,
    summary: {
      // Retain the validator's deterministic order while recalculating totals.
      byDestination: report.summary.byDestination
        .filter(({ destination }) => destinations.has(destination))
        .map(({ destination }) => ({ destination, parcels: destinations.get(destination) })),
      byService: report.summary.byService
        .filter(({ service }) => services.has(service))
        .map(({ service }) => ({ service, parcels: services.get(service) })),
      byDestinationAndService: pairs,
    },
  };
}

function formatSummary(report) {
  const lines = [
    "Parcels: " + report.totalRows + " total, " + report.validRows + " valid, " + report.invalidRows + " invalid.",
    ...(report.filters ? ["Filters: " + Object.entries(report.filters)
      .map(([key, value]) => key + "=" + JSON.stringify(value)).join(", ")] : []),
    report.filters ? "Summary (matching valid parcels only):" : "Summary (valid parcels only):",
    "By destination:",
    ...report.summary.byDestination.map(({ destination, parcels }) =>
      "  " + JSON.stringify(destination) + ": " + parcels),
    "By service:",
    ...report.summary.byService.map(({ service, parcels }) =>
      "  " + JSON.stringify(service) + ": " + parcels),
    "By destination and service:",
    ...report.summary.byDestinationAndService.map(({ destination, service, parcels }) =>
      "  " + JSON.stringify(destination) + " / " + JSON.stringify(service) + ": " + parcels),
  ];
  if (report.summary.byDestinationAndService.length === 0) {
    lines.push(report.filters ? "  No valid parcels match the filters." : "  No valid parcels to summarize.");
  }
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

  let source;
  try {
    source = readFileSync(options.source === "-" ? 0 : options.source, "utf8");
  } catch (error) {
    process.stderr.write("Error: cannot read " + JSON.stringify(options.source) + " (" + (error.code || "read failed") + ").\n");
    return 2;
  }

  const report = filterReport(parseManifest(source), options.filters);
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    for (const error of report.errors) {
      const location = error.row === null ? "Manifest" : "Row " + error.row;
      process.stderr.write(location + " [" + error.field + "]: " + error.message + "\n");
    }
    process.stdout.write(formatSummary(report));
  }
  return report.valid ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
