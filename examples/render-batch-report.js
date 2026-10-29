#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const USAGE = "Usage: node examples/render-batch-report.js REPORT_FILE [REPORT_FILE ...]\n" +
  "Saved reader JSON only; no options or stdin. Use ./ for dash-leading filenames.\n";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => count(value) && value > 0;
const stream = value => value === "stdout" || value === "stderr";
const observation = value => keys(value, ["stream", "frame", "record"]) &&
  stream(value.stream) && positive(value.frame) && object(value.record);

// Check the presentation containers, not producer envelopes, arithmetic or truth.
// Reject unknown container fields rather than silently dropping saved evidence.
function supported(report) {
  return keys(report, ["observed", "rows", "terminalEvents", "issues", "limits"]) &&
    keys(report.observed, ["stdout", "stderr", "summaries", "rejections", "completions", "fatals"]) &&
    ["stdout", "stderr"].every(name => {
      const capture = report.observed[name];
      return keys(capture, ["frames", "accepted", "fragments", "readError"]) &&
        ["frames", "accepted", "fragments"].every(key => count(capture[key])) &&
        (capture.readError === null || typeof capture.readError === "string");
    }) &&
    ["summaries", "rejections", "completions", "fatals"].every(key => count(report.observed[key])) &&
    Array.isArray(report.rows) && report.rows.every(row =>
      keys(row, ["line", "outcomes"]) && positive(row.line) &&
      Array.isArray(row.outcomes) && row.outcomes.every(observation)) &&
    Array.isArray(report.terminalEvents) && report.terminalEvents.every(observation) &&
    Array.isArray(report.issues) && report.issues.every(issue => object(issue) &&
      typeof issue.code === "string" && stream(issue.stream)) &&
    Array.isArray(report.limits) && report.limits.every(limit => typeof limit === "string");
}

// All report-derived values (including keys and filenames) enter text nodes only.
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const valueHTML = value => object(value) || Array.isArray(value)
  ? `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`
  : `<span class="value">${escape(value === null ? "null" : value)}</span>`;
const fields = (value, rawText = false) => `<dl class="fields">${Object.entries(value).map(([key, value]) => {
  // HTML parsing normalizes literal CR. Keep raw issue text in JSON string notation.
  const quoted = rawText && key === "text" && typeof value === "string";
  return `<dt>${escape(key)}${quoted ? " (JSON string)" : ""}</dt><dd>${quoted
    ? `<pre>${escape(JSON.stringify(value))}</pre>` : valueHTML(value)}</dd>`;
}).join("")}</dl>`;

function recordHTML(record) {
  if (!object(record.mixed) || !object(record["single-sku"])) return fields(record);
  const names = [...new Set([...Object.keys(record.mixed), ...Object.keys(record["single-sku"])])];
  return fields(Object.fromEntries(Object.entries(record).filter(([key]) =>
    key !== "mixed" && key !== "single-sku"))) +
    `<table><caption>Captured summaries — not recalculated</caption>
<thead><tr><th scope="col">Field</th><th scope="col">mixed</th><th scope="col">single-sku</th></tr></thead>
<tbody>${names.map(key => `<tr><th scope="row">${escape(key)}</th>${["mixed", "single-sku"].map(mode =>
      `<td>${Object.hasOwn(record[mode], key) ? valueHTML(record[mode][key]) : "<em>not present</em>"}</td>`
    ).join("")}</tr>`).join("")}</tbody></table>`;
}

function observationHTML(item, index) {
  return `<section class="observation"><h4>Observation ${index + 1} · ${escape(item.stream)} · frame ${escape(item.frame)}</h4>
${recordHTML(item.record)}</section>`;
}

function reportHTML(report, file, index) {
  const { observed, rows, terminalEvents, issues, limits } = report;
  return `<article class="report" aria-labelledby="report-${index + 1}">
<header><p class="eyebrow">Saved report ${index + 1}</p><h2 id="report-${index + 1}">${escape(file)}</h2>
<p>Kept separate from every other report. File names and supplied content are not provenance verification.</p></header>
<section><h3>What the captures show</h3>
<p>Counts below are copied from the saved reader report, not unique-input totals or a new audit.</p>
<div class="captures">${["stdout", "stderr"].map(name =>
    `<section class="capture"><h4>${name} capture</h4>${fields(observed[name])}</section>`).join("")}</div>
${fields(Object.fromEntries(["summaries", "rejections", "completions", "fatals"].map(key => [key, observed[key]])))}</section>
<section class="limits"><h3>What these captures cannot prove</h3>
<p><strong>No process-result verdict.</strong> A captured completion (including exitCode 0) is not an observed process exit.
Missing, fatal or conflicting evidence stays unresolved. No pairing, draining, input completeness, persistence or physical packing is established.</p>
<p>Saved reader limits (verbatim):</p>
${limits.length ? `<ul>${limits.map(limit => `<li>${escape(limit)}</li>`).join("")}</ul>` :
    "<p>No limits were supplied. That absence does not remove the caveats above.</p>"}</section>
<section><h3>Warnings / reader issues · ${issues.length}</h3>
<p>Issue order is the saved reader order, not a cross-stream timeline. All details remain attached to their own issue.</p>
${issues.length ? issues.map((issue, i) => `<section class="issue"><h4>Issue ${i + 1} · ${escape(issue.code)}</h4>
${fields(issue, true)}</section>`).join("") :
    "<p>No reader issues were recorded. This is not proof that the original batch succeeded.</p>"}</section>
<section><h3>Input-line observations · ${rows.length} groups</h3>
<p>Every outcome is retained, including duplicates, conflicts and overlap. Line gaps are not classified; stdout/stderr order is not chronology.</p>
${rows.length ? rows.map(row => `<section class="row"><h4 class="line">Input line ${escape(row.line)}</h4>
${row.outcomes.length ? row.outcomes.map(observationHTML).join("") : "<p>No outcomes supplied for this group.</p>"}</section>`).join("") :
    "<p>No input-line observations supplied.</p>"}</section>
<section><h3>Terminal observations · ${terminalEvents.length}</h3>
<p>All saved completions and fatals, in saved order; these are records, not independently observed process results.</p>
${terminalEvents.length ? terminalEvents.map(observationHTML).join("") : "<p>No terminal observations supplied.</p>"}</section>
</article>`;
}

const STYLE = `
:root { color-scheme: light; font-family: system-ui, sans-serif; color: #182a36; background: #edf2f5; }
* { box-sizing: border-box; }
body { margin: 0; font-size: 16px; line-height: 1.55; }
main { max-width: 1060px; margin: auto; padding: 36px 28px; }
h1, h2, h3, h4 { line-height: 1.25; break-after: avoid; overflow-wrap: anywhere; }
h1 { font-size: 2.25rem; margin: 0 0 14px; }
h2 { font-size: 1.35rem; overflow-wrap: anywhere; }
h3 { font-size: 1.2rem; margin: 28px 0 12px; }
h4 { font-size: 1rem; margin: 0 0 12px; }
p { margin: 10px 0; }
.eyebrow { font-size: .8rem; text-transform: uppercase; letter-spacing: .12em; font-weight: 700; color: #315d6b; }
.intro { max-width: 76ch; margin-bottom: 28px; }
.report { background: white; border: 1px solid #bccbd3; border-radius: 12px; padding: 28px; margin: 24px 0; }
.report > header { border-bottom: 2px solid #315d6b; padding-bottom: 14px; }
.captures { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.capture, .observation, .issue { border: 1px solid #bccbd3; border-radius: 6px; padding: 16px; margin: 12px 0; min-width: 0; }
.capture { background: #f5f8fa; }
.limits { border-left: 4px solid #8b6419; padding: 1px 18px 12px; background: #fff8e8; }
.issue { border-left: 4px solid #8b6419; }
li { margin: 8px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
ul { padding-left: 22px; }
.fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 5px 16px; margin: 0; }
dt { font-weight: 600; }
dd { margin: 0; min-width: 0; }
dt, dd, th, td { overflow-wrap: anywhere; }
.value { white-space: pre-wrap; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: .88em/1.5 ui-monospace, monospace; }
.line { margin: 22px 0 8px; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: .9rem; }
caption { text-align: left; font-weight: 600; margin: 12px 0 8px; }
th, td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid #d4dfe5; }
thead { background: #edf2f5; }
th:first-child { width: 44%; }
footer { font-size: .88rem; }
@media (max-width: 600px) {
  main { padding: 20px 12px; }
  h1 { font-size: 1.8rem; }
  .report { padding: 16px; }
  .captures { grid-template-columns: 1fr; gap: 0; }
  .observation, .issue, .capture { padding: 12px; }
  .fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr); gap: 6px 10px; }
  th, td { padding: 6px 4px; }
  .limits { padding-left: 12px; padding-right: 10px; }
}
@page { size: A4; margin: 14mm; }
@media print {
  :root { background: white; color: black; }
  body { font-size: 10pt; line-height: 1.4; }
  main { max-width: none; padding: 0; }
  h1 { font-size: 22pt; }
  h2 { font-size: 15pt; }
  h3 { font-size: 12pt; margin-top: 18px; }
  h4 { font-size: 10pt; }
  .report { border: 0; border-radius: 0; padding: 0; margin: 18px 0 0; }
  .report + .report { break-before: page; }
  .capture, .observation, .issue { break-inside: avoid; padding: 10px; }
  .limits { background: white; border-color: black; }
  table { font-size: 9pt; }
  th, td { padding: 4px 6px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  .eyebrow { color: black; }
}
`;

function render(reports) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Batch capture handoff</title><style>${STYLE}</style></head><body><main>
<header class="intro"><p class="eyebrow">Saved evidence · printable handoff</p><h1>Batch capture handoff</h1>
<p>Read-only presentation of ${reports.length} saved reader report(s). No producer or reader was run by this companion.</p>
<p><strong>Observations, not a success certificate.</strong> Supplied report values are displayed without validating orders or recalculating packing.</p></header>
${reports.map(({ report, file }, index) => reportHTML(report, file, index)).join("\n")}
<footer>Companion exit 0 means only that HTML was written. Reader exit 0 means only that a report was produced. Neither establishes batch success.
Use your browser’s Print command; all evidence is expanded without scripts or external assets.</footer>
</main></body></html>
`;
}

const errorCode = error => typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
  ? error.code : "IO_ERROR";
function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw Object.assign(new Error("write made no progress"), { code: "EIO" });
    offset += written;
  }
}
function diagnostic(text) {
  try { writeAll(2, text); } catch { /* Best effort only. */ }
}
function main(args) {
  if (!args.length || args.some(arg => !arg || arg.startsWith("-"))) {
    try { writeAll(2, USAGE); } catch { return 1; }
    return 2;
  }
  const reports = [];
  for (const [index, file] of args.entries()) {
    let source;
    try { source = fs.readFileSync(file, "utf8"); } catch (error) {
      diagnostic(`render-batch-report: input ${index + 1}: cannot read (${errorCode(error)})\n`);
      return 1;
    }
    let report;
    try { report = JSON.parse(source); } catch {
      diagnostic(`render-batch-report: input ${index + 1}: invalid JSON\n`);
      return 1;
    }
    if (!supported(report)) {
      diagnostic(`render-batch-report: input ${index + 1}: unsupported report shape\n`);
      return 1;
    }
    reports.push({ file, report });
  }
  try { writeAll(1, render(reports)); } catch (error) {
    diagnostic(`render-batch-report: cannot write HTML (${errorCode(error)})\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
