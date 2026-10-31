"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const command = join(__dirname, "summarize-address-report.js");
const codec = join(__dirname, "saved-batch-report.js");
const summary = join(__dirname, "saved-batch-summary.js");
const bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
const zero = { total: 0, succeeded: 0, failed: 0, results: [] };
const emptySummary = "Total: 0\nSuccesses: 0\nFailures: 0\nFailure stages:\n  read: 0\n  decode: 0\n  format: 0\n";
const mixedSummary = "Total: 6\nSuccesses: 2\nFailures: 4\nFailure stages:\n  read: 1\n  decode: 1\n  format: 2\n";
const usage = "Usage: node summarize-address-report.js [FILE]\n";

function run(args, { stdin = Buffer.alloc(0), files = {}, guard } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "summarize-address-report-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(directory, file), content);
    }
    const nodeArgs = [];
    if (guard !== undefined) {
      writeFileSync(join(directory, "guard.cjs"), guard);
      nodeArgs.push("--require", join(directory, "guard.cjs"));
    }
    const entries = readdirSync(directory);
    const before = entries.map((file) => readFileSync(join(directory, file)));
    const actual = spawnSync(process.execPath, [...nodeArgs, command, ...args], {
      cwd: directory, encoding: "utf8", input: stdin, timeout: 10000,
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

function assertSummary(actual, expected) {
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(actual.stderr, "");
  assert.equal(actual.stdout, expected);
}

test("stdin and one named file summarize retained reports, counting duplicate occurrences", () => {
  for (const [file, expected] of [
    ["mixed-report.json", mixedSummary],
    ["success-report.json", "Total: 3\nSuccesses: 3\nFailures: 0\nFailure stages:\n  read: 0\n  decode: 0\n  format: 0\n"],
  ]) {
    const input = readFileSync(join(__dirname, "saved-batch-report-fixtures", file));
    assertSummary(run([], { stdin: input }), expected);
    // Invalid stdin must not override or supplement the explicitly named file.
    assertSummary(run([file], { files: { [file]: input }, stdin: "not JSON" }), expected);
  }
});

test("zero and all-failure reports exit 0, with every stage printed", () => {
  assertSummary(run([], { stdin: bytes(zero) }), emptySummary);
  const results = ["read", "read", "decode", "format", "format", "format"].map((stage, index) => ({
    position: index + 1, file: "same-absent-draft.json", ok: false,
    error: { stage, name: "", message: "" },
  }));
  assertSummary(run([], { stdin: bytes({ total: 6, succeeded: 0, failed: 6, results }) }),
    "Total: 6\nSuccesses: 0\nFailures: 6\nFailure stages:\n  read: 2\n  decode: 1\n  format: 3\n");
});

test("BOM, literal strings, unknown fields and CSV-incompatible strings keep decoder semantics", () => {
  const report = {
    total: 3, succeeded: 2, failed: 1, extra: { untouched: true },
    results: [
      { position: 1, file: "", ok: true, formatted: "", error: { stage: "read" } },
      { position: 2, file: "absent\r\n\ufeff Ω draft.json", ok: true,
        formatted: "\ufeff Ω e\u0301\r\n  <not-html>\r \ud800", extra: ["saved"] },
      { position: 3, file: "absent-draft.json", ok: false, formatted: { unknown: true },
        error: { stage: "decode", name: "", message: "\r\n\ufeff\ud800", extra: null } },
    ],
  };
  const input = Buffer.concat([Buffer.from("\ufeff\r\n\t "), bytes(report), Buffer.from("\r\n")]);
  const expected = "Total: 3\nSuccesses: 2\nFailures: 1\nFailure stages:\n  read: 0\n  decode: 1\n  format: 0\n";
  assertSummary(run([], { stdin: input }), expected);
  assertSummary(run(["literal.json"], { files: { "literal.json": input } }), expected);
});

test("representative invalid UTF-8, JSON and structure fail identically through both inputs", async (t) => {
  for (const [label, input, message] of [
    ["UTF-8", Buffer.from([0xc3, 0x28]), "TypeError: Report must contain valid UTF-8."],
    ["empty", Buffer.alloc(0), "SyntaxError: Report must contain one complete JSON document."],
    ["truncated JSON", Buffer.from('{"total":'), "SyntaxError: Report must contain one complete JSON document."],
    ["two documents", Buffer.from("{}{}"), "SyntaxError: Report must contain one complete JSON document."],
    ["draft, not report", bytes([]), "TypeError: Report must be an object"],
    ["unsafe total", bytes({ ...zero, total: Number.MAX_SAFE_INTEGER + 1 }), "TypeError: total must be a safe nonnegative integer"],
    ["length", bytes({ ...zero, total: 1 }), "RangeError: total must equal the number of results"],
    ["outcomes", bytes({ ...zero, succeeded: 1 }), "RangeError: succeeded and failed must match the result outcomes"],
    ["position", bytes({ total: 1, succeeded: 1, failed: 0,
      results: [{ position: 2, file: "", ok: true, formatted: "" }] }), "RangeError: results[0].position must equal 1"],
    ["stage", bytes({ total: 1, succeeded: 0, failed: 1,
      results: [{ position: 1, file: "", ok: false, error: { stage: "other", name: "", message: "" } }] }),
      "TypeError: results[0].error.stage must be read, decode, or format"],
  ]) {
    await t.test(label, () => {
      for (const [args, options, source] of [
        [[], { stdin: input }, "stdin"],
        [["invalid.json"], { files: { "invalid.json": input }, stdin: bytes(zero) }, 'report "invalid.json"'],
      ]) {
        const actual = run(args, options);
        assert.equal(actual.status, 1);
        assert.equal(actual.stdout, "");
        assert.equal(actual.stderr, source + " (decode): " + message + "\n");
      }
    });
  }
});

test("missing named input is a read error, never a fallback to valid stdin", () => {
  const actual = run(["missing.json"], { stdin: bytes(zero) });
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout, "");
  assert.match(actual.stderr, /^report "missing.json" \(read\): Error: .*ENOENT.*missing\.json.*\n$/);
});

test("one literal path uses cwd; only bare --help is reserved", () => {
  for (const file of ["-", "--", "./--help", "--unknown", "./report with spaces.json", "literal*.json"]) {
    assertSummary(run([file], { files: { [file]: bytes(zero) }, stdin: "not JSON" }), emptySummary);
  }
});

// Instrument real child processes without changing production modules. Prohibit
// other filesystem reads/imports and assert the selected input is read once.
// Match module leaf names, not incidental substrings in checkout directories.
function readGuard(input, expectedReads) {
  return '"use strict";\n' +
    'const assert = require("node:assert/strict");\n' +
    'const fs = require("node:fs");\n' +
    'const Module = require("node:module");\n' +
    'const { basename } = require("node:path");\n' +
    'const load = Module._load;\n' +
    'Module._load = function (id, ...args) {\n' +
    '  assert.ok(!/delivery-address|format-address-drafts/.test(basename(id)), "draft/formatter import: " + id);\n' +
    '  return load.call(this, id, ...args);\n' +
    '};\n' +
    'const read = fs.readFileSync;\n' +
    'let reads = 0;\n' +
    'fs.readFileSync = function (file, ...args) {\n' +
    '  if (!' + JSON.stringify([command, codec, summary]) + '.includes(file)) {\n' +
    '    reads += 1;\n' +
    '    assert.equal(file, ' + JSON.stringify(input) + ', "unexpected read");\n' +
    '  }\n' +
    '  return read.call(this, file, ...args);\n' +
    '};\n' +
    'process.on("exit", () => assert.equal(reads, ' + expectedReads + '));\n';
}

test("only the chosen report is read, not occurrence paths or draft/formatter modules", () => {
  const report = bytes({ total: 1, succeeded: 1, failed: 0,
    results: [{ position: 1, file: "DO-NOT-OPEN.json", ok: true, formatted: "\r\n" }] });
  const expected = "Total: 1\nSuccesses: 1\nFailures: 0\nFailure stages:\n  read: 0\n  decode: 0\n  format: 0\n";
  const files = { "report.json": report, "DO-NOT-OPEN.json": "not a draft" };
  assertSummary(run(["report.json"], { files, guard: readGuard("report.json", 1) }), expected);
  assertSummary(run([], { stdin: report, files, guard: readGuard(0, 1) }), expected);
});

test("preload guard rejects real draft and formatter modules", () => {
  for (const file of ["delivery-address.js", "delivery-address-draft.js", "format-address-drafts.js"]) {
    // Resolve actual files without executing them; the child must reject the load.
    const modulePath = require.resolve("./" + file);
    const guard = readGuard(null, 0) + "require(" + JSON.stringify(modulePath) + ");";
    const actual = run(["--help"], { guard });
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout, "");
    assert.ok(actual.stderr.includes("AssertionError [ERR_ASSERTION]: draft/formatter import: " + modulePath), actual.stderr);
  }
});

test("help exits 0 and usage errors exit 2 before any input read", () => {
  const guard = readGuard(null, 0);
  const help = run(["--help"], { stdin: "not JSON", files: { "--help": "not JSON" }, guard });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.ok(help.stdout.startsWith(usage));
  for (const phrase of ["stdin to EOF", "literal path", "./--help", "read/decode/format", "Exit 0:", "1:", "2:", "memory"]) {
    assert.ok(help.stdout.includes(phrase), phrase);
  }
  for (const args of [["first.json", "second.json"], ["--help", "extra.json"]]) {
    const actual = run(args, { stdin: bytes(zero), guard });
    assert.equal(actual.status, 2);
    assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, usage);
  }
});
