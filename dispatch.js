#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { isUtf8 } = require("node:buffer");
const { planDispatch, formatReport } = require("./dispatch-planner.js");

const USAGE = [
  "Usage: node dispatch.js [--json] <batch.json|->",
  "       node dispatch.js --help",
  "",
  "Plan deliveries using the available couriers in a JSON batch.",
  "  --json      Print the complete plan as JSON instead of a readable report.",
  "  -           Read the batch from standard input.",
  "  --          End options (for file names beginning with a dash).",
  "  -h, --help  Show this help.",
  "",
  "Capacity counts delivery stops. Urgent jobs go first; IDs break ties.",
  "A valid plan exits 0 even with unassigned work; invalid input exits 1.",
  "See README.md and examples/morning-dispatch.json for the input schema.",
].join("\n");

function parseArguments(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { help: true };
  }
  let json = false;
  let options = true;
  let file;
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
    } else if (options && arg === "--json") {
      if (json) throw new Error("--json may only be specified once");
      json = true;
    } else if (options && arg.startsWith("-") && arg !== "-") {
      throw new Error("unknown option " + JSON.stringify(arg) + " (use --help for usage)");
    } else {
      if (file !== undefined) throw new Error("expected exactly one input file (or - for stdin)");
      file = arg;
    }
  }
  if (file === undefined || file === "") {
    throw new Error("an input file is required (or - for stdin; use --help for usage)");
  }
  return { file, json };
}

// JSON.parse validates syntax but silently keeps only the last duplicate key.
// Scan valid JSON tokens to reject duplicates, including escaped key spellings.
function parseBatch(source) {
  const batch = JSON.parse(source);
  const tokens = /"(?:\\.|[^"\\])*"(\s*:)?|[{}\[\]]/g;
  const objects = [];
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else if (match[1]) {
      const key = JSON.parse(token.slice(0, -match[1].length));
      const keys = objects.at(-1);
      if (keys.has(key)) throw new Error("duplicate object key " + JSON.stringify(key));
      keys.add(key);
    }
  }
  return batch;
}

function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(USAGE + "\n");
      return;
    }
    let source;
    try {
      source = readFileSync(args.file === "-" ? 0 : args.file);
    } catch (error) {
      throw new Error("cannot read " + JSON.stringify(args.file) + ": " + error.message);
    }
    if (!isUtf8(source)) {
      throw new Error("invalid UTF-8 in " + JSON.stringify(args.file) + ": input must be UTF-8 encoded");
    }
    let batch;
    try {
      batch = parseBatch(source.toString("utf8"));
    } catch (error) {
      throw new Error("invalid JSON in " + JSON.stringify(args.file) + ": " + error.message);
    }
    const plan = planDispatch(batch);
    process.stdout.write((args.json ? JSON.stringify(plan, null, 2) : formatReport(plan)) + "\n");
  } catch (error) {
    process.stderr.write("Error: " + error.message + "\n");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
