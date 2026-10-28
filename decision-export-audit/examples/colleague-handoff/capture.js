"use strict";

// This example saves a report, never an input. The audit library/CLI remain read-only.
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");

const root = resolve(__dirname, "../../..");
const inputs = [
  { path: "decision-export-audit/test/fixtures/review-decisions-review.json", bytes: 10874,
    sha256: "1d3119bcc05c601dcae42c79cd1e22d0765300d2ce90138b8e4d47483ee7151d" },
  { path: "decision-export-audit/test/fixtures/incoming-review-decisions.json", bytes: 13709,
    sha256: "a5b3582c51aede5a77e535783f2caebb8ba26b50c893635c1d351414f5d9bf66" },
];

function capture() {
  assert.equal(process.argv.length, 2, "This fixed example takes no arguments and cannot select an input as an output.");
  const before = inputs.map(input => {
    const bytes = readFileSync(resolve(root, input.path));
    assert.equal(bytes.length, input.bytes, input.path + ": fixture byte length differs");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), input.sha256, input.path + ": fixture digest differs");
    return bytes;
  });
  const result = spawnSync(process.execPath, [
    "decision-export-audit/bin/decision-export-audit.js", "compare", ...inputs.map(input => input.path),
  ], { cwd: root, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  // Check preservation even if the child failed. Never normalize or rewrite an input.
  inputs.forEach((input, index) => assert.ok(readFileSync(resolve(root, input.path)).equals(before[index]), input.path + ": bytes changed"));
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  assert.equal(result.stderr.length, 0, "Unexpected CLI stderr");
  const report = JSON.parse(result.stdout.toString("utf8"));
  assert.equal(report.complete, true, "Refusing to capture an incomplete example");
  const destination = resolve(__dirname, "comparison.json");
  let existing;
  try { existing = readFileSync(destination); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined) {
    // Compare bytes without constructing an enormous assertion diff on refusal.
    assert.ok(existing.equals(result.stdout), "Existing comparison.json differs; refusing to overwrite it. Inspect the difference separately.");
  } else {
    // wx also refuses a raced-in file or symlink. No redirection can truncate inputs.
    writeFileSync(destination, result.stdout, { flag: "wx" });
  }
  assert.ok(readFileSync(destination).equals(result.stdout), "Saved report differs from actual CLI stdout.");
  console.log(JSON.stringify({
    output: "decision-export-audit/examples/colleague-handoff/comparison.json",
    cliExitCode: result.status, stderrBytes: result.stderr.length, stdoutBytes: result.stdout.length,
    summary: report.summary, evidenceChanged: report.evidenceChanged,
    sourceEvidenceIdentityChanged: report.sourceEvidenceIdentityChanged,
    sharedHistory: report.sharedHistory, inputsUnchanged: true,
    capture: existing === undefined ? "created" : "already identical",
  }, null, 2));
}

try { capture(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
