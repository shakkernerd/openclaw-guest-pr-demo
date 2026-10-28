#!/usr/bin/env node
"use strict";

const { auditFiles } = require("./index.js");

const HELP = `Usage: node parcel-event-audit/cli.js [--exceptions-only] [--] FILE.jsonl [FILE.jsonl ...]

Reconcile read-only parcel event exports; emit one JSON report to stdout.
--exceptions-only retains affected parcels with complete timelines and sources;
global totals and all exception evidence are unchanged. The report is labeled.
Use -- before filenames beginning with '-'. No stdin or output-file option.

Exit statuses: 0 = no exceptions (or help); 1 = audit exceptions;
               2 = invalid input, usage, or I/O failure.
`;

async function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const filenames = [];
  let literal = false;
  let exceptionsOnly = false;
  for (const arg of args) {
    if (!literal && arg === "--") { literal = true; continue; }
    if (!literal && arg === "--exceptions-only") { exceptionsOnly = true; continue; }
    if (!literal && arg.startsWith("-")) throw new Error(`unknown option ${JSON.stringify(arg)}; use --help`);
    filenames.push(arg);
  }
  if (!filenames.length) throw new Error("provide at least one export; use --help");
  const report = await auditFiles(filenames, { exceptionsOnly });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.summary.exceptions ? 1 : 0;
}

if (require.main === module) {
  // stderr may share stdout's closed pipe (2>&1). Never recursively report a
  // diagnostic failure, and make exit 2 sticky BEFORE trying to write it.
  process.stderr.on("error", () => { process.exitCode = 2; });
  function reportError(message) {
    process.exitCode = 2;
    try {
      process.stderr.write(`parcel-event-audit: ${message}\n`);
    } catch {
      // Best effort only: the diagnostic destination may also be unavailable.
    }
  }
  process.stdout.on("error", error => {
    reportError(`stdout: ${error.code || error.message}`);
  });
  main(process.argv.slice(2)).then(code => {
    if (process.exitCode !== 2) process.exitCode = code;
  }).catch(error => {
    reportError(error.message);
  });
}
