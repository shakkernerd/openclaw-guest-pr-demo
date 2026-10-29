"use strict";

const { readFileSync } = require("node:fs");
const { preparePackingBatch } = require("./packing-batch.js");

function fail(message) {
  process.exitCode = 1;
  process.stderr.write("packing-batch: " + message + "\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    fail("usage: node packing-batch-cli.js [input.json|-]");
    return;
  }

  const source = args.length === 0 || args[0] === "-" ? 0 : args[0];
  let bytes;
  try {
    bytes = readFileSync(source);
  } catch (error) {
    fail("cannot read " + (source === 0 ? "stdin" : JSON.stringify(source)) + ": " + (error.code || error.message));
    return;
  }

  let records;
  try {
    // Reject invalid UTF-8 rather than silently replacing identifier bytes.
    const input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    records = JSON.parse(input);
  } catch (error) {
    fail("malformed JSON input (expected UTF-8): " + error.message);
    return;
  }

  let output;
  try {
    output = JSON.stringify(preparePackingBatch(records), null, 2) + "\n";
  } catch (error) {
    fail("invalid batch: " + error.message);
    return;
  }

  // Validation and serialization finish first. A stream failure may still leave
  // partial output; report failure and let Node drain the diagnostic naturally.
  process.stdout.on("error", (error) => {
    fail("cannot write stdout: " + (error.code || error.message));
  });
  process.stdout.write(output);
}

main();
