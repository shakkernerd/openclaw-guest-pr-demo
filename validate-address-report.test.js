"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const command = join(__dirname, "validate-address-report.js");
const bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
const zero = { total: 0, succeeded: 0, failed: 0, results: [] };
const success = () => ({
  total: 1, succeeded: 1, failed: 0,
  results: [{ position: 1, file: "never-open-this-draft.json", ok: true, formatted: "" }],
});

function run(args, inputs = {}) {
  const directory = mkdtempSync(join(tmpdir(), "validate-address-report-"));
  try {
    for (const [file, content] of Object.entries(inputs)) {
      writeFileSync(join(directory, file), content);
    }
    const entries = readdirSync(directory);
    const before = entries.map((file) => readFileSync(join(directory, file)));
    const actual = spawnSync(process.execPath, [command, ...args], {
      cwd: directory, encoding: "utf8", timeout: 10000,
      // Valid stdin must never supply or override the explicitly named file.
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

function assertVerdict(actual, expected, status) {
  assert.equal(actual.status, status);
  assert.equal(actual.stderr, "");
  assert.equal(actual.stdout, JSON.stringify(expected) + "\n");
}

test("retained success and mixed reports validate without their original drafts", async (t) => {
  for (const [file, size, hash, total, succeeded, failed] of [
    ["success-report.json", 294, "0c4366856cab2d112cd53c68b95e518b57829a7dae679f241e4f3b891a6c1a6e", 3, 3, 0],
    ["mixed-report.json", 845, "851b8250e3f553850ea5bacf24d9dd4c94311ed45b8ba1bc58a5f03aade52dea", 6, 2, 4],
  ]) {
    await t.test(file, () => {
      const input = readFileSync(join(__dirname, "saved-batch-report-fixtures", file));
      assert.equal(input.length, size);
      assert.equal(createHash("sha256").update(input).digest("hex"), hash);
      assertVerdict(run([file], { [file]: input }), { file, ok: true, total, succeeded, failed }, 0);
    });
  }
});

test("empty and all-failure reports are successful validations", () => {
  const file = "report.json";
  for (const report of [zero, {
    total: 1, succeeded: 0, failed: 1,
    results: [{ position: 1, file: "absent-draft.json", ok: false,
      error: { stage: "read", name: "", message: "" } }],
  }]) {
    assertVerdict(run([file], { [file]: bytes(report) }), {
      file, ok: true, total: report.total, succeeded: report.succeeded, failed: report.failed,
    }, 0);
  }
});

test("BOM, literal strings and unknown fields use report rules, not draft/formatter rules", () => {
  const file = "report.json";
  const report = {
    total: 2, succeeded: 2, failed: 0, extra: { untouched: true },
    results: [
      { position: 1, file: "absent-draft.json", ok: true, formatted: "", error: null },
      { position: 2, file: "absent-draft.json", ok: true, formatted: "\ufeff Ω e\u0301\r\n  <not-html>\r" },
    ],
  };
  const input = Buffer.concat([Buffer.from("\ufeff\r\n\t "), bytes(report), Buffer.from("\r\n")]);
  assertVerdict(run([file], { [file]: input }), { file, ok: true, total: 2, succeeded: 2, failed: 0 }, 0);
});

test("representative decoder refusals produce compact errors and exit 1", async (t) => {
  const badCount = { ...success(), succeeded: 0, failed: 1 };
  const badRow = success();
  badRow.results[0].position = 2;
  for (const [label, input, name, message] of [
    ["UTF-8", Buffer.from([0xc3, 0x28]), "TypeError", "Report must contain valid UTF-8."],
    ["empty", Buffer.alloc(0), "SyntaxError", "Report must contain one complete JSON document."],
    ["JSON", Buffer.from('{"total":'), "SyntaxError", "Report must contain one complete JSON document."],
    ["two documents", Buffer.from("{}{}"), "SyntaxError", "Report must contain one complete JSON document."],
    ["count", bytes(badCount), "RangeError", "succeeded and failed must match the result outcomes"],
    ["row", bytes(badRow), "RangeError", "results[0].position must equal 1"],
  ]) {
    await t.test(label, () => {
      const file = "invalid.json";
      assertVerdict(run([file], { [file]: input }), {
        file, ok: false, error: { stage: "decode", name, message },
      }, 1);
    });
  }
});

test("an unreadable named report produces a read error, not a stdin fallback", () => {
  const file = "missing-report.json";
  const actual = run([file]);
  const verdict = JSON.parse(actual.stdout);
  assert.equal(verdict.error.name, "Error");
  assert.match(verdict.error.message, /ENOENT/);
  assert.ok(verdict.error.message.includes(file));
  assertVerdict(actual, { file, ok: false, error: {
    stage: "read", name: "Error", message: verdict.error.message,
  } }, 1);
});

test("zero or multiple arguments print usage only, ignoring stdin", () => {
  for (const args of [[], ["first.json", "second.json"]]) {
    const actual = run(args);
    assert.equal(actual.status, 2);
    assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, "Usage: node validate-address-report.js FILE\n");
  }
});

test("one literal filename is resolved from cwd and retained exactly", () => {
  for (const file of ["-", "--", "--help", "./report with spaces.json", "literal*.json"]) {
    assertVerdict(run([file], { [file]: bytes(zero) }), {
      file, ok: true, total: 0, succeeded: 0, failed: 0,
    }, 0);
  }
});
