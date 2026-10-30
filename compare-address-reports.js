"use strict";

const { readFileSync } = require("node:fs");
const { savedBatchReportCodec } = require("./saved-batch-report.js");
const { compare } = require("./saved-batch-comparison.js");

function readReport(side, file) {
  let stage = "read";
  try {
    const bytes = readFileSync(file);
    stage = "decode";
    return savedBatchReportCodec.decode(bytes);
  } catch (error) {
    process.stderr.write(side + " report " + JSON.stringify(file) + " (" + stage + "): " +
      error.name + ": " + error.message + "\n");
    process.exitCode = 1;
    return null;
  }
}

const files = process.argv.slice(2);
if (files.length !== 2) {
  process.stderr.write("Usage: node compare-address-reports.js ORIGINAL RERUN\n");
  process.exitCode = 2;
} else {
  // Finish original read/decode before touching rerun; stop at the first failure.
  const original = readReport("original", files[0]);
  if (original) {
    const rerun = readReport("rerun", files[1]);
    if (rerun) {
      process.stdout.write(JSON.stringify(compare(original, rerun)) + "\n");
      process.exitCode = 0;
    }
  }
}
