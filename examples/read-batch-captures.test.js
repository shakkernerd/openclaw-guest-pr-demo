"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

// Byte-for-byte saved producer capture, not a new producer run or calculation.
const STDOUT = '{"line":1,"mixed":{"mode":"mixed","maxItemsPerBox":4,"totalItems":5,"boxCount":2,"fullBoxes":1,"partialBoxes":1,"unusedItemSlots":"3"},"single-sku":{"mode":"single-sku","maxItemsPerBox":4,"totalItems":5,"boxCount":2,"fullBoxes":0,"partialBoxes":2,"unusedItemSlots":"3"}}\n' +
  '{"line":5,"mixed":{"mode":"mixed","maxItemsPerBox":4,"totalItems":6,"boxCount":2,"fullBoxes":1,"partialBoxes":1,"unusedItemSlots":"2"},"single-sku":{"mode":"single-sku","maxItemsPerBox":4,"totalItems":6,"boxCount":2,"fullBoxes":1,"partialBoxes":1,"unusedItemSlots":"2"}}\n';
const STDERR = '{"version":1,"type":"record-error","line":3,"message":"input must contain one valid JSON order"}\n' +
  '{"version":1,"type":"record-error","line":4,"message":"items[0].quantity must be a non-negative safe integer"}\n' +
  '{"version":1,"type":"complete","exitCode":1}\n';
const result = (line = 1) => ({ ...JSON.parse(STDOUT.split("\n")[0]), line });
const rejection = (line = 3, message = "unchanged rejection") => ({ version: 1, type: "record-error", line, message });
const complete = (exitCode = 0) => ({ version: 1, type: "complete", exitCode });
const fatal = (operation = "write-diagnostics", code = "EIO") => ({ version: 1, type: "fatal-error", operation, code });
const jsonl = (...records) => records.map(record => JSON.stringify(record) + "\n").join("");
const codes = report => report.issues.map(issue => issue.code);
const observation = (stream, frame, record) => ({ stream, frame, record });

function files(t, stdout = STDOUT, stderr = STDERR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-capture-reader-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = [path.join(dir, "stdout.txt"), path.join(dir, "stderr.txt")];
  fs.writeFileSync(paths[0], stdout);
  fs.writeFileSync(paths[1], stderr);
  return paths;
}

function cli(args, options = {}) {
  const run = spawnSync(process.execPath, [path.join(__dirname, "read-batch-captures.js"), ...args], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], ...options,
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  return run;
}

// All semantic assertions use actual files and the unmodified CLI entry point.
function inspect(t, stdout = "", stderr = "") {
  const run = cli(files(t, stdout, stderr));
  assert.equal(run.status, 0); // Reader success does not assert producer success.
  assert.equal(run.stderr, "");
  const report = JSON.parse(run.stdout);
  assert.equal(run.stdout, JSON.stringify(report) + "\n");
  return report;
}

test("real saved capture: exact observations, deterministic CLI report and pinned evidence limits", t => {
  assert.equal(createHash("sha256").update(STDOUT).digest("hex"),
    "e8f541066a8d871307d4efef3cb3f3c7f1ba5796008e6f039b9a8de0d6b44284");
  assert.equal(createHash("sha256").update(STDERR).digest("hex"),
    "72f1ee81f7d9fe3c93b1698b2902b6df8bafb6983024177f4524cdbf435344a9");
  const report = inspect(t, STDOUT, STDERR);
  assert.deepEqual(inspect(t, STDOUT, STDERR), report);
  assert.deepEqual(report.observed, {
    stdout: { frames: 2, accepted: 2, fragments: 0, readError: null },
    stderr: { frames: 3, accepted: 3, fragments: 0, readError: null },
    summaries: 2, rejections: 2, completions: 1, fatals: 0,
  });
  const outputs = STDOUT.trimEnd().split("\n").map(JSON.parse);
  const diagnostics = STDERR.trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(report.rows, [
    { line: 1, outcomes: [observation("stdout", 1, outputs[0])] },
    { line: 3, outcomes: [observation("stderr", 1, diagnostics[0])] },
    { line: 4, outcomes: [observation("stderr", 2, diagnostics[1])] },
    { line: 5, outcomes: [observation("stdout", 2, outputs[1])] },
  ]);
  assert.deepEqual(report.terminalEvents, [observation("stderr", 3, diagnostics[2])]);
  assert.deepEqual(report.issues, []);
  for (const limit of ["pairing", "draining", "process result", "intended input completeness",
    "persistence", "physical packing", "hostile JSON-member-duplication"]) {
    assert.ok(report.limits.some(text => text.includes(limit)), limit);
  }
  assert.ok(report.limits.includes(
    "Completion is not a process result and cannot exclude a later diagnostic-write failure. " +
    "Even captured complete(1) plus a separately observed normal producer exit 1 cannot distinguish " +
    "rejection-only completion from completion-diagnostic bytes delivered before that write failed."));
});

test("LF framing: CRLF, blanks, parseable tails, empty captures and no phantom final frame", t => {
  const report = inspect(t, "\n \t\r\n" + jsonl(result()).replace(/\n/g, "\r\n") + JSON.stringify(result(5)),
    jsonl(complete()).trimEnd());
  assert.deepEqual(report.observed.stdout, { frames: 3, accepted: 1, fragments: 1, readError: null });
  assert.deepEqual(report.rows[0].outcomes, [observation("stdout", 3, result())]);
  assert.deepEqual(report.issues.filter(issue => issue.code === "incomplete-fragment").map(issue =>
    [issue.stream, issue.frame, issue.text]), [["stdout", 4, JSON.stringify(result(5))], ["stderr", 1, JSON.stringify(complete())]]);
  assert.equal(report.observed.completions, 0);
  assert.equal(codes(report).filter(code => code === "blank-frame").length, 2);
  assert.ok(codes(report).includes("missing-completion"));
  const empty = inspect(t);
  assert.equal(empty.observed.stdout.frames, 0);
  assert.equal(empty.observed.stderr.frames, 0);
  assert.deepEqual(codes(empty), ["missing-completion"]);
  assert.deepEqual(inspect(t, "", jsonl(complete())).issues, []);
});

test("bare CR, BOM, malformed/unsupported frames: continue to later observations", t => {
  const report = inspect(t, JSON.stringify(result()) + "\r" + jsonl(result(2)) + "{\n" +
    "\uFEFF" + jsonl(result(4)) + jsonl(result(5)),
    "\nhuman diagnostics\n" + jsonl({ version: 2, type: "complete", exitCode: 0 },
      { version: 1, type: "future-event" }, complete()));
  assert.deepEqual(report.rows, [{ line: 5, outcomes: [observation("stdout", 4, result(5))] }]);
  assert.deepEqual(report.terminalEvents, [observation("stderr", 5, complete())]);
  assert.equal(codes(report).filter(code => code === "malformed-json").length, 4);
  assert.equal(codes(report).filter(code => code === "unsupported-frame").length, 2);
  assert.equal(codes(report).filter(code => code === "blank-frame").length, 1);
});

test("batched envelope/scalar inventory uses one CLI run, without arithmetic validation", t => {
  const badResults = [null, [], 1, {}, { ...result(), extra: true }];
  for (const line of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) badResults.push({ ...result(), line });
  for (const mode of ["mixed", "single-sku"]) {
    for (const [key, value] of [["mode", "unknown"], ["maxItemsPerBox", 0], ["totalItems", -1],
      ["boxCount", 1.5], ["fullBoxes", "1"], ["partialBoxes", Number.MAX_SAFE_INTEGER + 1],
      ["unusedItemSlots", 3], ["unusedItemSlots", "-1"], ["unusedItemSlots", "1e3"],
      ["unusedItemSlots", "01"], ["unusedItemSlots", ""], ["unusedItemSlots", "1.0"]]) {
      const item = result();
      item[mode][key] = value;
      badResults.push(item);
    }
    const missing = result();
    delete missing[mode].boxCount;
    badResults.push(missing);
  }
  const badEvents = [null, [], { ...rejection(), line: 0 }, { ...rejection(), message: 7 },
    { ...rejection(), extra: true }, { ...complete(), exitCode: "0" }, complete(2),
    { ...complete(), line: 1 }, fatal("unknown"), fatal("read-input", "eio"), fatal("read-input", 5),
    { ...fatal(), line: 1 }, { ...complete(), version: "1" }, { ...complete(), version: 2 }];
  const arbitrary = result(8);
  arbitrary.mixed.unusedItemSlots = "999999999999999999999999999999999999";
  arbitrary.mixed.boxCount = 0; // Not checking packing identities.
  const disagreement = result(Number.MAX_SAFE_INTEGER);
  disagreement["single-sku"].totalItems = 99;
  const report = inspect(t, jsonl(...badResults, arbitrary, disagreement), jsonl(...badEvents, complete()));
  assert.equal(report.observed.summaries, 2);
  assert.equal(report.observed.stderr.accepted, 1);
  assert.deepEqual(report.rows, [
    { line: 8, outcomes: [observation("stdout", badResults.length + 1, arbitrary)] },
    { line: Number.MAX_SAFE_INTEGER, outcomes: [observation("stdout", badResults.length + 2, disagreement)] },
  ]);
  assert.deepEqual(report.issues.filter(issue => issue.code === "invalid-frame" && issue.stream === "stdout"),
    badResults.map((record, index) => ({ code: "invalid-frame", stream: "stdout", frame: index + 1, text: JSON.stringify(record) })));
  assert.deepEqual(report.issues.filter(issue => issue.stream === "stderr"),
    badEvents.map((record, index) => ({ code: index < 12 ? "invalid-frame" : "unsupported-frame",
      stream: "stderr", frame: index + 1, text: JSON.stringify(record) })));
  assert.deepEqual(report.issues.filter(issue => issue.code === "summary-disagreement"),
    [{ code: "summary-disagreement", stream: "stdout", frame: badResults.length + 2, field: "totalItems" }]);
});

test("duplicates, conflicts and overlap preserve every original value and message", t => {
  const changed = result();
  changed.mixed.unusedItemSlots = "999999999999999999";
  const messages = [rejection(1, " A \n Ω "), rejection(1, " A \n Ω "), rejection(1, "different")];
  const report = inspect(t, jsonl(result(), result(), changed), jsonl(...messages, complete(1)));
  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.rows[0].outcomes, [
    ...[result(), result(), changed].map((record, index) => observation("stdout", index + 1, record)),
    ...messages.map((record, index) => observation("stderr", index + 1, record)),
  ]);
  assert.equal(codes(report).filter(code => code === "duplicate-outcome").length, 4);
  assert.equal(codes(report).filter(code => code === "conflicting-outcomes").length, 2);
  assert.equal(codes(report).filter(code => code === "overlapping-outcomes").length, 3);
  assert.equal(report.observed.summaries, 3);
  assert.equal(report.observed.rejections, 3);
});

test("within-stream ordering only; retain all terminal events and later outcomes", t => {
  const events = [rejection(8), rejection(3), complete(1), rejection(9), fatal(), complete(0), fatal("read-input", "EOF")];
  const report = inspect(t, jsonl(result(7), result(2)), jsonl(...events));
  assert.equal(codes(report).filter(code => code === "non-increasing-line").length, 2);
  for (const code of ["outcome-after-terminal", "duplicate-completion", "conflicting-completions",
    "completion-after-fatal", "duplicate-fatal", "completion-zero-with-rejections"]) assert.ok(codes(report).includes(code), code);
  assert.deepEqual(report.terminalEvents, [2, 4, 5, 6].map(index => observation("stderr", index + 1, events[index])));
  assert.deepEqual(report.rows, [
    { line: 2, outcomes: [observation("stdout", 2, result(2))] },
    { line: 3, outcomes: [observation("stderr", 2, events[1])] },
    { line: 7, outcomes: [observation("stdout", 1, result(7))] },
    { line: 8, outcomes: [observation("stderr", 1, events[0])] },
    { line: 9, outcomes: [observation("stderr", 4, events[3])] },
  ]); // No fatal row, even after contradictory evidence.
  assert.deepEqual(inspect(t, jsonl(result(10)), jsonl(rejection(1), complete(1))).issues, []);
});

test("supported late fatal, duplicate completions and missing completion remain visible", t => {
  const report = inspect(t, "", jsonl(complete(), fatal()));
  assert.deepEqual(codes(report), ["fatal-observed"]);
  assert.equal(report.observed.completions, 1);
  assert.equal(report.observed.fatals, 1);
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.terminalEvents, [observation("stderr", 1, complete()), observation("stderr", 2, fatal())]);
  const duplicate = inspect(t, "", jsonl(complete(1), complete(1)) + "{");
  assert.deepEqual(codes(duplicate), ["duplicate-completion", "incomplete-fragment",
    "completion-one-without-observed-rejection", "completion-one-without-observed-rejection"]);
  assert.deepEqual(duplicate.terminalEvents, [1, 2].map(frame => observation("stderr", frame, complete(1))));
  const missing = inspect(t, " \r", jsonl(fatal(), rejection()));
  assert.deepEqual(codes(missing), ["incomplete-fragment", "fatal-observed", "outcome-after-terminal", "missing-completion"]);
  assert.equal(missing.observed.completions, 0);
});

test("read failures on either/both files retain the readable stream and return 1", t => {
  const paths = files(t);
  for (const missing of [[0], [1], [0, 1]]) {
    const args = paths.map((file, index) => missing.includes(index) ? file + ".absent" : file);
    const run = cli(args);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, "");
    const report = JSON.parse(run.stdout);
    assert.equal(report.observed.summaries, missing.includes(0) ? 0 : 2);
    assert.equal(report.observed.rejections, missing.includes(1) ? 0 : 2);
    assert.equal(report.observed.completions, missing.includes(1) ? 0 : 1);
    assert.equal(codes(report).filter(code => code === "read-error").length, missing.length);
    for (const index of missing) assert.equal(report.observed[["stdout", "stderr"][index]].readError, "ENOENT");
  }
});

test("exactly two explicit paths: misuse gives usage without a report; ./ permits dash-leading names", t => {
  for (const args of [[], ["one"], ["one", "two", "three"], ["-", "two"],
    ["one", "-"], ["--help"], ["--", "two"], ["one", "--flag"], ["", "two"]]) {
    const run = cli(args);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "Usage: node examples/read-batch-captures.js STDOUT_FILE STDERR_FILE\n" +
      "Exactly two file paths; no options or stdin. Use ./ for dash-leading filenames.\n");
  }
  const cwd = path.dirname(files(t)[0]);
  fs.writeFileSync(path.join(cwd, "-stdout"), "");
  fs.writeFileSync(path.join(cwd, "--stderr"), jsonl(complete()));
  const run = cli(["./-stdout", "./--stderr"], { cwd });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout).issues, []);
});

// Native, bounded checks: Linux /dev/full rejects real writes with ENOSPC.
// Inherited descriptors are not captured pipes; assert only available output.
// Other platforms/device absence skip these two checks, not the semantic tests.
const descriptorCheck = { skip: process.platform !== "linux" || !fs.existsSync("/dev/full")
  ? "requires Linux /dev/full" : false };

test("real report-output descriptor failure: status 1, no signal, best-effort stderr", descriptorCheck, t => {
  const fd = fs.openSync("/dev/full", "w");
  try {
    const run = cli(files(t), { stdio: ["ignore", fd, "pipe"] });
    assert.equal(run.status, 1);
    assert.equal(run.signal, null);
    assert.equal(run.stdout, null); // fd 1 is /dev/full, not an observable pipe.
    assert.equal(run.stderr, "read-batch-captures: cannot write report (ENOSPC)\n");
    t.diagnostic(JSON.stringify({ fd1: "/dev/full", status: run.status, signal: run.signal,
      stdout: run.stdout, stderr: run.stderr }));
  } finally { fs.closeSync(fd); }
});

test("real usage-output descriptor failure: status 1, no signal, empty stdout", descriptorCheck, t => {
  const fd = fs.openSync("/dev/full", "w");
  try {
    const run = cli([], { stdio: ["ignore", "pipe", fd] });
    assert.equal(run.status, 1);
    assert.equal(run.signal, null);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, null); // The failed usage sink cannot report itself.
    t.diagnostic(JSON.stringify({ fd2: "/dev/full", status: run.status, signal: run.signal,
      stdout: run.stdout, stderr: run.stderr }));
  } finally { fs.closeSync(fd); }
});
