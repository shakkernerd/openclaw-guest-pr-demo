"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { savedBatchReportCodec } = require("./saved-batch-report.js");
const { summarizeReport, combineSummaries } = require("./saved-batch-summary.js");

test("counting uses accepted totals and failed occurrences without editing accepted data", () => {
  const report = savedBatchReportCodec.decode(readFileSync(join(__dirname, "saved-batch-report-fixtures/mixed-report.json")));
  const before = JSON.stringify(report);
  assert.deepEqual(summarizeReport(report), {
    total: 6, succeeded: 2, failed: 4, failureStages: { read: 1, decode: 1, format: 2 },
  });
  assert.equal(JSON.stringify(report), before);
  const summary = summarizeReport(report);
  summary.failureStages.read = 99;
  assert.equal(summarizeReport(report).failureStages.read, 1);
});

test("combining counts repeated summaries, has a zero identity, and does not mutate inputs", () => {
  const summary = Object.freeze({ total: 6, succeeded: 2, failed: 4,
    failureStages: Object.freeze({ read: 1, decode: 1, format: 2 }) });
  assert.deepEqual(combineSummaries([summary, summary]), {
    total: 12, succeeded: 4, failed: 8, failureStages: { read: 2, decode: 2, format: 4 },
  });
  const empty = { total: 0, succeeded: 0, failed: 0, failureStages: { read: 0, decode: 0, format: 0 } };
  assert.deepEqual(combineSummaries([]), empty);
  assert.deepEqual(combineSummaries([empty, summary]), summary);
  const combined = combineSummaries([summary]);
  combined.failureStages.read = 99;
  assert.equal(summary.failureStages.read, 1);
});
