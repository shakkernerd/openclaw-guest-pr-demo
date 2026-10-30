"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const command = join(__dirname, "validate-address-reports.js");
const bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
const zero = { total: 0, succeeded: 0, failed: 0, results: [] };
const validResult = (position, file, total = 0, succeeded = 0, failed = 0) =>
  ({ position, file, ok: true, total, succeeded, failed });
const decodeResult = (position, file, name, message) =>
  ({ position, file, ok: false, error: { stage: "decode", name, message } });

function run(args, inputs = {}) {
  // Keep all test-owned files inside this project; do not touch report drafts.
  const directory = mkdtempSync(join(__dirname, ".validate-address-reports-test-"));
  try {
    for (const [file, content] of Object.entries(inputs)) {
      writeFileSync(join(directory, file), content);
    }
    const entries = readdirSync(directory);
    const before = entries.map((file) => readFileSync(join(directory, file)));
    const actual = spawnSync(process.execPath, [command, ...args], {
      cwd: directory, encoding: "utf8", timeout: 10000,
      // Valid stdin must never supply a missing filename or replace its bytes.
      input: JSON.stringify(zero),
    });
    assert.ifError(actual.error);
    assert.equal(actual.signal, null);
    assert.deepEqual(readdirSync(directory), entries);
    entries.forEach((file, index) => {
      assert.deepEqual(readFileSync(join(directory, file)), before[index]);
    });
    return actual;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertSummary(actual, expected, status) {
  assert.equal(actual.status, status);
  assert.equal(actual.stderr, "");
  assert.equal(actual.stdout, JSON.stringify(expected) + "\n");
}

function assertReadError(result, position, file) {
  assert.equal(result.error.name, "Error");
  assert.match(result.error.message, /ENOENT/);
  assert.ok(result.error.message.includes(file));
  assert.deepEqual(result, {
    position, file, ok: false,
    error: { stage: "read", name: "Error", message: result.error.message },
  });
}

test("no filenames produces one empty JSON summary and exit 2, ignoring stdin", () => {
  assertSummary(run([]), { total: 0, valid: 0, invalid: 0, results: [] }, 2);
});

test("one or several structurally valid reports exit 0, including recorded failures and repeats", () => {
  const inputs = {
    "success.json": readFileSync(join(__dirname, "saved-batch-report-fixtures", "success-report.json")),
    "mixed.json": readFileSync(join(__dirname, "saved-batch-report-fixtures", "mixed-report.json")),
    "zero.json": bytes(zero),
    "failed.json": bytes({
      total: 1, succeeded: 0, failed: 1,
      results: [{ position: 1, file: "never-open-this-draft.json", ok: false,
        error: { stage: "read", name: "", message: "" } }],
    }),
  };
  assertSummary(run(["mixed.json"], inputs), {
    total: 1, valid: 1, invalid: 0, results: [validResult(1, "mixed.json", 6, 2, 4)],
  }, 0);
  assertSummary(run(["mixed.json", "success.json", "failed.json", "zero.json", "mixed.json"], inputs), {
    total: 5, valid: 5, invalid: 0,
    results: [validResult(1, "mixed.json", 6, 2, 4), validResult(2, "success.json", 3, 3, 0),
      validResult(3, "failed.json", 1, 0, 1), validResult(4, "zero.json"), validResult(5, "mixed.json", 6, 2, 4)],
  }, 0);
});

test("read, UTF-8, JSON and structure errors do not stop later files or collapse repeats", () => {
  const args = ["missing.json", "utf8.json", "./mixed.json", "json.json", "counts.json", "./mixed.json", "zero.json", "missing.json"];
  const actual = run(args, {
    "utf8.json": Buffer.from([0xc3, 0x28]),
    "mixed.json": readFileSync(join(__dirname, "saved-batch-report-fixtures", "mixed-report.json")),
    "json.json": Buffer.from("{}{}"),
    "counts.json": bytes({ ...zero, total: 1 }),
    "zero.json": bytes(zero),
  });
  const summary = JSON.parse(actual.stdout);
  assertReadError(summary.results[0], 1, "missing.json");
  assertReadError(summary.results[7], 8, "missing.json");
  assertSummary(actual, {
    total: 8, valid: 3, invalid: 5,
    results: [summary.results[0],
      decodeResult(2, "utf8.json", "TypeError", "Report must contain valid UTF-8."),
      validResult(3, "./mixed.json", 6, 2, 4),
      decodeResult(4, "json.json", "SyntaxError", "Report must contain one complete JSON document."),
      decodeResult(5, "counts.json", "RangeError", "total must equal the number of results"),
      validResult(6, "./mixed.json", 6, 2, 4), validResult(7, "zero.json"), summary.results[7]],
  }, 1);
});

test("all invalid inputs still produce every verdict and exit 1", () => {
  const actual = run(["empty.json", "missing.json", "empty.json"], { "empty.json": Buffer.alloc(0) });
  const summary = JSON.parse(actual.stdout);
  assertReadError(summary.results[1], 2, "missing.json");
  assertSummary(actual, { total: 3, valid: 0, invalid: 3, results: [
    decodeResult(1, "empty.json", "SyntaxError", "Report must contain one complete JSON document."),
    summary.results[1],
    decodeResult(3, "empty.json", "SyntaxError", "Report must contain one complete JSON document."),
  ] }, 1);
});

test("arguments are literal cwd-relative filenames, never options, globs, or stdin", () => {
  const args = ["--help", "-", "--", "./report with spaces.json", "literal*.json", "line\nΩ.json", "--help"];
  const inputs = Object.fromEntries(args.map((file) => [file, bytes(zero)]));
  assertSummary(run(args, inputs), { total: args.length, valid: args.length, invalid: 0,
    results: args.map((file, index) => validResult(index + 1, file)),
  }, 0);
  const actual = run(["-", "", "--help"]);
  const summary = JSON.parse(actual.stdout);
  ["-", "", "--help"].forEach((file, index) => assertReadError(summary.results[index], index + 1, file));
  assertSummary(actual, { total: 3, valid: 0, invalid: 3, results: summary.results }, 1);
});

test("shared acceptance preserves BOM, literal saved strings, unknown fields and CSV-only refusals", () => {
  const report = {
    total: 1, succeeded: 1, failed: 0, extra: "not interpreted",
    results: [{ position: 1, file: "absent-draft.json", ok: true,
      formatted: "\ufeff Ω\r\n  saved \ud800 text\r", extra: true }],
  };
  assertSummary(run(["bom.json", "surrogate.json"], {
    "bom.json": Buffer.concat([Buffer.from("\ufeff\r\n\t "), bytes(report)]),
    "surrogate.json": bytes(report),
  }), { total: 2, valid: 2, invalid: 0, results: [
    validResult(1, "bom.json", 1, 1, 0), validResult(2, "surrogate.json", 1, 1, 0),
  ] }, 0);
});
