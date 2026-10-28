"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, existsSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { parseExport, compareExports } = require("../lib");
const { freeze } = require("../support/fixtures.js");

const root = resolve(__dirname, "../..");
const currentPath = "decision-export-audit/test/fixtures/review-decisions-review.json";
const incomingPath = "decision-export-audit/test/fixtures/incoming-review-decisions.json";
const cli = "decision-export-audit/bin/decision-export-audit.js";
const example = "decision-export-audit/examples/colleague-handoff";
const savedPath = example + "/comparison.json";
const summary = { unchanged: 7, changed: 2, added: 0, missing: 1 };
const originalNote = "Request the original dispatch log to confirm whether and when this order was dispatched. Missing timestamps mean the dispatch status is unknown.";
const incomingNote = "Request the original dispatch log and carrier handover receipt. Until both are checked, missing timestamps leave dispatch status unknown.";
const invoiceNote = "Request the individual invoices for each duplicate occurrence before deciding which records need correction; keep all source occurrences visible.";
const bytes = path => readFileSync(resolve(root, path));
function parsed(path) {
  const result = parseExport(bytes(path));
  assert.equal(result.ok, true);
  return freeze(result.value);
}
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

// Original fixtures are only read. Mutation/refusal tests use disposable copies.
function stage(t) {
  const dir = mkdtempSync(join(tmpdir(), "decision-handoff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["lib", "bin"]) {
    cpSync(resolve(root, "decision-export-audit", folder), join(dir, "decision-export-audit", folder), { recursive: true });
  }
  for (const file of [currentPath, incomingPath, example + "/capture.js"]) {
    mkdirSync(resolve(dir, file, ".."), { recursive: true });
    copyFileSync(resolve(root, file), resolve(dir, file));
  }
  return dir;
}

test("both real handoff fixtures retain their original byte lengths and SHA-256", () => {
  for (const [path, length, digest] of [
    [currentPath, 10874, "1d3119bcc05c601dcae42c79cd1e22d0765300d2ce90138b8e4d47483ee7151d"],
    [incomingPath, 13709, "a5b3582c51aede5a77e535783f2caebb8ba26b50c893635c1d351414f5d9bf66"],
  ]) {
    assert.equal(bytes(path).length, length);
    assert.equal(createHash("sha256").update(bytes(path)).digest("hex"), digest);
  }
});

test("real handoff library report preserves exact edits, independent revision and omission semantics", () => {
  const current = parsed(currentPath);
  const incoming = parsed(incomingPath);
  const before = JSON.stringify([current, incoming]);
  const report = compareExports(current, incoming);
  assert.equal(report.complete, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.sharedHistory, "unproven");
  assert.deepEqual(report.summary, summary);
  assert.deepEqual(report.current.diagnostics, []);
  assert.deepEqual(report.incoming.diagnostics, []);
  assert.deepEqual(report.diagnostics, []);
  const record = key => report.records.find(r => r.groupKey === key);
  const mar014 = record("id:MAR-014");
  assert.equal(mar014.classification, "changed");
  assert.equal(mar014.current.status, "Waiting for evidence");
  assert.equal(mar014.incoming.status, "Waiting for evidence");
  assert.equal(mar014.statusChanged, false);
  assert.equal(mar014.noteChanged, true);
  assert.equal(mar014.current.revision, 1);
  assert.equal(mar014.incoming.revision, 1);
  assert.deepEqual(mar014.changes, [
    { path: "/note", current: originalNote, incoming: incomingNote },
    { path: "/updatedAt", current: "2026-10-28T10:55:10.448Z", incoming: "2026-10-28T12:50:00.000Z" },
  ]);
  const duplicate = record("id:MAR-DUP");
  assert.equal(duplicate.classification, "changed");
  assert.deepEqual(duplicate.changes, [
    { path: "/note", current: "", incoming: invoiceNote },
    { path: "/revision", current: 0, incoming: 1 },
    { path: "/status", current: "Needs review", incoming: "Waiting for evidence" },
    { path: "/updatedAt", current: null, incoming: "2026-10-28T12:50:00.000Z" },
  ]);
  assert.deepEqual(duplicate.incoming.sourceEvidence.map(s => s.occurrenceKey), ["original:17", "original:18", "revised:17"]);
  const missing = record("id:MAR-015");
  assert.equal(missing.classification, "missing");
  assert.equal(missing.current.status, "Needs review");
  assert.equal(missing.current.note, "");
  assert.equal(missing.incoming, null);
  assert.equal(missing.noteChanged, null);
  assert.equal(missing.sourceEvidenceIdentityChanged, null);
  assert.deepEqual(missing.changes, []);
  assert.deepEqual(missing.current.sourceEvidence.map(s => s.occurrenceKey), ["original:16", "revised:16"]);
  assert.equal(report.evidenceChanged, false);
  assert.equal(report.sourceEvidenceIdentityChanged, false);
  assert.deepEqual(report.evidenceChanges, []);
  assert.deepEqual(report.current.evidence, report.incoming.evidence);
  assert.notEqual(report.current.evidence, report.incoming.evidence);
  const matched = report.records.filter(r => r.current && r.incoming);
  assert.equal(matched.length, 9);
  assert.equal(matched.reduce((n, r) => n + r.current.sourceEvidence.length, 0), 19);
  for (const r of matched) {
    assert.deepEqual(r.current.sourceEvidence, r.incoming.sourceEvidence);
    assert.deepEqual(r.sourceEvidenceChanges, []);
  }
  assert.equal(JSON.stringify([current, incoming]), before);
});

test("saved handoff output is byte-exact actual CLI stdout and agrees with library output", () => {
  const before = [bytes(currentPath), bytes(incomingPath), bytes(savedPath)];
  const result = run([cli, "compare", currentPath, incomingPath]);
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(result.stdout, before[2]);
  const report = JSON.parse(result.stdout.toString("utf8"));
  assert.deepEqual(report.summary, summary);
  assert.equal(report.current.input.path, currentPath);
  assert.equal(report.incoming.input.path, incomingPath);
  assert.equal(report.current.input.bytes, 10874);
  assert.equal(report.incoming.input.bytes, 13709);
  assert.notEqual(report.current.input.sha256, report.incoming.input.sha256);
  delete report.current.input;
  delete report.incoming.input;
  assert.deepEqual(report, compareExports(parsed(currentPath), parsed(incomingPath)));
  assert.deepEqual([bytes(currentPath), bytes(incomingPath), bytes(savedPath)], before);
});

test("reversing real input roles makes the omitted record added, not deleted", () => {
  const report = compareExports(parsed(incomingPath), parsed(currentPath));
  assert.deepEqual(report.summary, { unchanged: 7, changed: 2, added: 1, missing: 0 });
  const added = report.records.find(r => r.groupKey === "id:MAR-015");
  assert.equal(added.classification, "added");
  assert.equal(added.current, null);
  assert.equal(added.incoming.status, "Needs review");
  assert.equal(report.sharedHistory, "unproven");
});

test("operations review and copy-paste example stay tied to the actual handoff", () => {
  const review = bytes(example + "/REVIEW.md").toString("utf8");
  for (const value of [originalNote, incomingNote, invoiceNote, "Waiting for evidence", "Needs review", ""]) {
    assert.ok(review.includes(JSON.stringify(value)), "Missing exact value: " + value);
  }
  assert.match(review, /7 unchanged, 2 changed, 0 added, 1 missing/);
  assert.match(review, /incoming: null/);
  assert.match(review, /sharedHistory: "unproven"/);
  assert.match(review, /not authorization/);
  const readme = bytes("decision-export-audit/README.md").toString("utf8");
  assert.ok(readme.includes("node " + cli + " compare " + currentPath + " " + incomingPath));
  assert.ok(readme.includes("node " + example + "/capture.js"));
});

test("capture example creates real stdout, is idempotent, and refuses different existing output", t => {
  const dir = stage(t);
  const output = resolve(dir, savedPath);
  const before = [readFileSync(resolve(dir, currentPath)), readFileSync(resolve(dir, incomingPath))];
  let result = run([example + "/capture.js"], dir);
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  assert.equal(JSON.parse(result.stdout.toString("utf8")).capture, "created");
  assert.deepEqual(readFileSync(output), bytes(savedPath));
  const mtime = statSync(output).mtimeMs;
  result = run([example + "/capture.js"], dir);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout.toString("utf8")).capture, "already identical");
  assert.equal(statSync(output).mtimeMs, mtime);
  writeFileSync(output, "different report: do not overwrite\n");
  result = run([example + "/capture.js"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString("utf8"), /refusing to overwrite/);
  assert.ok(result.stderr.length < 1024, "Refusal must not dump full report contents or an expensive byte diff");
  assert.equal(readFileSync(output, "utf8"), "different report: do not overwrite\n");
  assert.deepEqual([readFileSync(resolve(dir, currentPath)), readFileSync(resolve(dir, incomingPath))], before);
});

test("capture example refuses arguments or modified fixture bytes without creating a report", t => {
  const dir = stage(t);
  const output = resolve(dir, savedPath);
  let result = run([example + "/capture.js", currentPath], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString("utf8"), /takes no arguments/);
  assert.equal(existsSync(output), false);
  const incoming = resolve(dir, incomingPath);
  writeFileSync(incoming, Buffer.concat([readFileSync(incoming), Buffer.from("\n")]));
  const before = readFileSync(incoming);
  result = run([example + "/capture.js"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString("utf8"), /fixture byte length differs/);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readFileSync(incoming), before);
});
