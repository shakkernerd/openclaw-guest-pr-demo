"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const command = path.join(__dirname, "compare-batch-captures.js");
const summary = mode => ({ mode, maxItemsPerBox: 4, totalItems: 5, boxCount: 2,
  fullBoxes: 1, partialBoxes: 1, unusedItemSlots: "3" });
const row = line => ({ line, mixed: summary("mixed"), "single-sku": summary("single-sku") });
const rejection = (line, message = "invalid quantity") => ({ version: 1, type: "record-error", line, message });
const complete = exitCode => ({ version: 1, type: "complete", exitCode });
const fatal = () => ({ version: 1, type: "fatal-error", operation: "read-input", code: "EIO" });
const result = exitCode => ({ version: 1, state: "observed", exitCode, signal: null, launchError: null });
const jsonl = (...records) => records.map(record => JSON.stringify(record) + "\n").join("");
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + "\n");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-compare-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = path.join(root, "before");
  const after = path.join(root, "after");
  for (const directory of [before, after]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "stdout.jsonl"), jsonl(row(1)));
    fs.writeFileSync(path.join(directory, "stderr.jsonl"), jsonl(complete(0)));
    save(path.join(directory, "result.json"), result(0));
  }
  return { root, before, after };
}
function mapping(f, pairs) {
  const file = path.join(f.root, "mapping.json");
  save(file, { version: 1, pairs });
  return file;
}
function cli(args, options = {}) {
  const run = spawnSync(process.execPath, [command, ...args], { encoding: "utf8", timeout: 10000, ...options });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  return run;
}
function compare(f, pairs, status = 0, options) {
  const args = pairs === undefined ? [] : ["--mapping", mapping(f, pairs)];
  const run = cli([...args, f.before, f.after], options);
  assert.equal(run.status, status, run.stderr || run.stdout);
  assert.equal(run.stderr, "");
  const report = JSON.parse(run.stdout);
  assert.equal(run.stdout, JSON.stringify(report) + "\n");
  assert.equal(report.state, status === 0 ? "compared" : "unresolved");
  return report;
}
const snapshot = directory => fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name))]);

test("no implicit identity: equal lines remain separate; deterministic reports and unchanged input bytes", t => {
  const f = fixture(t);
  const bytes = [snapshot(f.before), snapshot(f.after)];
  const report = compare(f);
  assert.deepEqual(compare(f), report);
  assert.equal(report.processOutcomes.change, "unchanged");
  assert.equal(report.orders.mapping.state, "none");
  assert.deepEqual(report.orders.pairs, []);
  assert.deepEqual(report.orders.unmatched.before.map(row => row.line), [1]);
  assert.deepEqual(report.orders.unmatched.after.map(row => row.line), [1]);
  assert.equal(report.evidence.before.attempt.state, "absent");
  assert.deepEqual([snapshot(f.before), snapshot(f.after)], bytes);
  for (const limit of ["memory", "identity", "capture-command status", "complete(1)", "physical packing"]) {
    assert.ok(report.limits.some(text => text.includes(limit)), limit);
  }
});

test("explicit mapping preserves caller order, unmapped rows, outcome transitions and absent observations", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(rejection(2)));
  save(path.join(f.before, "result.json"), result(1));
  fs.writeFileSync(path.join(f.after, "stdout.jsonl"), jsonl(row(1), row(2), row(4)));
  const report = compare(f, [{ before: 3, after: 2 }, { before: 2, after: 1 }, { before: 9, after: 8 }]);
  assert.equal(report.processOutcomes.change, "changed");
  assert.equal(report.processOutcomes.before.record.exitCode, 1);
  assert.deepEqual(report.orders.pairs.map(pair => [pair.before.state, pair.after.state, pair.change]), [
    ["not-observed", "summary", "not-observed"],
    ["rejection", "summary", "outcome-changed"],
    ["not-observed", "not-observed", "not-observed"],
  ]);
  assert.deepEqual(report.orders.unmatched.before.map(row => row.line), [1]);
  assert.deepEqual(report.orders.unmatched.after.map(row => row.line), [4]);
  assert.equal(report.orders.pairs[1].before.outcomes[0].frame, 1);
  assert.ok(report.evidence.before.report.issues.some(issue => issue.code === "missing-completion"));
});

test("mapped summary fields and rejection text compare exactly, ignoring line/frame and JSON key order", t => {
  const f = fixture(t);
  const a = row(2);
  const b = row(5);
  a.mixed.unusedItemSlots = "90071992547409930000000001";
  b.mixed.unusedItemSlots = "90071992547409930000000002";
  b["single-sku"].boxCount = 3;
  fs.writeFileSync(path.join(f.before, "stdout.jsonl"), jsonl(a, row(4)));
  fs.writeFileSync(path.join(f.after, "stdout.jsonl"), jsonl(row(1), b));
  fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(rejection(6, " old \r\nΩ "), complete(1)));
  fs.writeFileSync(path.join(f.after, "stderr.jsonl"), jsonl(rejection(9, "new"), complete(1)));
  for (const directory of [f.before, f.after]) save(path.join(directory, "result.json"), result(1));
  const report = compare(f, [{ before: 2, after: 5 }, { before: 4, after: 1 }, { before: 6, after: 9 }]);
  assert.equal(report.orders.pairs[0].change, "summary-changed");
  assert.deepEqual(report.orders.pairs[0].fields, [
    { policy: "mixed", field: "unusedItemSlots", before: a.mixed.unusedItemSlots, after: b.mixed.unusedItemSlots },
    { policy: "single-sku", field: "boxCount", before: 2, after: 3 },
  ]);
  assert.equal(report.orders.pairs[1].change, "unchanged");
  assert.deepEqual(report.orders.pairs[2].fields, [{ field: "message", before: " old \r\nΩ ", after: "new" }]);
  assert.equal(report.orders.pairs[2].change, "rejection-changed");
  const reordered = Object.fromEntries(Object.entries(row(1)).reverse());
  reordered.mixed = Object.fromEntries(Object.entries(reordered.mixed).reverse());
  fs.writeFileSync(path.join(f.after, "stdout.jsonl"), jsonl(reordered));
  assert.equal(compare(f, [{ before: 4, after: 1 }]).orders.pairs[0].change, "unchanged");
});

test("duplicate, conflicting and overlapping outcomes are all preserved and never last-wins", t => {
  const f = fixture(t);
  const different = row(1);
  different.mixed.boxCount = 7;
  fs.writeFileSync(path.join(f.before, "stdout.jsonl"), jsonl(row(1), row(1), different));
  fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(rejection(1), rejection(1, "other"), complete(1)));
  save(path.join(f.before, "result.json"), result(1));
  const report = compare(f, [{ before: 1, after: 1 }], 1);
  assert.equal(report.orders.pairs[0].change, "ambiguous");
  assert.equal(report.orders.pairs[0].before.outcomes.length, 5);
  assert.deepEqual(report.orders.pairs[0].fields, []);
  for (const code of ["duplicate-outcome", "conflicting-outcomes", "overlapping-outcomes", "non-increasing-line"]) {
    assert.ok(report.evidence.before.report.issues.some(issue => issue.code === code), code);
  }
  assert.equal(report.evidence.before.reader.exitCode, 0); // Report production is not evidence validity.
});

test("summary-to-rejection transitions and unchanged rejection text remain distinct from process changes", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(rejection(2, "same"), complete(1)));
  fs.writeFileSync(path.join(f.after, "stdout.jsonl"), "");
  fs.writeFileSync(path.join(f.after, "stderr.jsonl"), jsonl(rejection(1, "now rejected"), rejection(3, "same"), complete(1)));
  for (const dir of [f.before, f.after]) save(path.join(dir, "result.json"), result(1));
  const report = compare(f, [{ before: 1, after: 1 }, { before: 2, after: 3 }]);
  assert.equal(report.processOutcomes.change, "unchanged");
  assert.deepEqual(report.orders.pairs.map(pair => pair.change), ["outcome-changed", "unchanged"]);
  assert.equal(report.orders.pairs[0].before.state, "summary");
  assert.equal(report.orders.pairs[0].after.state, "rejection");
});

test("empty completed captures are valid but completion contradictions and evidence gaps block comparison", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.before, "stdout.jsonl"), "");
  assert.deepEqual(compare(f).orders.unmatched.before, []);
  for (const [events, code] of [
    [[complete(0), complete(0)], "duplicate-completion"],
    [[complete(1)], "completion-one-without-observed-rejection"],
    [[rejection(2), complete(0)], "completion-zero-with-rejections"],
    [[fatal(), complete(0)], "completion-after-fatal"],
    [[complete(1), rejection(2)], "outcome-after-terminal"],
  ]) {
    fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(...events));
    save(path.join(f.before, "result.json"), result(1));
    const report = compare(f, undefined, 1);
    assert.ok(report.evidence.before.problems.some(problem => problem.issue?.code === code), code);
    assert.equal(report.evidence.before.reader.exitCode, 0);
  }
});

test("a single internally inconsistent summary is not used as an unambiguous comparison", t => {
  const f = fixture(t);
  const bad = row(1);
  bad.mixed.totalItems = 99;
  fs.writeFileSync(path.join(f.after, "stdout.jsonl"), jsonl(bad));
  const report = compare(f, [{ before: 1, after: 1 }], 1);
  assert.equal(report.orders.pairs[0].after.state, "ambiguous");
  assert.equal(report.orders.pairs[0].change, "ambiguous");
});

test("indexed disagreements remain stream-local and preserve mapping order and full outcome arrays", t => {
  const f = fixture(t);
  const inconsistent = row(10);
  inconsistent.mixed.totalItems = 6;
  fs.writeFileSync(path.join(f.before, "stdout.jsonl"), jsonl(inconsistent, row(20)));
  fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(rejection(30), complete(1)));
  fs.writeFileSync(path.join(f.after, "stdout.jsonl"), jsonl(row(2), row(3)));
  fs.writeFileSync(path.join(f.after, "stderr.jsonl"), jsonl(rejection(4), complete(1)));
  for (const directory of [f.before, f.after]) save(path.join(directory, "result.json"), result(1));
  const report = compare(f, [{ before: 30, after: 4 }, { before: 20, after: 2 },
    { before: 10, after: 3 }, { before: 99, after: 9 }], 1);
  assert.deepEqual(report.orders.pairs.map(pair => pair.before.line), [30, 20, 10, 99]);
  assert.deepEqual(report.orders.pairs.map(pair => pair.change), ["unchanged", "unchanged", "ambiguous", "not-observed"]);
  // stdout frame 1 is inconsistent; stderr frame 1 is not the same location.
  assert.equal(report.orders.pairs[0].before.state, "rejection");
  for (const pair of report.orders.pairs) {
    assert.deepEqual(pair.before.outcomes, report.evidence.before.report.rows.find(row => row.line === pair.before.line)?.outcomes ?? []);
  }
});

test("missing streams yield useful JSON but retain reader failure and nonzero comparison", t => {
  for (const missing of [["stdout"], ["stderr"], ["stdout", "stderr"]]) {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(rejection(3), complete(1)));
    save(path.join(f.before, "result.json"), result(1));
    for (const stream of missing) fs.unlinkSync(path.join(f.before, stream + ".jsonl"));
    const bytes = [snapshot(f.before), snapshot(f.after)];
    const report = compare(f, [{ before: 3, after: 1 }, { before: 1, after: 8 }], 1);
    assert.equal(report.evidence.before.reader.exitCode, 1);
    for (const stream of missing) assert.equal(report.evidence.before.report.observed[stream].readError, "ENOENT");
    assert.equal(report.orders.pairs[0].change, missing.includes("stderr") ? "not-observed" : "outcome-changed");
    assert.equal(report.orders.pairs[1].change, "not-observed");
    assert.equal(report.evidence.after.report.observed.summaries, 1);
    assert.deepEqual([snapshot(f.before), snapshot(f.after)], bytes);
  }
});

test("missing, malformed, unsupported and inconsistent result files stay unresolved", t => {
  const f = fixture(t);
  const file = path.join(f.before, "result.json");
  const invalid = [null, [], { ...result(0), version: 2 }, { ...result(0), state: "prepared" },
    { ...result(0), signal: "SIGTERM" }, { ...result(0), exitCode: null },
    { ...result(0), exitCode: "0" }, { ...result(0), exitCode: -1 },
    { ...result(0), launchError: { code: "ENOENT", message: "missing" } }];
  for (const value of invalid) {
    save(file, value);
    const report = compare(f, undefined, 1);
    assert.equal(report.processOutcomes.before.state, "unresolved");
    assert.equal(report.processOutcomes.change, "unresolved");
    assert.equal(report.orders.unmatched.before.length, 1);
  }
  fs.writeFileSync(file, "{");
  assert.equal(compare(f, undefined, 1).processOutcomes.before.problem.code, "malformed-json");
  fs.unlinkSync(file);
  assert.equal(compare(f, undefined, 1).processOutcomes.before.problem.error, "ENOENT");
});

test("real filesystem read errors on required streams/result remain errors", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  for (const name of ["stdout.jsonl", "result.json"]) {
    const file = path.join(f.before, name);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
  }
  const report = compare(f, undefined, 1);
  assert.equal(report.evidence.before.reader.exitCode, 1);
  assert.equal(report.evidence.before.report.observed.stdout.readError, "EISDIR");
  assert.equal(report.processOutcomes.before.problem.error, "EISDIR");
  assert.equal(report.orders.unmatched.after.length, 1);
});

test("malformed/unsupported frames, blank frames, fragments and ordering errors retain later observations", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.before, "stdout.jsonl"), "\n{\n" + jsonl(row(4), row(2)) + JSON.stringify(row(8)));
  fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl({ version: 2, type: "complete", exitCode: 0 }, complete(0)));
  const report = compare(f, [{ before: 2, after: 1 }], 1);
  assert.equal(report.orders.pairs[0].change, "unchanged");
  assert.deepEqual(report.evidence.before.report.rows.map(row => row.line), [2, 4]);
  for (const code of ["blank-frame", "malformed-json", "incomplete-fragment", "non-increasing-line", "unsupported-frame"]) {
    assert.ok(report.evidence.before.report.issues.some(issue => issue.code === code), code);
  }
  assert.equal(report.evidence.before.reader.exitCode, 0);
});

test("normal failures, signals and launch errors are data, not comparison failure", t => {
  const f = fixture(t);
  for (const recorded of [result(1), result(2),
    { ...result(null), signal: "SIGTERM" },
    { ...result(null), launchError: { code: "ENOENT", message: "missing executable" } }]) {
    save(path.join(f.before, "result.json"), recorded);
    fs.writeFileSync(path.join(f.before, "stdout.jsonl"), "");
    fs.writeFileSync(path.join(f.before, "stderr.jsonl"), "");
    const report = compare(f);
    assert.deepEqual(report.processOutcomes.before.record, recorded);
    assert.equal(report.processOutcomes.change, "changed");
    assert.ok(report.evidence.before.report.issues.some(issue => issue.code === "missing-completion"));
  }
});

test("complete-then-fatal and complete-looking failed diagnostic writes never override process failure", t => {
  const f = fixture(t);
  save(path.join(f.before, "result.json"), result(1));
  for (const events of [[complete(0), fatal()], [complete(0)], [rejection(2), complete(1)]]) {
    fs.writeFileSync(path.join(f.before, "stderr.jsonl"), jsonl(...events));
    const report = compare(f);
    assert.equal(report.processOutcomes.before.record.exitCode, 1);
    assert.deepEqual(report.evidence.before.report.terminalEvents.map(event => event.record),
      events.filter(event => event.type !== "record-error"));
    if (events[0].type === "complete") {
      assert.equal(report.evidence.before.notes[0].code, "completion-not-confirmed-by-process");
    }
  }
});

test("claimed zero exit requires clean completion; launch failure cannot own producer bytes", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.before, "stderr.jsonl"), "");
  assert.ok(compare(f, undefined, 1).evidence.before.problems.some(problem => problem.code === "exit-zero-without-clean-completion"));
  save(path.join(f.before, "result.json"), { ...result(null), launchError: { code: null, message: "no launch" } });
  assert.ok(compare(f, undefined, 1).evidence.before.problems.some(problem => problem.code === "launch-error-with-stream-content"));
});

test("mapping rejects non-one-to-one, unsafe/nonpositive, unsupported and unreadable data without guessing", t => {
  const f = fixture(t);
  const file = path.join(f.root, "mapping.json");
  const invalid = [null, [], { version: 2, pairs: [] }, { version: 1, pairs: [], extra: true },
    ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].flatMap(value => [
      { version: 1, pairs: [{ before: value, after: 1 }] },
      { version: 1, pairs: [{ before: 1, after: value }] },
    ]),
    { version: 1, pairs: [{ before: 1, after: 1 }, { before: 1, after: 1 }] },
    { version: 1, pairs: [{ before: 1, after: 1 }, { before: 1, after: 2 }] },
    { version: 1, pairs: [{ before: 1, after: 1 }, { before: 2, after: 1 }] },
    { version: 1, pairs: [{ before: 1, after: 1, extra: true }] }];
  for (const value of invalid) {
    save(file, value);
    const run = cli(["--mapping", file, f.before, f.after]);
    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout);
    assert.equal(report.orders.mapping.state, "unresolved");
    assert.deepEqual(report.orders.pairs, []);
    assert.equal(report.orders.unmatched.before.length, 1);
    assert.equal(report.orders.unmatched.after.length, 1);
  }
  fs.writeFileSync(file, "{");
  assert.equal(cli(["--mapping", file, f.before, f.after]).status, 1);
  fs.unlinkSync(file);
  assert.equal(cli(["--mapping", file, f.before, f.after]).status, 1);
  assert.equal(compare(f, [{ before: Number.MAX_SAFE_INTEGER, after: Number.MAX_SAFE_INTEGER }]).orders.pairs[0].change, "not-observed");
  assert.equal(compare(f, []).orders.mapping.state, "explicit");
});

test("optional prepared context never runs its executable, opens its input, or supplies missing process results", t => {
  const f = fixture(t);
  const marker = path.join(f.root, "must-not-exist");
  const originalInput = path.join(f.root, "protected-original.jsonl");
  const originalBytes = Buffer.from(jsonl({ items: [], maxItemsPerBox: 4 }));
  fs.writeFileSync(originalInput, originalBytes);
  const protectedPath = fs.realpathSync.native(originalInput);
  const readLog = path.join(f.root, "protected-reads.log");
  save(path.join(f.before, "attempt.json"), { version: 1, state: "prepared", executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`, "--", originalInput], cwd: f.root });
  const preload = path.join(f.root, "reader-only.cjs");
  fs.writeFileSync(preload, `
    const path = require('node:path');
    if (!['compare-batch-captures.js', 'read-batch-captures.js', 'prohibited-read.cjs'].includes(path.basename(process.argv[1]))) process.exit(99);
    const fs = require('node:fs');
    const protectedPath = ${JSON.stringify(protectedPath)};
    const identity = fs.statSync(protectedPath);
    function check(file) {
      let protectedFile = false;
      try {
        if (typeof file === 'number') {
          const stat = fs.fstatSync(file);
          protectedFile = stat.dev === identity.dev && stat.ino === identity.ino;
        } else protectedFile = fs.realpathSync.native(file) === protectedPath;
      } catch { /* Missing unrelated capture files retain their normal behavior. */ }
      if (protectedFile) {
        fs.appendFileSync(${JSON.stringify(readLog)}, protectedPath + String.fromCharCode(10));
        throw Object.assign(new Error('prohibited original-input read'), { code: 'PROTECTED_ORIGINAL_INPUT' });
      }
    }
    for (const [owner, names] of [[fs, ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']],
      [fs.promises, ['readFile', 'open']]]) {
      for (const name of names) {
        const read = owner[name];
        owner[name] = function(file, ...args) { check(file); return read.call(this, file, ...args); };
      }
    }
  `);
  const options = { env: { ...process.env, NODE_OPTIONS: "--require " + JSON.stringify(preload) } };
  // Positive control: prove that this real .jsonl input cannot slip through the
  // guard. A log also detects a prohibited read if comparison ever catches it.
  const probe = path.join(f.root, "prohibited-read.cjs");
  fs.writeFileSync(probe, `require('node:fs').readFileSync(${JSON.stringify(originalInput)});`);
  const prohibited = spawnSync(process.execPath, [probe], { ...options, encoding: "utf8", timeout: 10000 });
  assert.ifError(prohibited.error);
  assert.equal(prohibited.signal, null);
  assert.equal(prohibited.status, 1);
  assert.match(prohibited.stderr, /PROTECTED_ORIGINAL_INPUT/);
  const probeLog = fs.readFileSync(readLog);
  assert.equal(probeLog.toString(), protectedPath + String.fromCharCode(10));
  assert.equal(compare(f, undefined, 0, options).evidence.before.attempt.state, "prepared-context");
  fs.unlinkSync(path.join(f.before, "result.json"));
  assert.equal(compare(f, undefined, 1, options).processOutcomes.before.state, "unresolved");
  assert.equal(fs.existsSync(marker), false);
  save(path.join(f.before, "result.json"), result(0));
  fs.writeFileSync(path.join(f.before, "attempt.json"), "{");
  assert.equal(compare(f, undefined, 0, options).evidence.before.attempt.state, "unresolved");
  assert.deepEqual(fs.readFileSync(readLog), probeLog);
  assert.deepEqual(fs.readFileSync(originalInput), originalBytes);
  t.diagnostic("prohibited-read probe exit 1; real comparison exit 0; no protected-input reads by comparisons");
});

test("argument misuse does not read captures; terminator and dash-leading directories work", t => {
  for (const args of [[], ["one"], ["a", "b", "c"], ["-", "b"], ["--unknown", "a", "b"],
    ["--mapping"], ["--mapping", "x", "--mapping", "y", "a", "b"], ["--help", "b"]]) {
    const run = cli(args);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /^Usage:/);
  }
  assert.equal(cli(["--help"]).status, 0);
  const f = fixture(t);
  fs.renameSync(f.before, path.join(f.root, "--before"));
  assert.equal(cli(["--", "--before", "after"], { cwd: f.root }).status, 0);
});

test("directory paths preserve symlink/.. traversal instead of selecting a different capture", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "physical"));
  fs.mkdirSync(path.join(f.root, "physical", "deep"));
  fs.symlinkSync("physical/deep", path.join(f.root, "jump"));
  fs.renameSync(f.before, path.join(f.root, "physical", "before"));
  const run = cli(["jump/../before", "after"], { cwd: f.root });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).processOutcomes.before.record.exitCode, 0);
});

test("real report and usage output failures remain nonzero", {
  skip: process.platform !== "linux" || !fs.existsSync("/dev/full"),
}, t => {
  const f = fixture(t);
  const fd = fs.openSync("/dev/full", "w");
  try {
    const run = cli([f.before, f.after], { stdio: ["ignore", fd, "pipe"] });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, "compare-batch-captures: cannot write report (ENOSPC)\n");
    assert.equal(cli([], { stdio: ["ignore", "pipe", fd] }).status, 1);
  } finally { fs.closeSync(fd); }
});
