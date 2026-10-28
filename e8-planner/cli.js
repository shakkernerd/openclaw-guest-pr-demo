#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, TextDecoder } = require("node:util");
const { readVolunteers, readShifts } = require("./input.js");
const { allocate, assignmentsCsv, report } = require("./planner.js");

const HELP = [
  "Usage: node e8-planner/cli.js [options]",
  "",
  "  --volunteers FILE  Volunteer CSV (default: ./volunteers.csv)",
  "  --shifts FILE      Shift CSV (default: ./shifts.csv)",
  "  --out-dir DIR      Output directory (default: ./planner-output)",
  "  --require-full     Exit 2 if any person-slots are uncovered; still write outputs",
  "  -h, --help         Show this help",
  "",
  "Writes assignments.csv and report.txt, and prints the report to stdout.",
  "Existing output files are never overwritten. Use a new directory or move old outputs.",
  "Exit codes: 0 = valid plan; 1 = input/usage/I/O error; 2 = --require-full with gaps.",
].join("\n") + "\n";

function readUtf8(file) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch (error) {
    throw new Error(file + ": " + error.message);
  }
}

// Reserve both names exclusively before writing either. Never follow an output
// symlink, clobber an input, or overwrite an earlier plan. Roll back our own new
// files on a normal I/O failure (not a cross-file transaction on power loss).
// The output directory must be trusted; do not replace paths concurrently.
function writeOutputs(directory, csv, text) {
  fs.mkdirSync(directory, { recursive: true });
  const files = [];
  try {
    for (const [name, content] of [["assignments.csv", csv], ["report.txt", text]]) {
      const file = path.join(directory, name);
      const fd = fs.openSync(file, "wx", 0o600);
      files.push({ file, fd, content });
    }
    for (const entry of files) fs.writeFileSync(entry.fd, entry.content, "utf8");
  } catch (error) {
    const cleanupErrors = [];
    for (const entry of files) {
      try { fs.closeSync(entry.fd); entry.fd = null; } catch (e) { cleanupErrors.push(e.message); }
      try { fs.unlinkSync(entry.file); } catch (e) { cleanupErrors.push(e.message); }
    }
    throw new Error(error.message + (cleanupErrors.length ? "; cleanup failed: " + cleanupErrors.join("; ") : ""));
  } finally {
    for (const entry of files) if (entry.fd !== null) fs.closeSync(entry.fd);
  }
}

function main(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
      volunteers: { type: "string", default: "volunteers.csv" },
      shifts: { type: "string", default: "shifts.csv" },
      "out-dir": { type: "string", default: "planner-output" },
      "require-full": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    } });
    if (values.help) { process.stdout.write(HELP); return 0; }
    for (const key of ["volunteers", "shifts", "out-dir"]) {
      if (!values[key].trim()) throw new Error("--" + key + " must not be empty");
    }
    // Validate both complete inputs before touching any output paths.
    const volunteers = readVolunteers(readUtf8(values.volunteers), values.volunteers);
    const shifts = readShifts(readUtf8(values.shifts), values.shifts);
    const plan = allocate(volunteers, shifts);
    const text = report(plan);
    writeOutputs(values["out-dir"], assignmentsCsv(plan), text);
    process.stdout.write(text);
    return values["require-full"] && plan.uncovered ? 2 : 0;
  } catch (error) {
    process.stderr.write("Planner error: " + error.message + "\nRun with --help for usage.\n");
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
