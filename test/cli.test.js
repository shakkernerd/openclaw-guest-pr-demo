"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { renderBrief } = require("../lib/review-handoff.js");
const root = path.join(__dirname, "..");
const cli = path.join(root, "bin/review-handoff.js");
const selectionPath = path.join(root, "examples/inputs/review-selection-dispatch-evidence.json");
const comparisonPath = path.join(root, "examples/inputs/comparison.json");
const s = fs.readFileSync(selectionPath);
const r = fs.readFileSync(comparisonPath);
const base = ["--selection", selectionPath, "--comparison", comparisonPath];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function run(args) { return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }); }
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-brief-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function failure(result, status, code) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(code));
  assert.equal(result.stderr.trim().split("\n").length, 1);
}

test("real CLI: Markdown default and JSON match library; source bytes unchanged", () => {
  for (const format of ["markdown", "json"]) {
    const result = run(format === "markdown" ? base : [...base, "--format", format]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, renderBrief(s, r, format));
    if (format === "json") {
      const brief = JSON.parse(result.stdout);
      assert.equal(brief.records[1].reportRecord.incoming, null);
      assert.equal(brief.records[1].incomingPresent, false);
    }
  }
  assert.deepEqual(fs.readFileSync(selectionPath), s);
  assert.deepEqual(fs.readFileSync(comparisonPath), r);
});

test("CLI generates a new file, refuses input paths/existing files/symlinks/hardlinks", t => {
  const dir = temp(t);
  const out = path.join(dir, "brief.md");
  const result = run([...base, "--output", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(fs.readFileSync(out, "utf8"), renderBrief(s, r));
  const link = path.join(dir, "linked.json");
  const hard = path.join(dir, "hard.json");
  const copy = path.join(dir, "source.json");
  fs.writeFileSync(copy, r);
  fs.symlinkSync(comparisonPath, link);
  fs.linkSync(copy, hard);
  const dangling = path.join(dir, "dangling");
  fs.symlinkSync(path.join(dir, "nonexistent"), dangling);
  for (const dest of [out, selectionPath, comparisonPath, link, hard, dangling]) failure(run([...base, "--output", dest]), 1, "OUTPUT_WRITE");
  assert.deepEqual(fs.readFileSync(copy), r);
  assert.deepEqual(fs.readFileSync(selectionPath), s);
  assert.deepEqual(fs.readFileSync(comparisonPath), r);
  assert.equal(fs.readFileSync(out, "utf8"), renderBrief(s, r));
  assert.equal(fs.existsSync(path.join(dir, "nonexistent")), false);
});

test("CLI stale comparison and selection mismatch fail with no output creation", t => {
  const dir = temp(t);
  const badReport = path.join(dir, "stale.json");
  const badSelection = path.join(dir, "wrong.json");
  const out = path.join(dir, "must-not-exist.md");
  fs.writeFileSync(badReport, Buffer.concat([r, Buffer.from("\n")]));
  failure(run(["--selection", selectionPath, "--comparison", badReport, "--output", out]), 1, "COMPARISON_IDENTITY");
  const changed = JSON.parse(s); changed.selectedRecords[0].groupKey = "wrong";
  fs.writeFileSync(badSelection, JSON.stringify(changed));
  failure(run(["--selection", badSelection, "--comparison", comparisonPath, "--output", out]), 1, "SELECTION_MISMATCH");
  assert.equal(fs.existsSync(out), false);
});

test("CLI empty selection succeeds honestly in Markdown and JSON", t => {
  const dir = temp(t); const empty = JSON.parse(s);
  empty.selectedRecords = []; empty.selectedCount = 0;
  const emptyPath = path.join(dir, "empty.json"); fs.writeFileSync(emptyPath, JSON.stringify(empty));
  for (const format of ["json", "markdown"]) {
    const result = run(["--selection", emptyPath, "--comparison", comparisonPath, "--format", format]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No records selected for review/);
    assert.match(result.stdout, /Dispatch evidence follow-up/);
    assert.match(result.stdout, new RegExp(hash(r)));
    if (format === "json") assert.deepEqual(JSON.parse(result.stdout).records, []);
  }
});

test("CLI flags/help/read failures are clear and never produce partial briefs", t => {
  const dir = temp(t);
  for (const args of [[], ["--selection"], ["--bogus", "x"], [...base, "--selection", selectionPath],
    [...base, "--format", "xml"], [...base, "--format"], [...base, "--output", "--format"],
    ["--help", "--bogus"], [...base, "extra"]]) failure(run(args), 2, "USAGE");
  const help = run(["--help"]);
  assert.equal(help.status, 0); assert.match(help.stdout, /Usage:/); assert.equal(help.stderr, "");
  failure(run(["--selection", path.join(dir, "absent.json"), "--comparison", comparisonPath]), 1, "INPUT_READ");
  failure(run(["--selection", dir, "--comparison", comparisonPath]), 1, "INPUT_READ");
  failure(run([...base, "--output", path.join(dir, "absent", "out.md")]), 1, "OUTPUT_WRITE");
  const invalid = path.join(dir, "invalid.json"); fs.writeFileSync(invalid, "{");
  failure(run(["--selection", invalid, "--comparison", comparisonPath]), 1, "INVALID_JSON");
});

test("CLI diagnostic source control characters stay escaped", t => {
  const dir = temp(t); const changed = JSON.parse(s);
  changed.selectedRecords[0].groupKey = "wrong\nforged\u001b[31m";
  const file = path.join(dir, "selection.json"); fs.writeFileSync(file, JSON.stringify(changed));
  const result = run(["--selection", file, "--comparison", comparisonPath]);
  failure(result, 1, "SELECTION_MISMATCH");
  assert.equal(result.stderr.includes("\u001b"), false);
});

test("JSON and revised Markdown match current output; original Markdown is preserved", () => {
  assert.equal(fs.readFileSync(path.join(root, "examples/generated/dispatch-brief.json"), "utf8"), renderBrief(s, r, "json"));
  assert.equal(fs.readFileSync(path.join(root, "examples/generated/dispatch-brief-skim.md"), "utf8"), renderBrief(s, r));
  assert.equal(hash(fs.readFileSync(path.join(root, "examples/generated/dispatch-brief.md"))), "cf56d83838e6d833c0f6506fe007e6d018d8750f8a29cfcb00861a5a53f23b31");
  assert.equal(hash(fs.readFileSync(path.join(root, "examples/generated/dispatch-brief.json"))), "aed9daa61ba62b564c0b490f46945c39a5c0c74df136434d298b2abed928dcd3");
});


test("documented library example runs with real and derived empty selections", () => {
  const example = path.join(root, "examples/library-example.js");
  for (const args of [[], ["--empty"]]) {
    const result = spawnSync(process.execPath, [example, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const brief = JSON.parse(result.stdout);
    assert.equal(brief.selectedCount, args.length ? 0 : 2);
    assert.equal(brief.reviewContext.purposeLabel, "Dispatch evidence follow-up");
    assert.equal(brief.comparison.sha256, hash(r));
  }
  assert.deepEqual(fs.readFileSync(selectionPath), s);
  assert.deepEqual(fs.readFileSync(comparisonPath), r);
});
