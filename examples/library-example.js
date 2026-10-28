"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createBrief, renderBrief } = require("../lib/review-handoff.js");

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--empty")) {
  process.stderr.write("Usage: node examples/library-example.js [--empty]\n");
  process.exitCode = 2;
} else {
  let selectionBytes = readFileSync(join(__dirname, "inputs/review-selection-dispatch-evidence.json"));
  const comparisonBytes = readFileSync(join(__dirname, "inputs/comparison.json"));
  if (args[0] === "--empty") {
    // Deliberately construct a separate empty example in memory. Neither file
    // is changed, and the comparison identity is NOT recomputed or repaired.
    const empty = JSON.parse(selectionBytes);
    empty.selectedCount = 0;
    empty.selectedRecords = [];
    selectionBytes = Buffer.from(JSON.stringify(empty));
  }
  const brief = createBrief(selectionBytes, comparisonBytes);
  // Example library access: only these records are requested for review.
  if (brief.selectedCount !== brief.records.length) throw new Error("unexpected count");
  process.stdout.write(renderBrief(selectionBytes, comparisonBytes, "json"));
}
