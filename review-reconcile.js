"use strict";

// Read-only file/stdin/stdout adapter. All reconciliation policy is in the owner.
const fs = require("node:fs");
const review = require("./review-state.js");

const usage = `Usage:
  node review-reconcile.js baseline.json current.json returned.json
  node review-reconcile.js baseline.json current.json -
  node review-reconcile.js --help

Read-only three-way JSON plan; no apply mode or output-file option.
All three inputs must be complete version-1 Record Desk review snapshots.
Use - for at most one input to read UTF-8 stdin through EOF.
Prefix filenames beginning with "-" with "./"; absolute paths are also accepted.
Only returned-only review changes are proposed; current-only changes are kept.
Identical concurrent reviews converge; differing concurrent reviews conflict.
Changed source records on either side conflict, even if both sides match.
Unknown/missing IDs stay visible. Returned order comes first, then unreturned
current IDs in current order, then remaining baseline IDs in baseline order.
This plan infers no chronology, real reviewer identity or human approval.
Values are parsed JavaScript values, not original number spelling or arbitrary
precision. Finite numbers and negative zero are preserved after parsing.
A non-finite number retained in the plan (such as parsed 1e400) is refused
before any stdout. JSON parsing may already round or underflow finite numbers.
Success/help exit 0; usage/read/validation/serialization/stdout errors exit 1.
Stdout delivery failure may leave partial output. Check status and full output.
Inputs are only read. Never redirect stdout onto an input: the shell may
truncate it before this command starts. Keep any report private and separate.`;

function readSnapshot(file, role) {
  const label = role + (file === "-" ? " (stdin)" : " " + JSON.stringify(file));
  let text;
  try { text = fs.readFileSync(file === "-" ? 0 : file, "utf8"); }
  catch (error) { throw new Error(`${label} could not be read: ${error.message}`); }
  try { return review.parseSnapshotJSON(text, role); }
  catch (error) { throw new Error(`${label}: ${error.message}`); }
}

function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    fs.writeFileSync(1, usage + "\n", "utf8");
    return;
  }
  if (args.length !== 3 || args.some(file => !file || (file.startsWith("-") && file !== "-"))) {
    throw new Error("Expected baseline, current and returned inputs only; no apply or output option.");
  }
  if (args.filter(file => file === "-").length > 1) {
    throw new Error("Use - for only one input; stdin cannot supply multiple snapshots.");
  }
  const snapshots = args.map((file, index) => readSnapshot(file, ["Baseline review", "Current review", "Returned review"][index]));
  const plan = review.planReviewReconciliation(...snapshots);
  // Native JSON numbers retain negative zero as well as ordinary zero. IDs
  // remain strings; no display formatting or coercion enters the plan values.
  const json = JSON.stringify(plan, (key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Cannot serialize plan: non-finite number after JSON parsing. No plan was written.");
    }
    return Object.is(value, -0) ? JSON.rawJSON("-0") : value;
  }, 2) + "\n";
  try { fs.writeFileSync(1, json, "utf8"); }
  catch (error) { throw new Error(`Could not write plan to stdout: ${error.message}`); }
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error(`Error: ${error.message}\n\n${usage}`);
  process.exitCode = 1;
}
