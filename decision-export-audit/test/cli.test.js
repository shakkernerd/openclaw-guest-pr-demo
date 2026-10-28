"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { fixture, digest, bytes, baseline } = require("../support/fixtures.js");
const { MAX_BYTES } = require("../lib/common.js");
const cli = resolve(__dirname, "../bin/decision-export-audit.js");

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function report(args, expectedCode = 0, cwd) {
  const result = run(args, cwd);
  assert.equal(result.status, expectedCode, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "decision-export-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const help of ["--help", "-h", "help"]) {
  test("real CLI help " + help, () => {
    const result = run([help]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /<current-file> <incoming-file>/);
    assert.match(result.stdout, /never applies or merges/);
    assert.match(result.stdout, /hashes are not authorization/);
    assert.match(result.stdout, /Revision numbers alone never establish shared history/);
  });
}
for (const args of [[], ["merge", "a", "b"], ["apply", "a"], ["validate"], ["validate", "a", "b"], ["compare", "a"], ["compare", "a", "b", "c"], ["validate", ""], ["validate", "--apply"], ["--help", "extra"], ["compare", "--output", "a"]]) {
  test("real CLI rejects unsupported syntax " + JSON.stringify(args), () => {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Invalid command or arguments/);
  });
}

test("real CLI validates baseline and fingerprints actual bytes, not declared dataset hash", () => {
  const before = bytes();
  const result = report(["validate", fixture]);
  assert.equal(result.valid, true);
  assert.equal(result.decisionCount, 10);
  assert.equal(result.input.bytes, 10874);
  assert.equal(result.input.sha256, digest);
  assert.notEqual(result.input.sha256, result.evidence.datasetSha256);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(bytes(), before);
});

test("real CLI compares the same file twice without mutation or false lineage", () => {
  const before = bytes();
  const result = report(["compare", fixture, fixture]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.summary, { unchanged: 10, changed: 0, added: 0, missing: 0 });
  assert.equal(result.current.input.sha256, digest);
  assert.equal(result.incoming.input.sha256, digest);
  assert.equal(result.sharedHistory, "unproven");
  assert.deepEqual(bytes(), before);
});

test("real CLI emits exact differences and all four classifications, preserving files", t => {
  const dir = temporary(t);
  const current = join(dir, "current export.json");
  const incoming = join(dir, "incoming export.json");
  const value = baseline();
  value.decisions[0].status = "Needs review";
  value.decisions[0].note = " \r\nExact é 🚚 note\t ";
  const old = value.decisions.pop();
  value.decisions.push({ ...old, groupKey: "id:new", orderId: "new" });
  writeFileSync(current, bytes());
  writeFileSync(incoming, JSON.stringify(value));
  const before = [readFileSync(current), readFileSync(incoming)];
  const names = readdirSync(dir).sort();
  const result = report(["compare", current, incoming]);
  assert.deepEqual(result.summary, { unchanged: 8, changed: 1, added: 1, missing: 1 });
  const changed = result.records.find(r => r.classification === "changed");
  assert.equal(changed.changes.find(d => d.path === "/note").incoming, value.decisions[0].note);
  assert.equal(changed.changes.find(d => d.path === "/status").incoming, "Needs review");
  assert.equal(result.current.input.path, current);
  assert.equal(result.incoming.input.path, incoming);
  const reversed = report(["compare", incoming, current]);
  assert.equal(reversed.records.find(r => r.groupKey === "id:new").classification, "missing");
  assert.deepEqual([readFileSync(current), readFileSync(incoming)], before);
  assert.deepEqual(readdirSync(dir).sort(), names);
});

test("real CLI signed zeros produce no false deltas and leave bytes unchanged", t => {
  const dir = temporary(t);
  const current = join(dir, "current.json");
  const incoming = join(dir, "incoming.json");
  const value = baseline();
  value.evidence.csv.bytes = 0;
  value.evidence.report.bytes = 0;
  const currentText = JSON.stringify(value);
  const incomingText = currentText.replace('"revision":0', '"revision":-0')
    .replace('"bytes":0', '"bytes":-0.0').replace('"bytes":0', '"bytes":-0e10');
  writeFileSync(current, currentText);
  writeFileSync(incoming, incomingText);
  for (const paths of [[current, incoming], [incoming, current]]) {
    const result = report(["compare", ...paths]);
    assert.deepEqual(result.summary, { unchanged: 10, changed: 0, added: 0, missing: 0 });
    assert.equal(result.evidenceChanged, false);
    assert.deepEqual(result.evidenceChanges, []);
    assert.ok(result.records.every(record => record.changes.length === 0));
  }
  assert.equal(readFileSync(current, "utf8"), currentText);
  assert.equal(readFileSync(incoming, "utf8"), incomingText);
});

test("real CLI invalid JSON, unknown fields, duplicate records and bad references remain side-located", t => {
  const dir = temporary(t);
  const bad = join(dir, "bad.json");
  const cases = [
    ['{"oops":', "MALFORMED_JSON"],
    ['{"a":1,"a":2}', "DUPLICATE_JSON_MEMBER"],
    [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"],
    [bytes().toString("utf8").replace('"revision":1', '"revision":1.00000000000000000001'), "NUMBER_PRECISION"],
    [JSON.stringify({ ...baseline(), extra: 1 }), "UNKNOWN_FIELD"],
    [JSON.stringify({ ...baseline(), decisions: [...baseline().decisions, baseline().decisions[0]] }), "DUPLICATE_DECISION_IDENTITY"],
  ];
  const broken = baseline();
  broken.decisions[0].sourceEvidence[0].sourcePath = "conflicting.csv";
  cases.push([JSON.stringify(broken), "SOURCE_REFERENCE_MISMATCH"]);
  for (const [content, code] of cases) {
    writeFileSync(bad, content);
    const before = readFileSync(bad);
    const validation = report(["validate", bad], 1);
    assert.equal(validation.valid, false);
    assert.ok(validation.diagnostics.some(d => d.code === code), JSON.stringify(validation));
    for (const side of ["current", "incoming"]) {
      const comparison = report(["compare", ...(side === "current" ? [bad, fixture] : [fixture, bad])], 1);
      assert.equal(comparison.complete, false);
      assert.equal(comparison.summary, null);
      assert.deepEqual(comparison.records, []);
      assert.ok(comparison[side].diagnostics.some(d => d.code === code));
      assert.equal(comparison[side === "current" ? "incoming" : "current"].valid, true);
    }
    assert.deepEqual(readFileSync(bad), before);
    assert.deepEqual(readdirSync(dir), ["bad.json"]);
  }
});

test("real CLI missing and non-regular files return structured I/O failures", t => {
  const dir = temporary(t);
  for (const path of [join(dir, "absent"), dir]) {
    const result = report(["validate", path], 2);
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0].code, "FILE_READ_ERROR");
    assert.equal(result.input.sha256, null);
    const comparison = report(["compare", fixture, path], 2);
    assert.equal(comparison.complete, false);
    assert.equal(comparison.current.valid, true);
    assert.equal(comparison.incoming.diagnostics[0].code, "FILE_READ_ERROR");
  }
});

test("real CLI handles size limits, workspace mismatch, and literal dash-prefixed paths", t => {
  const dir = temporary(t);
  const file = join(dir, "-export");
  writeFileSync(file, bytes());
  assert.equal(report(["validate", "./-export"], 0, dir).valid, true);
  const other = baseline();
  other.workspace = "elsewhere";
  writeFileSync(file, JSON.stringify(other));
  const mismatch = report(["compare", fixture, file], 1);
  assert.equal(mismatch.summary, null);
  assert.equal(mismatch.diagnostics.at(-1).code, "WORKSPACE_MISMATCH");
  writeFileSync(file, Buffer.alloc(MAX_BYTES + 1, 32));
  const before = readFileSync(file);
  const tooLarge = report(["validate", file], 1);
  assert.equal(tooLarge.diagnostics[0].code, "INPUT_TOO_LARGE");
  assert.deepEqual(readFileSync(file), before);
});

test("real CLI unknown vocabulary warns without converting it to a known value", t => {
  const dir = temporary(t);
  const file = join(dir, "new-status.json");
  const value = baseline();
  value.decisions[0].status = "New tracker status";
  writeFileSync(file, JSON.stringify(value));
  const result = report(["compare", fixture, file]);
  assert.equal(result.summary.changed, 1);
  assert.equal(result.incoming.diagnostics[0].severity, "warning");
  assert.equal(result.records.find(r => r.groupKey === "id:MAR-014").incoming.status, "New tracker status");
});
