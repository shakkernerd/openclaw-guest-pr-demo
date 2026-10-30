"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const command = join(__dirname, "summarize-address-report.js");
const bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
const zero = { total: 0, succeeded: 0, failed: 0, results: [] };
const heading = "Recorded saved-report data (textual projection)\n";

function run(args, inputs = {}) {
  const directory = mkdtempSync(join(tmpdir(), "summarize-address-report-"));
  try {
    for (const [file, content] of Object.entries(inputs)) {
      writeFileSync(join(directory, file), content);
    }
    const entries = readdirSync(directory);
    const before = entries.map((file) => readFileSync(join(directory, file)));
    const actual = spawnSync(process.execPath, [command, ...args], {
      cwd: directory, encoding: "utf8", timeout: 10000,
      // Stdin must not supply or override the literal filename.
      input: JSON.stringify(zero),
    });
    assert.ifError(actual.error);
    assert.equal(actual.signal, null);
    assert.deepEqual(readdirSync(directory), entries, "no output files");
    entries.forEach((file, index) => {
      assert.deepEqual(readFileSync(join(directory, file)), before[index], "input bytes unchanged");
    });
    return actual;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertAsciiLines(text) {
  assert.match(text, /^[\x20-\x7e\n]*$/);
  assert.ok(text.endsWith("\n"));
  assert.ok(!text.endsWith("\n\n"), "exactly one final LF");
}

function assertSuccess(actual, expected) {
  assert.equal(actual.status, 0);
  assert.equal(actual.stderr, "");
  assertAsciiLines(actual.stdout);
  if (expected !== undefined) assert.equal(actual.stdout, expected);
}

function assertFailure(actual, stage) {
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout, "");
  assertAsciiLines(actual.stderr);
  assert.equal(actual.stderr.split("\n").length, 2, "one diagnostic line");
  assert.ok(actual.stderr.startsWith("Could not summarize saved report: file="));
  assert.ok(actual.stderr.includes(' stage="' + stage + '" name='));
}

test("mixed recorded outcomes preserve every position, duplicate and complete error tuple", () => {
  const report = { total: 5, succeeded: 2, failed: 3, results: [
    { position: 1, file: "absent-draft.json", ok: true, formatted: "Saved\ntext" },
    { position: 2, file: "../unopened.json", ok: false, error: { stage: "read", name: "Error", message: "Recorded read failure" } },
    { position: 3, file: "", ok: false, error: { stage: "decode", name: "", message: "" } },
    { position: 4, file: "blank.json", ok: false, error: { stage: "format", name: "RangeError", message: "lines[1] must not be blank" } },
    { position: 5, file: "absent-draft.json", ok: true, formatted: "Saved\ntext" },
  ] };
  assertSuccess(run(["report.json"], { "report.json": bytes(report) }), heading +
    'Report: "report.json"\n' +
    'Total: 5; succeeded: 2; failed: 3\n' +
    '1. status=success file="absent-draft.json"\n' +
    '   formatted="Saved\\ntext"\n' +
    '2. status=failure file="../unopened.json"\n' +
    '   error: stage="read" name="Error" message="Recorded read failure"\n' +
    '3. status=failure file=""\n' +
    '   error: stage="decode" name="" message=""\n' +
    '4. status=failure file="blank.json"\n' +
    '   error: stage="format" name="RangeError" message="lines[1] must not be blank"\n' +
    '5. status=success file="absent-draft.json"\n' +
    '   formatted="Saved\\ntext"\n');
});

test("empty, all-success and all-failure reports exit zero, including empty values", () => {
  for (const [report, counts, rows] of [
    [zero, "0; succeeded: 0; failed: 0", ""],
    [{ total: 1, succeeded: 1, failed: 0, results: [
      { position: 1, file: "", ok: true, formatted: "" },
    ] }, "1; succeeded: 1; failed: 0", '1. status=success file=""\n   formatted=""\n'],
    [{ total: 1, succeeded: 0, failed: 1, results: [
      { position: 1, file: "absent.json", ok: false, error: { stage: "format", name: "", message: "" } },
    ] }, "1; succeeded: 0; failed: 1", '1. status=failure file="absent.json"\n   error: stage="format" name="" message=""\n'],
  ]) {
    assertSuccess(run(["report.json"], { "report.json": bytes(report) }),
      heading + 'Report: "report.json"\nTotal: ' + counts + "\n" + rows);
  }
});

test("ASCII JSON literals round-trip controls, Unicode and lone surrogates in every free string field", () => {
  const literal = '  \ufeffΩ e\u0301\r\n\n\t"\\ literal \\u03b1 <tag> =+@-' +
    String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)) +
    '\u007f\u0080\u009b\u2028\u2029\ud83d\ude80\ud800X\udfff  ';
  const report = {
    total: 2, succeeded: 1, failed: 1, extra: { untouched: [null, literal] },
    results: [
      { position: 1, file: literal, ok: true, formatted: literal, error: { unknown: true } },
      { position: 2, file: literal, ok: false, formatted: null, extra: 42,
        error: { stage: "decode", name: literal, message: literal, extra: [1, 2] } },
    ],
  };
  // Preserve encoding BOM, layout, unknown fields, and original JSON escape spelling.
  const input = Buffer.from("\ufeff\r\n\t " + JSON.stringify(report, null, 2).replace(/Ω/g, "\\u03A9") + "\r\n");
  const actual = run(["report.json"], { "report.json": input });
  assertSuccess(actual);
  const lines = actual.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 7);
  assert.equal(lines[2], "Total: 2; succeeded: 1; failed: 1");
  assert.equal(JSON.parse(lines[3].slice('1. status=success file='.length)), literal);
  assert.equal(JSON.parse(lines[4].slice('   formatted='.length)), literal);
  assert.equal(JSON.parse(lines[5].slice('2. status=failure file='.length)), literal);
  const tuple = lines[6].match(/"(?:[^"\\]|\\.)*"/g).map((value) => JSON.parse(value));
  assert.deepEqual(tuple, ["decode", literal, literal]);
  for (const escape of ["\\u0000", "\\u001b", "\\u007f", "\\u0080", "\\ufeff", "\\u03a9",
    "\\u0301", "\\u2028", "\\u2029", "\\ud83d\\ude80", "\\ud800X\\udfff"]) {
    assert.ok(actual.stdout.includes(escape), escape);
  }
  assert.ok(!actual.stdout.includes("untouched"), "unknown fields are not projected");
});

test("exactly one literal cwd-relative filename, not flags, globs or stdin", () => {
  for (const file of ["-", "--", "--help", "./report with spaces.json", "literal*.json", "line\nΩ\u001b.json"]) {
    const actual = run([file], { [file]: bytes(zero) });
    assertSuccess(actual);
    const lines = actual.stdout.split("\n");
    assert.equal(lines[0] + "\n", heading);
    assert.equal(JSON.parse(lines[1].slice("Report: ".length)), file);
    assert.equal(lines[2], "Total: 0; succeeded: 0; failed: 0");
    assert.equal(lines.length, 4);
  }
});

test("zero or multiple arguments exit two with usage only", () => {
  for (const args of [[], ["first.json", "second.json"], ["--", "report.json"]]) {
    const actual = run(args);
    assert.equal(actual.status, 2);
    assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, "Usage: node summarize-address-report.js FILE\n");
  }
});

test("unreadable literal paths exit one with escaped stderr and no stdin fallback", () => {
  for (const file of ["missing\nΩ\u001b.json", "--help", "-", ""]) {
    const actual = run([file]);
    assertFailure(actual, "read");
    const tuple = actual.stderr.match(/"(?:[^"\\]|\\.)*"/g).map((value) => JSON.parse(value));
    assert.equal(tuple.length, 4);
    assert.deepEqual(tuple.slice(0, 3), [file, "read", "Error"]);
    assert.match(tuple[3], /ENOENT/);
    assert.ok(tuple[3].includes(file));
  }
});

test("representative decoder failures emit no partial summary", async (t) => {
  const lateBadPosition = { total: 2, succeeded: 2, failed: 0, results: [
    { position: 1, file: "unopened.json", ok: true, formatted: "must not be printed" },
    { position: 3, file: "unopened.json", ok: true, formatted: "" },
  ] };
  // Comprehensive shape coverage remains in the unchanged shared-decoder suite.
  for (const [label, input, name, message] of [
    ["UTF-8", Buffer.from([0xc3, 0x28]), "TypeError", "Report must contain valid UTF-8."],
    ["empty", Buffer.alloc(0), "SyntaxError", "Report must contain one complete JSON document."],
    ["JSON", Buffer.from('{}{}'), "SyntaxError", "Report must contain one complete JSON document."],
    ["counts", bytes({ ...zero, failed: 1 }), "RangeError", "succeeded and failed must match the result outcomes"],
    ["late row", bytes(lateBadPosition), "RangeError", "results[1].position must equal 2"],
  ]) {
    await t.test(label, () => {
      const actual = run(["invalid.json"], { "invalid.json": input });
      assertFailure(actual, "decode");
      assert.equal(actual.stderr, 'Could not summarize saved report: file="invalid.json" stage="decode" name=' +
        JSON.stringify(name) + " message=" + JSON.stringify(message) + "\n");
    });
  }
});
