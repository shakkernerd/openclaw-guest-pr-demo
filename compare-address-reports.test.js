"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const command = join(__dirname, "compare-address-reports.js");
const success = (file, formatted = "") => ({ file, ok: true, formatted });
const failure = (file, stage = "format", name = "Error", message = "bad") =>
  ({ file, ok: false, error: { stage, name, message } });
const report = (rows) => ({ total: rows.length, succeeded: rows.filter((row) => row.ok).length,
  failed: rows.filter((row) => !row.ok).length, results: rows.map((row, i) => ({ ...row, position: i + 1 })) });
const bytes = (value) => Buffer.from(JSON.stringify(value));
const zeroCounts = { paired: 0, originalOnly: 0, rerunOnly: 0, ambiguousOccurrences: 0,
  "failure-to-success": 0, "success-to-failure": 0, "success-same": 0,
  "success-changed": 0, "failure-same": 0, "failure-changed": 0 };

function run(args, inputs = {}, { observe = false, stdoutFd } = {}) {
  const record = mkdtempSync(join(tmpdir(), "compare-address-reports-"));
  try {
    const directory = join(record, "inputs");
    mkdirSync(directory);
    for (const [file, content] of Object.entries(inputs)) writeFileSync(join(directory, file), content);
    const entries = readdirSync(directory);
    const before = entries.map((file) => readFileSync(join(directory, file)));
    const nodeArgs = [];
    const readLog = join(record, "reads.jsonl");
    if (observe) {
      const observer = join(record, "observe-reads.cjs");
      writeFileSync(readLog, "");
      // Observe real reads, including unsuccessful ones, without replacing results.
      // Bound the observer and keep its log outside the child input directory.
      writeFileSync(observer, `"use strict";
const fs = require("node:fs");
const read = fs.readFileSync;
let calls = 0;
fs.readFileSync = function (...args) {
  if (++calls > 32) throw new Error("Test read observation limit exceeded");
  fs.appendFileSync(${JSON.stringify(readLog)}, JSON.stringify(args[0]) + "\\n");
  return read.apply(this, args);
};
`);
      nodeArgs.push("--require", observer);
    }
    nodeArgs.push(command, ...args);
    const actual = spawnSync(process.execPath, nodeArgs, {
      cwd: directory, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
      stdio: ["pipe", stdoutFd === undefined ? "pipe" : stdoutFd, "pipe"],
      // Stdin is never an input, even when it contains a valid report.
      input: JSON.stringify(report([])),
    });
    // Snapshot observations for caller assertions before finally removes scratch.
    actual.reads = observe ? readFileSync(readLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    assert.ifError(actual.error);
    assert.equal(actual.signal, null);
    assert.deepEqual(readdirSync(directory), entries);
    entries.forEach((file, index) => assert.deepEqual(readFileSync(join(directory, file)), before[index]));
    return actual;
  } finally {
    // Only this invocation's exact newly created root, including observer/log files.
    rmSync(record, { recursive: true, force: true });
  }
}

function assertResult(actual, expected) {
  assert.equal(actual.status, 0);
  assert.equal(actual.stderr, "");
  assert.equal(actual.stdout, JSON.stringify(expected) + "\n");
}

function assertInputReads(actual, expected) {
  const modules = [command, join(__dirname, "saved-batch-report.js"), join(__dirname, "saved-batch-comparison.js")];
  assert.deepEqual(actual.reads.filter((file) => !modules.includes(file)), expected);
}

function assertMappingError(actual, stage, message, file = "mapping.json") {
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout, "");
  assert.equal(actual.stderr, "mapping file " + JSON.stringify(file) + " (" + stage + "): " + message + "\n");
}

test("unique exact paths retain ordered rows, all recorded outcomes and literal values", () => {
  const literal = " \uFEFF Ω e\u0301\r\n<saved>\ud800 ";
  const original = report([failure("fixed"), success("regressed", literal),
    { ...success("same", ""), extra: { retained: true } }, success("changed", "a\r\nb"),
    failure("still", "read", "", ""), failure("error-changed", "decode", "SyntaxError", literal)]);
  const rerun = report([failure("error-changed", "format", "RangeError", literal + " "),
    failure("still", "read", "", ""), success("changed", "a\nb"), success("same", ""),
    failure("regressed"), success("fixed", literal)]);
  const kinds = ["failure-to-success", "success-to-failure", "success-same",
    "success-changed", "failure-same", "failure-changed"];
  assertResult(run(["original.json", "rerun.json"], {
    "original.json": bytes(original), "rerun.json": bytes(rerun),
  }), {
    rows: original.results.map((row, i) => ({ original: row, rerun: rerun.results[5 - i],
      basis: "unique-exact-path", kind: kinds[i], ambiguous: false, pathChanged: false, positionChanged: true })),
    counts: { ...zeroCounts, paired: 6, "failure-to-success": 1, "success-to-failure": 1,
      "success-same": 1, "success-changed": 1, "failure-same": 1, "failure-changed": 1 },
  });
});

test("duplicates stay ambiguous and different spellings stay unmatched without inference", () => {
  const original = report([success("duplicate"), failure("duplicate"), success("./draft"),
    success("NAME"), success("é"), failure("stage-old/draft")]);
  const rerun = report([success("duplicate"), success("draft"), success("name"),
    success("e\u0301"), success("stage-new/draft")]);
  assertResult(run(["original.json", "rerun.json"], {
    "original.json": bytes(original), "rerun.json": bytes(rerun),
  }), {
    rows: [
      ...original.results.map((row, i) => ({ original: row, rerun: null, basis: null,
        kind: "original-only", ambiguous: i < 2 })),
      ...rerun.results.map((row, i) => ({ original: null, rerun: row, basis: null,
        kind: "rerun-only", ambiguous: i === 0 })),
    ],
    counts: { ...zeroCounts, originalOnly: 6, rerunOnly: 5, ambiguousOccurrences: 3 },
  });
});

test("empty reports and option-like or glob-like literal filenames are accepted without stdin", () => {
  const empty = bytes(report([]));
  for (const args of [["--help", "literal*.json"], ["-", "--"], ["--mappings", "--help"], ["./report with spaces.json", "rerun.json"]]) {
    assertResult(run(args, { [args[0]]: empty, [args[1]]: empty }), { rows: [], counts: zeroCounts });
  }
  const actual = run(["absent*.json", "rerun.json"], { "absent-match.json": empty, "rerun.json": empty });
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout, "");
  assert.match(actual.stderr, /^original report "absent\*\.json" \(read\): Error: .*ENOENT/);
});

test("input failures identify side, literal filename and stage; original failure takes precedence", () => {
  const empty = bytes(report([]));
  for (const [args, inputs, side, stage, message] of [
    [["missing-original.json", "missing-rerun.json"], {}, "original", "read", /ENOENT/],
    [["bad-original.json", "missing-rerun.json"], { "bad-original.json": Buffer.from("{") },
      "original", "decode", /SyntaxError: Report must contain one complete JSON document\./],
    [["original.json", "missing-rerun.json"], { "original.json": empty }, "rerun", "read", /ENOENT/],
    [["original.json", "bad-rerun.json"], { "original.json": empty, "bad-rerun.json": Buffer.from([0xc3, 0x28]) },
      "rerun", "decode", /TypeError: Report must contain valid UTF-8\./],
    [["original.json", "bad-count.json"], { "original.json": empty, "bad-count.json": bytes({ ...report([]), total: 1 }) },
      "rerun", "decode", /RangeError: total must equal the number of results/],
  ]) {
    const actual = run(args, inputs);
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout, "");
    const file = args[side === "original" ? 0 : 1];
    assert.ok(actual.stderr.startsWith(side + " report " + JSON.stringify(file) + " (" + stage + "): "));
    assert.match(actual.stderr, message);
    assert.equal(actual.stderr.split("\n").length, 2);
  }
});

test("invalid argument forms return usage before any input read", () => {
  for (const args of [[], ["missing.json"], ["original", "rerun", "--mappings"],
    ["original", "rerun", "extra.json"], ["original", "rerun", "--other", "map"],
    ["--mappings", "map", "original", "rerun"], ["original", "rerun", "--mappings=map"],
    ["original", "rerun", "--mappings", "map", "extra"],
    ["original", "rerun", "--mappings", "map", "--mappings", "other"],
  ]) {
    const actual = run(args, {}, { observe: true });
    assertInputReads(actual, []);
    assert.equal(actual.status, 2);
    assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, "Usage: node compare-address-reports.js ORIGINAL RERUN [--mappings MAPPING_FILE]\n");
  }
});

test("empty mappings equal no option, including BOM and literal filename positions", () => {
  const empty = bytes(report([]));
  for (const args of [["--help", "-", "--mappings", "--"],
    ["--mappings", "--", "--mappings", "literal*.json"],
    ["./original [x].json", "rerun with spaces.json", "--mappings", "./mapping [x].json"],
  ]) {
    const inputs = { [args[0]]: empty, [args[1]]: empty, [args[3]]: Buffer.from("\uFEFF[]\r\n") };
    assertResult(run(args, inputs), { rows: [], counts: zeroCounts });
  }
  const original = report([failure("unique"), success("duplicate"), success("duplicate")]);
  const rerun = report([success("unique"), success("duplicate")]);
  const inputs = { original: bytes(original), rerun: bytes(rerun), mapping: bytes([]) };
  const automatic = run(["original", "rerun"], inputs);
  const mapped = run(["original", "rerun", "--mappings", "mapping"], inputs);
  assert.equal(automatic.status, 0);
  assert.equal(mapped.status, 0);
  assert.equal(mapped.stderr, "");
  assert.equal(mapped.stdout, automatic.stdout);
});

test("BOM mappings accept ignored metadata without path reads; duplicate leftovers stay ambiguous", () => {
  const original = report([success("duplicate", "same"), failure("fixed"), success("duplicate", "same")]);
  const rerun = report([success("duplicate", "same"), success("fixed"), success("duplicate", "same")]);
  const actual = run(["original", "rerun", "--mappings", "mapping.json"], {
    original: bytes(original), rerun: bytes(rerun),
    "mapping.json": Buffer.from('﻿[{"originalPosition":1,"rerunPosition":3,"note":"ignored FEFF: \uFEFF","file":"never-open-this"}]'),
  }, { observe: true });
  assertResult(actual, { rows: [
    { original: original.results[0], rerun: rerun.results[2], basis: "explicit",
      kind: "success-same", ambiguous: false, pathChanged: false, positionChanged: true },
    { original: original.results[1], rerun: rerun.results[1], basis: "unique-exact-path",
      kind: "failure-to-success", ambiguous: false, pathChanged: false, positionChanged: false },
    { original: original.results[2], rerun: null, basis: null, kind: "original-only", ambiguous: true },
    { original: null, rerun: rerun.results[0], basis: null, kind: "rerun-only", ambiguous: true },
  ], counts: { ...zeroCounts, paired: 2, originalOnly: 1, rerunOnly: 1, ambiguousOccurrences: 2,
    "failure-to-success": 1, "success-same": 1 } });
  assertInputReads(actual, ["original", "rerun", "mapping.json"]);
});

test("explicit priority is not preempted by automatic CLI matching", () => {
  const original = report([success("a"), success("b")]);
  const rerun = report([success("a"), success("b")]);
  assertResult(run(["original", "rerun", "--mappings", "mapping.json"], {
    original: bytes(original), rerun: bytes(rerun),
    "mapping.json": bytes([{ originalPosition: 1, rerunPosition: 2 }]),
  }), { rows: [
    { original: original.results[0], rerun: rerun.results[1], basis: "explicit",
      kind: "success-same", ambiguous: false, pathChanged: true, positionChanged: true },
    { original: original.results[1], rerun: null, basis: null, kind: "original-only", ambiguous: false },
    { original: null, rerun: rerun.results[0], basis: null, kind: "rerun-only", ambiguous: false },
  ], counts: { ...zeroCounts, paired: 1, originalOnly: 1, rerunOnly: 1, "success-same": 1 } });
});

test("mapping byte and container refusals are atomic and identify the decode boundary", () => {
  const empty = bytes(report([]));
  for (const [content, message] of [
    [Buffer.from([0xc3, 0x28]), "TypeError: Mappings must contain valid UTF-8."],
    ...["", " ", "[", "[] {}", "\uFEFF\uFEFF[]"].map((s) => [Buffer.from(s), "SyntaxError: Mappings must contain one complete JSON document."]),
    ...[{}, null].map((v) => [bytes(v), "TypeError: Mappings must be an array"]),
    ...[[null], [[]], [true]].map((v) => [bytes(v), "TypeError: mappings[0] must be an object"]),
    [bytes([{}, null]), "TypeError: mappings[1] must be an object"],
  ]) {
    assertMappingError(run(["original", "rerun", "--mappings", "mapping.json"], {
      original: empty, rerun: empty, "mapping.json": content,
    }), "decode", message);
  }
});

test("owner position and one-to-one refusals keep their messages without repair or partial output", () => {
  const saved = bytes(report([success("a"), success("b")]));
  const pair = (originalPosition, rerunPosition) => ({ originalPosition, rerunPosition });
  const positionMessage = "RangeError: Mapping positions must identify an occurrence in each accepted report.";
  const conflictMessage = "RangeError: Each occurrence may have only one explicit counterpart. Remove the conflicting mapping first.";
  for (const [mappings, message] of [
    ...[[{}], [{ originalPosition: 1 }], [pair(1, "1")], [pair(0, 1)], [pair(1.5, 1)],
      [pair(3, 1)], [pair(1, 3)], [pair(1, 1), pair(2, null)]].map((v) => [v, positionMessage]),
    ...[[pair(1, 1), pair(1, 2)], [pair(1, 1), pair(2, 1)],
      [pair(1, 1), pair(1, 1)]].map((v) => [v, conflictMessage]),
  ]) {
    assertMappingError(run(["original", "rerun", "--mappings", "mapping.json"], {
      original: saved, rerun: saved, "mapping.json": bytes(mappings),
    }), "compare", message);
  }
});

test("observed reads stop after the first original, rerun or mapping failure", () => {
  const empty = bytes(report([]));
  for (const [inputs, reads, prefix] of [
    [{}, ["original"], 'original report "original" (read): '],
    [{ original: Buffer.from("{") }, ["original"], 'original report "original" (decode): '],
    [{ original: empty }, ["original", "rerun"], 'rerun report "rerun" (read): '],
    [{ original: empty, rerun: Buffer.from("{") }, ["original", "rerun"], 'rerun report "rerun" (decode): '],
    [{ original: empty, rerun: empty }, ["original", "rerun", "mapping.json"], 'mapping file "mapping.json" (read): '],
    [{ original: empty, rerun: empty, "mapping.json": Buffer.from("{") },
      ["original", "rerun", "mapping.json"], 'mapping file "mapping.json" (decode): '],
  ]) {
    const actual = run(["original", "rerun", "--mappings", "mapping.json"], inputs, { observe: true });
    assertInputReads(actual, reads);
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout, "");
    assert.ok(actual.stderr.startsWith(prefix));
    assert.equal(actual.stderr.split("\n").length, 2);
  }
  for (const mapping of ["-", "absent*.json", 'missing \"[map].json']) {
    const actual = run(["original", "rerun", "--mappings", mapping], {
      original: empty, rerun: empty, "absent-match.json": bytes([]),
    }, { observe: true });
    assertInputReads(actual, ["original", "rerun", mapping]);
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout, "");
    assert.ok(actual.stderr.startsWith("mapping file " + JSON.stringify(mapping) + " (read): Error: "));
    assert.match(actual.stderr, /ENOENT/);
  }
});

test("Linux /dev/full output-sink failure is not reported as an input refusal", { skip: process.platform !== "linux" }, () => {
  const fd = openSync("/dev/full", "w");
  try {
    const empty = bytes(report([]));
    const actual = run(["original", "rerun", "--mappings", "mapping.json"], {
      original: empty, rerun: empty, "mapping.json": bytes([]),
    }, { stdoutFd: fd });
    assert.equal(actual.status, 1);
    assert.match(actual.stderr, /ENOSPC/);
    assert.doesNotMatch(actual.stderr, /(?:mapping file|original report|rerun report) .*\((?:read|decode|compare)\):/);
  } finally {
    closeSync(fd);
  }
});
