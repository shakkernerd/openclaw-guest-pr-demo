#!/usr/bin/env node
"use strict";

const { auditFiles } = require("./index.js");

const HELP = `Usage: node courier-csv-intake/cli.js [--exceptions-only] [--] FILE.csv [FILE.csv ...]

Read-only CSV intake; emit one JSON audit with lossless CSV evidence.
Required exact headers: eventId,parcelId,type,occurredAt (any column order).
Extra columns are retained as evidence, not added to event identity.
--exceptions-only filters audit parcels, never input validation or evidence.
Use -- before filenames beginning with '-'. No stdin or output-file option.

Exit: 0 = no audit exceptions (or help); 1 = audit exceptions;
      2 = invalid input, usage, or I/O failure.
`;

async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(HELP);
    return 0;
  }
  const filenames = [];
  let literal = false, exceptionsOnly = false;
  for (const arg of args) {
    if (!literal && arg === "--") { literal = true; continue; }
    if (!literal && arg === "--exceptions-only") { exceptionsOnly = true; continue; }
    if (!literal && arg.startsWith("-")) throw new Error(`unknown option ${JSON.stringify(arg)}; use --help`);
    filenames.push(arg);
  }
  if (!filenames.length) throw new Error("provide at least one CSV export; use --help");
  const report = await auditFiles(filenames, { exceptionsOnly });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.audit.summary.exceptions ? 1 : 0;
}

if (require.main === module) {
  // stdout and stderr can share a closed pipe. Keep failure status sticky and
  // never recursively diagnose a stderr failure. No partial input-success JSON.
  process.stderr.on("error", () => { process.exitCode = 2; });
  function reportError(message) {
    process.exitCode = 2;
    try { process.stderr.write(`courier-csv-intake: ${message}\n`); } catch { /* best effort */ }
  }
  process.stdout.on("error", error => reportError(`stdout: ${error.code || error.message}`));
  main(process.argv.slice(2)).then(code => {
    if (process.exitCode !== 2) process.exitCode = code;
  }).catch(error => reportError(error.message));
}
