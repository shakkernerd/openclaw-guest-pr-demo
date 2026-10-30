"use strict";

const { readFileSync } = require("node:fs");
const { savedBatchReportCodec } = require("./saved-batch-report.js");

const files = process.argv.slice(2);

if (files.length !== 1) {
  process.stderr.write("Usage: node validate-address-report.js FILE\n");
  process.exitCode = 2;
} else {
  const file = files[0];
  let stage = "read";
  let verdict;
  try {
    const bytes = readFileSync(file);
    stage = "decode";
    const report = savedBatchReportCodec.decode(bytes);
    verdict = { file, ok: true, total: report.total, succeeded: report.succeeded, failed: report.failed };
  } catch (error) {
    verdict = { file, ok: false, error: { stage, name: error.name, message: error.message } };
  }
  process.stdout.write(JSON.stringify(verdict) + "\n");
  process.exitCode = verdict.ok ? 0 : 1;
}
