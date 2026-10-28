#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { parcelLabels } = require("./d1-20261028-g3-parcel-batch.js");

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`Usage: node d1-20261028-g3-labels-cli.js [--help|-h] [input.json]

Read a JSON array of nonnegative safe integers from a file or stdin.
Omit input.json to read stdin; a filename takes precedence over stdin.
Write one label per line; [] writes nothing. Invalid input exits 1.

  -h, --help  Show this help and exit 0 without reading any input.

Saved file: node d1-20261028-g3-labels-cli.js counts.json

Example:
node d1-20261028-g3-labels-cli.js <<'JSON'
[0,1,3]
JSON
`);
    return;
  }

  if (args.length > 1) {
    process.stderr.write("labels: expected at most one input filename; use --help for usage\n");
    process.exitCode = 1;
    return;
  }

  const filename = args[0];
  let input;
  try {
    input = readFileSync(filename === undefined ? 0 : filename, "utf8");
  } catch (error) {
    const reasons = {
      ENOENT: "file not found",
      EACCES: "permission denied",
      EPERM: "permission denied",
      EISDIR: "path is a directory",
      ENOTDIR: "a path component is not a directory",
    };
    const source = filename === undefined ? "stdin" : `input file ${JSON.stringify(filename)}`;
    const reason = reasons[error.code] || error.code || error.message;
    process.stderr.write(`labels: cannot read ${source}: ${reason}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const counts = JSON.parse(input);
    const labels = parcelLabels(counts);

    // Validate the entire batch before writing anything to stdout.
    if (labels.length > 0) {
      process.stdout.write(`${labels.join("\n")}\n`);
    }
  } catch (error) {
    const message = error instanceof SyntaxError
      ? "invalid JSON; expected an array of nonnegative safe integers"
      : error.message;
    process.stderr.write(`labels: ${message}\n`);
    process.exitCode = 1;
  }
}

main();
