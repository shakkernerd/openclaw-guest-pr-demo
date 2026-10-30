"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
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

function run(args, inputs = {}) {
  const directory = mkdtempSync(join(tmpdir(), "compare-address-reports-"));
  try {
    for (const [file, content] of Object.entries(inputs)) writeFileSync(join(directory, file), content);
    const entries = readdirSync(directory);
    const before = entries.map((file) => readFileSync(join(directory, file)));
    const actual = spawnSync(process.execPath, [command, ...args], {
      cwd: directory, encoding: "utf8", timeout: 10000,
      // Stdin is never an input, even when it contains a valid report.
      input: JSON.stringify(report([])),
    });
    assert.ifError(actual.error);
    assert.equal(actual.signal, null);
    assert.deepEqual(readdirSync(directory), entries);
    entries.forEach((file, index) => assert.deepEqual(readFileSync(join(directory, file)), before[index]));
    return actual;
  } finally {
    // This newly created directory is the only cleanup target, never retained proof.
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertResult(actual, expected) {
  assert.equal(actual.status, 0);
  assert.equal(actual.stderr, "");
  assert.equal(actual.stdout, JSON.stringify(expected) + "\n");
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
  for (const args of [["--help", "literal*.json"], ["-", "--"], ["./report with spaces.json", "rerun.json"]]) {
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

test("incorrect argument counts return usage only before reading any input", () => {
  for (const args of [[], ["missing.json"], ["missing.json", "also-missing.json", "extra.json"]]) {
    const actual = run(args);
    assert.equal(actual.status, 2);
    assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, "Usage: node compare-address-reports.js ORIGINAL RERUN\n");
  }
});
