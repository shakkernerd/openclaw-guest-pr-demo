#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { TextDecoder } = require("node:util");
const { parcelLabel } = require("./parcel-label.js");

const CONFIRMATIONS = [
  ["securelyPacked", "Items securely packed", "Pack the items securely"],
  ["cushioningUsed", "Suitable cushioning used", "Add suitable cushioning"],
  ["sealed", "Parcel sealed", "Seal the parcel"],
  ["addressMatchesOrder", "Address checked against order", "Compare the full delivery address with the order"],
  ["recipientReadable", "Recipient name readable on label", "Check that the recipient name on the label is readable"],
  ["labelAttached", "Label securely attached", "Securely attach the label"],
];

// Preserve international text, but reject terminal controls and text that can
// insert or visually reorder checklist lines. Escape it even in error reports.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
const UNSAFE_TEXT_GLOBAL = new RegExp(UNSAFE_TEXT.source, "gu");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeUnsafeText(value) {
  return value.replace(UNSAFE_TEXT_GLOBAL, (character) =>
    "\\u" + character.codePointAt(0).toString(16).padStart(4, "0"));
}

function safeText(value) {
  if (typeof value !== "string") return "(missing or invalid)";
  if (!value.trim()) return "(blank)";
  return escapeUnsafeText(value);
}

function requireText(value, path, issues) {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, message: "must be a non-blank string; copy the complete value from the order." });
    return false;
  }
  if (UNSAFE_TEXT.test(value)) {
    issues.push({ path, message: "must be single-line text without control characters, bidi overrides or unpaired Unicode surrogates; correct the source text." });
    return false;
  }
  return true;
}

function requireCount(value, path, issues) {
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push({ path, message: "must be a positive safe integer (1–9007199254740991); enter a numeric item count, not a string." });
    return false;
  }
  return true;
}

function validateParcel(data, index) {
  const path = "parcels[" + index + "]";
  const entry = { index, data, issues: [], checks: [], counted: false, orderCounted: false };
  if (!isRecord(data)) {
    entry.issues.push({ path, message: "must be an object; supply one parcel with an ID, recipient, address, counts and checks." });
    return entry;
  }

  entry.checks.push({
    label: "Unique parcel ID provided",
    passed: requireText(data.id, path + ".id", entry.issues),
  });
  entry.checks.push({
    label: "Recipient name provided",
    passed: requireText(data.recipient, path + ".recipient", entry.issues),
  });

  let addressValid = true;
  if (!isRecord(data.address)) {
    entry.issues.push({ path: path + ".address", message: "must be an object; supply street, postcode and destination country from the order." });
    addressValid = false;
  } else {
    for (const key of ["street", "postcode", "country", "city", "region"]) {
      if ((key === "city" || key === "region") && !Object.hasOwn(data.address, key)) continue;
      if (!requireText(data.address[key], path + ".address." + key, entry.issues)) addressValid = false;
    }
  }
  entry.checks.push({ label: "Complete delivery address provided", passed: addressValid });

  entry.counted = requireCount(data.itemCount, path + ".itemCount", entry.issues);
  entry.orderCounted = requireCount(data.orderItemCount, path + ".orderItemCount", entry.issues);
  const countsMatch = entry.counted && entry.orderCounted && data.itemCount === data.orderItemCount;
  if (entry.counted && entry.orderCounted && !countsMatch) {
    entry.issues.push({
      path: path + ".itemCount",
      message: "packed count " + data.itemCount + " does not match orderItemCount " + data.orderItemCount +
        "; reconcile the packed items with the order before dispatch.",
    });
  }
  entry.checks.push({ label: "Item count matches order", passed: countsMatch });

  const checksValid = isRecord(data.checks);
  if (!checksValid) {
    entry.issues.push({ path: path + ".checks", message: "must be an object; record each listed packing and label confirmation as boolean true only after completing it." });
  }
  for (const [key, label, action] of CONFIRMATIONS) {
    const passed = checksValid && data.checks[key] === true;
    entry.checks.push({ label, passed });
    if (checksValid && !passed) {
      entry.issues.push({ path: path + ".checks." + key, message: "must be explicitly true (boolean). " + action + ", then record true." });
    }
  }
  return entry;
}

function validateDispatch(dispatch) {
  const issues = [];
  const entries = [];
  if (!isRecord(dispatch) || !Array.isArray(dispatch.parcels)) {
    issues.push({ path: "parcels", message: "provide a JSON object with a parcels array containing one entry per parcel." });
  } else if (dispatch.parcels.length === 0) {
    issues.push({ path: "parcels", message: "is empty; add at least one parcel before dispatch." });
  } else {
    const ids = new Map();
    for (const [index, data] of dispatch.parcels.entries()) {
      const entry = validateParcel(data, index);
      entries.push(entry);
      if (entry.checks[0]?.passed) {
        const matches = ids.get(data.id) || [];
        matches.push(entry);
        ids.set(data.id, matches);
      }
    }
    for (const matches of ids.values()) {
      if (matches.length < 2) continue;
      for (const entry of matches) {
        entry.checks[0].passed = false;
        entry.issues.push({
          path: "parcels[" + entry.index + "].id",
          message: "duplicates another parcel ID; assign a unique ID to each physical parcel and check for duplicate entries.",
        });
      }
    }
    for (const entry of entries) issues.push(...entry.issues);
  }

  // BigInt prevents correct individual counts from making the total imprecise.
  const totals = { parcels: entries.length, items: 0n, readyItems: 0n, uncounted: 0, ready: 0 };
  for (const entry of entries) {
    if (entry.counted) totals.items += BigInt(entry.data.itemCount);
    else totals.uncounted += 1;
    if (entry.issues.length === 0) {
      totals.ready += 1;
      totals.readyItems += BigInt(entry.data.itemCount);
    }
  }
  return { entries, issues, totals, ok: issues.length === 0 };
}

function countLabel(value, valid) {
  return valid ? parcelLabel(value) : "unknown (invalid count)";
}

function formatChecklist(report) {
  const { totals } = report;
  const partial = totals.uncounted ? " (partial; " + totals.uncounted + " uncounted parcel(s))" : "";
  const lines = [
    "E10 Dispatch Desk — packing checklist",
    "Parcels: " + totals.parcels + " | Items: " + totals.items + partial +
      " | Ready: " + totals.ready + " | Needs attention: " + (totals.parcels - totals.ready),
    "Ready-to-dispatch items: " + totals.readyItems,
  ];
  for (const entry of report.entries) {
    const data = isRecord(entry.data) ? entry.data : {};
    lines.push("", "Parcel " + (entry.index + 1) + " — " + safeText(data.id) +
      " [" + (entry.issues.length ? "NEEDS ATTENTION" : "READY") + "]");
    if (!isRecord(entry.data)) {
      lines.push("  [ ] Supply a valid parcel object (see anomalies).");
      continue;
    }
    const address = isRecord(data.address) ? data.address : {};
    lines.push("  Recipient: " + safeText(data.recipient), "  Address:");
    for (const key of ["street", "city", "region", "postcode", "country"]) {
      if ((key === "city" || key === "region") && !Object.hasOwn(address, key)) continue;
      lines.push("    " + key + ": " + safeText(address[key]));
    }
    lines.push("  Contents: " + countLabel(data.itemCount, entry.counted) +
      " (order: " + countLabel(data.orderItemCount, entry.orderCounted) + ")");
    for (const check of entry.checks) lines.push("  [" + (check.passed ? "x" : " ") + "] " + check.label);
  }
  lines.push("", report.ok ? "Anomalies: none" : "Anomalies (" + report.issues.length + "):");
  for (const issue of report.issues) lines.push("  - " + issue.path + ": " + issue.message);
  lines.push("", report.ok ? "Result: READY — all recorded checks passed." :
    "Result: NEEDS ATTENTION — resolve every anomaly before dispatch.");
  return lines.join("\n") + "\n";
}

// Quoting is not sufficient to stop spreadsheet formula interpretation. Prefix
// before ALL leading whitespace/invisible controls, without trimming the value.
const FORMULA_TEXT = /^[\s\p{Cc}\p{Cf}]*[=+@-]/u;

function csvText(value) {
  if (typeof value !== "string") return '""';
  const prefix = FORMULA_TEXT.test(value) ? "'" : "";
  const escaped = escapeUnsafeText(value);
  return '"' + (prefix + escaped).replaceAll('"', '""') + '"';
}

function formatCsv(report) {
  const lines = ["id,recipient,street,city,region,postcode,country,itemCount,readiness,anomalies"];
  for (const entry of report.entries) {
    const data = isRecord(entry.data) ? entry.data : {};
    const address = isRecord(data.address) ? data.address : {};
    // Use the original validation issues; omit corrective prose for handoff.
    const anomalies = entry.issues.map((issue) =>
      issue.path + ": " + issue.message.split(/;|\. /, 1)[0].replace(/\.$/, "")).join(" | ");
    lines.push([
      ...[data.id, data.recipient, address.street, address.city, address.region,
        address.postcode, address.country].map(csvText),
      entry.counted ? String(data.itemCount) : "",
      csvText(entry.issues.length ? "NEEDS ATTENTION" : "READY"),
      csvText(anomalies),
    ].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// All report data stays in text nodes, never in attributes, styles or URLs.
function htmlEscape(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

function htmlIssues(issues) {
  return '<ul class="anomalies">\n' + issues.map((issue) =>
    '<li><code>' + htmlEscape(issue.path) + '</code>: ' + htmlEscape(issue.message) + '</li>').join("\n") + '\n</ul>';
}

function formatHtml(report) {
  const { totals } = report;
  const partial = totals.uncounted ? " (partial; " + totals.uncounted + " uncounted parcel(s))" : "";
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
    '<title>E10 Dispatch Desk — packing handoff</title>',
    '<style>',
    '@page { margin: 14mm; }',
    '* { box-sizing: border-box; }',
    'body { max-width: 56rem; margin: 0 auto; padding: 1.5rem; color: #111; background: #fff; font: 11pt/1.4 sans-serif; }',
    'h1 { font-size: 20pt; margin: 0 0 .5rem; }',
    'h2 { font-size: 14pt; margin: 0 0 .4rem; break-after: avoid; }',
    'h3 { font-size: 11pt; margin: .7rem 0 .3rem; break-after: avoid; }',
    'p { margin: .4rem 0; }',
    '.summary { border: 2px solid #111; padding: .7rem 1rem; margin: 1rem 0; break-inside: avoid; }',
    'dl { display: grid; grid-template-columns: 12rem minmax(0, 1fr); gap: .2rem .7rem; margin: .5rem 0; }',
    'dt { font-weight: bold; } dd { margin: 0; }',
    '.value { white-space: pre-wrap; }',
    '.value, dd, li, code { overflow-wrap: anywhere; }',
    '.parcel { border-top: 1px solid #555; padding-top: .7rem; margin-top: 1rem; break-inside: avoid-page; page-break-inside: avoid; }',
    '.checks { list-style: none; padding: 0; columns: 2; column-gap: 1.5rem; }',
    'li { margin-bottom: .25rem; break-inside: avoid; }',
    '.anomalies { padding-left: 1.3rem; }',
    'footer { border-top: 1px solid #555; margin-top: 1rem; padding-top: .5rem; font-size: 9pt; }',
    '@media (max-width: 36rem) { dl { display: block; } dd { margin-bottom: .4rem; } .checks { columns: 1; } }',
    '@media print { body { max-width: none; margin: 0; padding: 0; font-size: 10pt; } h1 { font-size: 17pt; } }',
    '</style>',
    '</head>',
    '<body><main>',
    '<h1>E10 Dispatch Desk — packing handoff</h1>',
    '<section class="summary" aria-labelledby="readiness">',
    '<h2 id="readiness">Result: ' + (report.ok ? 'READY' : 'NEEDS ATTENTION') + '</h2>',
    '<p>' + (report.ok ? 'All recorded checks passed.' : 'Resolve every anomaly before dispatch.') + '</p>',
    '<dl>',
    '<dt>Parcels</dt><dd>' + htmlEscape(totals.parcels) + '</dd>',
    '<dt>All counted items</dt><dd>' + htmlEscape(String(totals.items) + partial) + '</dd>',
    '<dt>Ready-to-dispatch items</dt><dd>' + htmlEscape(totals.readyItems) + '</dd>',
    '<dt>Ready parcels</dt><dd>' + htmlEscape(totals.ready) + '</dd>',
    '<dt>Needs attention</dt><dd>' + htmlEscape(totals.parcels - totals.ready) + '</dd>',
    '<dt>Anomalies</dt><dd>' + htmlEscape(report.issues.length) + '</dd>',
    '</dl></section>',
    '<p>[x] Recorded check passed. [ ] Requires attention.</p>',
  ];
  if (report.entries.length === 0 && report.issues.length) {
    lines.push('<h2>Dispatch anomalies</h2>', htmlIssues(report.issues));
  }
  for (const entry of report.entries) {
    const data = isRecord(entry.data) ? entry.data : {};
    const address = isRecord(data.address) ? data.address : {};
    lines.push('<section class="parcel">',
      '<h2>Parcel ' + htmlEscape(entry.index + 1) + ' — <bdi class="value">' + htmlEscape(safeText(data.id)) + '</bdi></h2>',
      '<p><strong>' + (entry.issues.length ? 'NEEDS ATTENTION' : 'READY') + '</strong></p>',
      '<dl><dt>Recipient</dt><dd><bdi class="value">' + htmlEscape(safeText(data.recipient)) + '</bdi></dd>');
    for (const key of ["street", "city", "region", "postcode", "country"]) {
      if ((key === "city" || key === "region") && !Object.hasOwn(address, key)) continue;
      lines.push('<dt>' + htmlEscape(key) + '</dt><dd><bdi class="value">' + htmlEscape(safeText(address[key])) + '</bdi></dd>');
    }
    lines.push('<dt>Contents</dt><dd>' + htmlEscape(countLabel(data.itemCount, entry.counted)) +
      ' (order: ' + htmlEscape(countLabel(data.orderItemCount, entry.orderCounted)) + ')</dd></dl>',
      '<h3>Recorded checks</h3>', '<ul class="checks">');
    if (!entry.checks.length) lines.push('<li>[ ] Supply a valid parcel object (see anomalies).</li>');
    for (const check of entry.checks) {
      lines.push('<li>[' + (check.passed ? 'x' : ' ') + '] ' + htmlEscape(check.label) + '</li>');
    }
    lines.push('</ul>');
    if (entry.issues.length) lines.push('<h3>Actionable anomalies</h3>', htmlIssues(entry.issues));
    else lines.push('<p>Anomalies: none</p>');
    lines.push('</section>');
  }
  lines.push('<footer><p>Recorded checks only — physical verification and sign-off are still required.</p>',
    '<p>Reviewed by: ____________________ &nbsp; Date: ____________________</p></footer>',
    '</main></body>', '</html>');
  return lines.join("\n") + "\n";
}

const USAGE = [
  "Usage: node packing-quality.js [--csv | --html] <dispatch.json>",
  "       node packing-quality.js --help",
  "",
  "Validate one UTF-8 JSON file and print a packing checklist.",
  "--csv prints a spreadsheet-safe handoff CSV to stdout instead (same exit codes).",
  "--html prints a self-contained printable handoff sheet to stdout (same exit codes).",
  "Choose at most one output flag; the default is the text checklist.",
  "Use ./ before filenames beginning with a dash. See README.md for the schema.",
  "Exit codes: 0 ready/help; 1 validation anomalies; 2 usage, input or output I/O error.",
  "",
].join("\n");

function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const outputFlags = args.filter((arg) => arg === "--csv" || arg === "--html");
  const paths = args.filter((arg) => arg !== "--csv" && arg !== "--html");
  if (paths.length !== 1 || !paths[0] || paths[0].startsWith("-") || outputFlags.length > 1) {
    process.stderr.write("Error: expected one dispatch JSON file and at most one output flag (--csv or --html).\n" + USAGE);
    return 2;
  }
  const csv = outputFlags[0] === "--csv";
  const html = outputFlags[0] === "--html";
  const inputPath = paths[0];
  let bytes;
  try {
    bytes = readFileSync(inputPath);
  } catch (error) {
    process.stderr.write("Error: cannot read " + safeText(inputPath) + " (" + (error.code || "I/O error") +
      "). Check the path and read permissions.\n");
    return 2;
  }
  let source;
  try {
    // Fatal decoding avoids silently replacing characters in names/addresses.
    // TextDecoder also accepts and strips an optional UTF-8 BOM.
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    process.stderr.write("Error: " + safeText(inputPath) + " is not valid UTF-8. Save the dispatch file as UTF-8.\n");
    return 2;
  }
  let dispatch;
  try {
    dispatch = JSON.parse(source);
  } catch {
    process.stderr.write("Error: invalid JSON in " + safeText(inputPath) +
      ". Check JSON syntax (double-quoted keys/strings, no comments or trailing commas).\n");
    return 2;
  }
  const report = validateDispatch(dispatch);
  process.stdout.write(csv ? formatCsv(report) : html ? formatHtml(report) : formatChecklist(report));
  // No fake parcel row for dispatch-level failures; keep stdout valid CSV.
  if (csv && report.entries.length === 0) {
    for (const issue of report.issues) {
      process.stderr.write("Validation anomaly: " + issue.path + ": " + issue.message + "\n");
    }
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.stdout.on("error", (error) => {
    // A preview reader (e.g. head) may stop early. Keep the validation status;
    // EPIPE does not establish that the consumer successfully saved an export.
    if (error.code === "EPIPE") return;
    process.exitCode = 2;
    process.stderr.write("Error: cannot write output (" + safeText(error.code || "I/O error") +
      "). Check the output destination and available space; the export may be incomplete.\n");
  });
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { validateDispatch, formatChecklist, formatCsv, formatHtml };
