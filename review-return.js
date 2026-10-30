"use strict";

// File/terminal adapter only. The shared state owner defines every review rule.
const fs = require("node:fs");
const review = require("./review-state.js");

const usage = `Usage:
  node review-return.js working.json returned.json
  node review-return.js working.json returned.json --plan
  node review-return.js working.json - --plan
  node review-return.js working.json returned.json --apply result.json
  node review-return.js --help

Both inputs must be complete version-1 Record Desk review snapshots.
Default: read-only counts. --plan emits the complete read-only preview as JSON.
For counts/--plan, use - for exactly one input to read UTF-8 stdin through EOF.
--plan cannot be combined with --apply; it never applies or writes a file.
--plan stdout write failures exit 1 with a diagnostic; output may be partial.
--apply writes a full review to one NEW file and requires two input file paths.
Existing destinations (including links and either input) are never overwritten.
Prefix filenames beginning with "-" with "./". Paths may be absolute or relative.
Each invocation rereads the inputs; no preview plan is saved between commands.
A write failure may leave a partial new file; writes are not atomic disk commits.`;

function inputLabel(file, label) {
  return label + (file === "-" ? " (stdin)" : " " + JSON.stringify(file));
}

function readSnapshotText(file, label) {
  try { return fs.readFileSync(file === "-" ? 0 : file, "utf8"); }
  catch (error) { throw new Error(`${inputLabel(file, label)} could not be read: ${error.message}`); }
}

function parseSnapshot(text, file, label) {
  try { return review.parseSnapshotJSON(text, label); }
  catch (error) { throw new Error(`${inputLabel(file, label)}: ${error.message}`); }
}

function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  const plan = args.length === 3 && args[2] === "--plan";
  const apply = args.length === 4 && args[2] === "--apply";
  if (!(args.length === 2 || plan || apply) ||
      args.slice(0, 2).some(file => !file || (file.startsWith("-") && file !== "-")) ||
      (apply && (!args[3] || args[3].startsWith("-")))) {
    throw new Error("Expected two inputs, optionally --plan OR --apply followed by a fresh output path.");
  }
  if (args[0] === "-" && args[1] === "-") {
    throw new Error("Use - for only one input; stdin cannot supply two snapshots.");
  }
  if (apply && args.slice(0, 2).includes("-")) {
    throw new Error("--apply requires two input file paths; stdin is read-only (counts or --plan).");
  }

  const [workingFile, returnedFile, , outputFile] = args;
  // Read both complete inputs and validate both snapshots before any output effect.
  const workingText = readSnapshotText(workingFile, "Working review");
  const returnedText = readSnapshotText(returnedFile, "Returned review");
  const current = parseSnapshot(workingText, workingFile, "Working review");
  const incoming = parseSnapshot(returnedText, returnedFile, "Returned review");
  const preview = review.previewReviewUpdates(current, incoming);
  if (plan) {
    // Serialize the existing owner contract verbatim, not a replacement state.
    // Return before the legacy apply/export/write path, even for eligible rows.
    const json = JSON.stringify(preview, null, 2) + "\n";
    // Console logging may swallow write errors. Check delivery to fd 1 directly.
    try { fs.writeFileSync(1, json, "utf8"); }
    catch (error) { throw new Error(`Could not write plan to stdout: ${error.message}`); }
    return;
  }
  const { counts } = preview;
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
