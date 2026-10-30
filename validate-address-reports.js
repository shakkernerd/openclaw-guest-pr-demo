"use strict";

const { readFileSync } = require("node:fs");
const { savedBatchReportCodec } = require("./saved-batch-report.js");

const files = process.argv.slice(2);
const results = [];
let valid = 0;

for (const [index, file] of files.entries()) {
  let stage = "read";
  try {
    const bytes = readFileSync(file);
    stage = "decode";
    const report = savedBatchReportCodec.decode(bytes);
    results.push({
      position: index + 1, file, ok: true,
      total: report.total, succeeded: report.succeeded, failed: report.failed,
    });
    valid += 1;
  } catch (error) {
    results.push({
      position: index + 1, file, ok: false,
      error: { stage, name: error.name, message: error.message },
    });
  }
}

const summary = { total: files.length, valid, invalid: files.length - valid, results };
process.stdout.write(JSON.stringify(summary) + "\n");
process.exitCode = files.length === 0 ? 2 : summary.invalid === 0 ? 0 : 1;
