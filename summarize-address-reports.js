"use strict";

const { readFileSync } = require("node:fs");
const { savedBatchReportCodec } = require("./saved-batch-report.js");
const { summarizeReport, combineSummaries } = require("./saved-batch-summary.js");

const usage = "Usage: node summarize-address-reports.js FILE...\n";
const help = usage + "\n" +
  "Summarize explicitly named saved address reports (UTF-8 JSON).\n" +
  "Read literal paths in argument order, including repeated filenames.\n" +
  "No stdin input, glob expansion, directory discovery, or recursion.\n" +
  "A lone --help shows help; use ./--help for that file. Other arguments\n" +
  "are literal paths, including -, --, and --help among multiple files.\n" +
  "Print one JSON result per file inside a batch document, plus totals over\n" +
  "valid reports only; recorded failures do not make a report invalid.\n" +
  "Never open recorded draft paths, rerun formatting, or write files.\n" +
  "Exit 0: all reports valid; 1: any unreadable/invalid input (continue);\n" +
  "     2: no files. Each full report and all summaries are held in memory.\n" +
  "Acceptance checks structure only, not authenticity or current validity.\n";

function summarizeFile(file, index) {
  let stage = "read";
  let report;
  try {
    const bytes = readFileSync(file);
    stage = "decode";
    report = savedBatchReportCodec.decode(bytes);
  } catch (error) {
    return { position: index + 1, file, ok: false,
      error: { stage, name: error.name, message: error.message } };
  }
  // Counting/runtime failures must not masquerade as bad input. No report
  // contents or occurrence paths are retained in the output summaries.
  return { position: index + 1, file, ok: true, summary: summarizeReport(report) };
}

const files = process.argv.slice(2);
if (files.length === 1 && files[0] === "--help") {
  process.stdout.write(help);
} else if (files.length === 0) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  // Sequential fresh reads: do not sort, deduplicate, discover, or use stdin.
  const results = files.map(summarizeFile);
  const valid = results.filter((result) => result.ok);
  const failed = files.length - valid.length;
  const summary = combineSummaries(valid.map((result) => result.summary));
  // Match the existing batch/validator JSON convention. Input errors are in
  // stdout results; serialization and output-stream failures remain native.
  process.stdout.write(JSON.stringify({
    total: files.length, succeeded: valid.length, failed, results, summary,
  }) + "\n");
  process.exitCode = failed === 0 ? 0 : 1;
}
