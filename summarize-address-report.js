"use strict";

const { readFileSync } = require("node:fs");
const { savedBatchReportCodec } = require("./saved-batch-report.js");

function literal(value) {
  // JSON handles quotes, controls and lone surrogates. Escape remaining non-ASCII
  // UTF-16 code units (including each half of a pair) without normalizing values.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

function summarize(file, report) {
  const lines = [
    "Recorded saved-report data (textual projection)",
    "Report: " + literal(file),
    "Total: " + report.total + "; succeeded: " + report.succeeded + "; failed: " + report.failed,
  ];
  for (const result of report.results) {
    lines.push(result.position + ". status=" + (result.ok ? "success" : "failure") +
      " file=" + literal(result.file));
    if (result.ok) {
      lines.push("   formatted=" + literal(result.formatted));
    } else {
      lines.push("   error: stage=" + literal(result.error.stage) +
        " name=" + literal(result.error.name) + " message=" + literal(result.error.message));
    }
  }
  return lines.join("\n") + "\n";
}

const files = process.argv.slice(2);

if (files.length !== 1) {
  process.stderr.write("Usage: node summarize-address-report.js FILE\n");
  process.exitCode = 2;
} else {
  const file = files[0];
  let stage = "read";
  let output;
  try {
    const bytes = readFileSync(file);
    stage = "decode";
    const report = savedBatchReportCodec.decode(bytes);
    output = summarize(file, report);
  } catch (error) {
    process.stderr.write("Could not summarize saved report: file=" + literal(file) +
      " stage=" + literal(stage) + " name=" + literal(error.name) +
      " message=" + literal(error.message) + "\n");
    process.exitCode = 1;
  }
  // Do not emit a partial summary on read/decode failure; let Node drain stdout.
  if (output !== undefined) process.stdout.write(output);
}
