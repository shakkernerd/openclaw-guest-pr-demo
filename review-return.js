"use strict";

// File/terminal adapter only. The shared state owner defines every review rule.
const fs = require("node:fs");
const review = require("./review-state.js");

const usage = `Usage:
  node review-return.js working.json returned.json
  node review-return.js working.json returned.json --apply result.json
  node review-return.js --help

Both inputs must be complete version-1 Record Desk review snapshots.
Default: read-only preview. --apply writes a full review to one NEW file.
Existing destinations (including links and either input) are never overwritten.
Prefix filenames beginning with "-" with "./". Paths may be absolute or relative.
Each invocation rereads the inputs; no preview plan is saved between commands.
A write failure may leave a partial new file; writes are not atomic disk commits.`;

function readSnapshotText(file, label) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { throw new Error(`${label} ${JSON.stringify(file)} could not be read: ${error.message}`); }
}

function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  if (!(args.length === 2 || (args.length === 4 && args[2] === "--apply")) ||
      [args[0], args[1], ...(args.length === 4 ? [args[3]] : [])]
        .some(file => !file || file.startsWith("-"))) {
    throw new Error("Expected two input paths and optionally --apply followed by a fresh output path.");
  }

  const [workingFile, returnedFile, , outputFile] = args;
  // Read both whole files and validate both snapshots before any output effect.
  const workingText = readSnapshotText(workingFile, "Working review");
  const returnedText = readSnapshotText(returnedFile, "Returned review");
  const current = review.parseSnapshotJSON(workingText, "Working review");
  const incoming = review.parseSnapshotJSON(returnedText, "Returned review");
  const { counts } = review.previewReviewUpdates(current, incoming);
  const summary = `Eligible: ${counts.eligible} | Unchanged: ${counts.unchanged} | ` +
    `Changed-record conflicts: ${counts.conflict} | Unknown IDs: ${counts.unknown}`;
  if (!outputFile) {
    console.log(summary + "\nRead-only preview. No files written.");
    return;
  }

  // This invocation owns one current immutable state, not a prior CLI preview.
  const applied = review.applyReviewUpdates(current, incoming, current);
  const json = review.exportJSON(applied.state);
  try {
    // No existence precheck: exclusive creation also rejects symlinks/hard links
    // and path aliases of either input or any other existing destination.
    fs.writeFileSync(outputFile, json, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Destination ${JSON.stringify(outputFile)} already exists; not overwritten. Choose a fresh output path.`);
    }
    throw new Error(`Could not finish writing ${JSON.stringify(outputFile)}: ${error.message}. ` +
      "A failed write may leave a partial new file; inspect it before retrying with a fresh path.");
  }
  console.log(summary + `\nApplied ${applied.changed} review update(s). Wrote fresh output: ${JSON.stringify(outputFile)}`);
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error(`Error: ${error.message}\n\n${usage}`);
  process.exitCode = 1;
}
