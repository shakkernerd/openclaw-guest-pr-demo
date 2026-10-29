"use strict";

// Read-only file adapter: validation and record equality belong to review-state.
const fs = require("node:fs");
const path = require("node:path");
const review = require("./review-state.js");

const usage = `Usage:
  node review-return-analysis.js working.json first.json [second.json ...] --output report.json
  node review-return-analysis.js --help

All inputs must be complete version-1 Record Desk review snapshots.
Analysis only: no reviews applied, winners chosen, or replacement snapshot made.
--output is required and must name a NEW file in an existing directory.
Existing destinations (including links and input aliases) are never overwritten.
Prefix filenames beginning with "-" with "./". Paths may be absolute or relative.
Each invocation rereads all inputs; there is no cross-invocation stale-plan guard.
A write failure may leave a partial new file; writes are not atomic disk commits.`;

function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  if (args.length < 4 || args.at(-2) !== "--output" ||
      [...args.slice(0, -2), args.at(-1)].some(file => !file || file.startsWith("-"))) {
    throw new Error("Expected a working path, at least one returned path, and --output followed by a fresh report path.");
  }

  const inputFiles = args.slice(0, -2);
  const outputFile = args.at(-1);
  // Read every whole file, then validate every complete snapshot before analysis
  // or any output-file effect. Even excluded entries must pass the v1 owner.
  const texts = inputFiles.map(file => {
    try { return fs.readFileSync(file, "utf8"); }
    catch (error) { throw new Error(`Input ${JSON.stringify(file)} could not be read: ${error.message}`); }
  });
  const [working, ...returned] = texts.map((text, index) =>
    review.parseSnapshotJSON(text, `Input ${JSON.stringify(inputFiles[index])}`));
  const proposalsById = new Map();
  const sources = returned.map((snapshot, index) => {
    const ordinal = index + 1;
    const filename = path.basename(inputFiles[ordinal]);
    const { counts, entries } = review.previewReviewUpdates(working, snapshot);
    const conflicts = new Set(entries.filter(entry => entry.kind === "conflict").map(entry => entry.id));
    const issues = [
      ...working.records.filter(record => conflicts.has(record.id)).map(({ id }) => ({ id, kind: "conflict" })),
      ...entries.filter(entry => entry.kind === "unknown").map(({ id }) => ({ id, kind: "unknown" })),
    ];
    for (const { id, kind, after } of entries) {
      if (kind !== "eligible" && kind !== "unchanged") continue;
      if (!proposalsById.has(id)) proposalsById.set(id, []);
      proposalsById.get(id).push({ sourceOrdinal: ordinal, filename,
        decision: after.review.decision, notes: after.review.notes });
    }
    return { ordinal, filename, counts, issues };
  });
  const overlaps = working.records.flatMap(({ id }) => {
    const proposals = proposalsById.get(id);
    if (!proposals || proposals.length < 2) return [];
    const identical = proposals.every(proposal =>
      proposal.decision === proposals[0].decision && proposal.notes === proposals[0].notes);
    return [{ id, status: identical ? "identical" : "disagreement", proposals }];
  });
  const report = { kind: "record-review-return-analysis",
    working: { filename: path.basename(inputFiles[0]), recordCount: working.records.length },
    sources, overlaps };
  const json = JSON.stringify(report, null, 2) + "\n";
  try {
    // Exclusive creation at the write boundary, not a racy existence precheck.
    // Existing inputs, aliases, hard links and even dangling symlinks fail.
    fs.writeFileSync(outputFile, json, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Destination ${JSON.stringify(outputFile)} already exists; not overwritten. Choose a fresh output path.`);
    }
    throw new Error(`Could not finish writing ${JSON.stringify(outputFile)}: ${error.message}. ` +
      "A failed write may leave a partial new file; inspect it before retrying with a fresh path.");
  }
  console.log(`Analyzed ${sources.length} returned snapshot(s); ${overlaps.length} overlapping record(s). ` +
    `No reviews applied. Wrote fresh analysis report: ${JSON.stringify(outputFile)}`);
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error(`Error: ${error.message}

${usage}`);
  process.exitCode = 1;
}
