"use strict";

const { readFileSync } = require("node:fs");
const { savedBatchReportCodec } = require("./saved-batch-report.js");
const { summarizeReport } = require("./saved-batch-summary.js");

const usage = "Usage: node summarize-address-report.js [FILE]\n";
const help = usage + "\n" +
  "Summarize one saved address report (UTF-8 JSON).\n" +
  "No arguments: read stdin to EOF. One FILE: read only that literal path.\n" +
  "--help: show this help without reading input; use ./--help for that file.\n" +
  "Other paths, including - and --, are literal; quote shell metacharacters.\n" +
  "Print total, successes, failures, and read/decode/format failure counts.\n" +
  "Never open recorded draft paths, rerun formatting, or write files.\n" +
  "Exit 0: valid report (even with failures); 1: unreadable/invalid input;\n" +
  "     2: too many arguments. Full report held in memory; no authenticity check.\n";

function readReport(file) {
  let stage = "read";
  try {
    // Pass raw bytes to the sole validation owner, including for stdin.
    const bytes = readFileSync(file === undefined ? 0 : file);
    stage = "decode";
    return savedBatchReportCodec.decode(bytes);
  } catch (error) {
    const source = file === undefined ? "stdin" : "report " + JSON.stringify(file);
    process.stderr.write(source + " (" + stage + "): " +
      error.name + ": " + error.message + "\n");
    process.exitCode = 1;
    return null;
  }
}

const files = process.argv.slice(2);
if (files.length === 1 && files[0] === "--help") {
  process.stdout.write(help);
} else if (files.length > 1) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  const report = readReport(files[0]);
  if (report) {
    const summary = summarizeReport(report);
    const failures = summary.failureStages;
    // Count occurrences, not unique paths. Never render or change saved strings.
    // Output errors remain native Node errors, not input diagnostics.
    process.stdout.write(
      "Total: " + summary.total + "\n" +
      "Successes: " + summary.succeeded + "\n" +
      "Failures: " + summary.failed + "\n" +
      "Failure stages:\n" +
      "  read: " + failures.read + "\n" +
      "  decode: " + failures.decode + "\n" +
      "  format: " + failures.format + "\n"
    );
    process.exitCode = 0;
  }
}
