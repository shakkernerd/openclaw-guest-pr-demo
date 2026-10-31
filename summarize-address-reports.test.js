"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const command = join(__dirname, "summarize-address-reports.js");
const codec = join(__dirname, "saved-batch-report.js");
const helper = join(__dirname, "saved-batch-summary.js");
const fixture = (name) => readFileSync(join(__dirname, "saved-batch-report-fixtures", name));
const bytes = (value) => Buffer.from(JSON.stringify(value));
const zero = { total: 0, succeeded: 0, failed: 0, results: [] };
const empty = { total: 0, succeeded: 0, failed: 0, failureStages: { read: 0, decode: 0, format: 0 } };
const success = { total: 3, succeeded: 3, failed: 0, failureStages: { read: 0, decode: 0, format: 0 } };
const mixed = { total: 6, succeeded: 2, failed: 4, failureStages: { read: 1, decode: 1, format: 2 } };
const usage = "Usage: node summarize-address-reports.js FILE...\n";

function run(args, { files = {}, guard, stdin = bytes(zero) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "batch-test-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    const nodeArgs = [];
    if (guard !== undefined) {
      writeFileSync(join(directory, "guard.cjs"), guard);
      nodeArgs.push("--require", join(directory, "guard.cjs"));
    }
    const entries = readdirSync(directory);
    const before = entries.map((name) => readFileSync(join(directory, name)));
    const actual = spawnSync(process.execPath, [...nodeArgs, command, ...args], {
      cwd: directory, input: stdin, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(actual.error);
    assert.equal(actual.signal, null);
    assert.deepEqual(readdirSync(directory), entries);
    entries.forEach((name, index) => assert.deepEqual(readFileSync(join(directory, name)), before[index]));
    return actual;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function document(actual, status) {
  assert.equal(actual.status, status, actual.stderr);
  assert.equal(actual.stderr, "");
  const output = JSON.parse(actual.stdout);
  assert.equal(actual.stdout, JSON.stringify(output) + "\n");
  return output;
}

function valid(position, file, summary) { return { position, file, ok: true, summary }; }

// Real subprocesses: observe reads, including repeats, and raw-byte decoding in
// order. Any stdin, discovery, occurrence read, or formatter import fails.
// Match module leaf names, not incidental substrings in checkout directories.
function readGuard(events) {
  return `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const Module = require("node:module");
    const { basename } = require("node:path");
    const owner = require(${JSON.stringify(codec)});
    const decode = owner.savedBatchReportCodec.decode;
    const events = [];
    owner.savedBatchReportCodec = { decode(bytes) {
      assert.ok(Buffer.isBuffer(bytes), "raw input bytes required");
      events.push(["decode"]);
      return decode(bytes);
    } };
    const load = Module._load;
    Module._load = function(id, ...args) {
      assert.ok(!/delivery-address|format-address-drafts/.test(basename(id)), "draft/formatter import: " + id);
      return load.call(this, id, ...args);
    };
    fs.readdirSync = () => assert.fail("directory discovery");
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (!${JSON.stringify([command, codec, helper])}.includes(file)) events.push(["read", file]);
      return read.call(this, file, ...args);
    };
    process.on("exit", () => assert.deepEqual(events, ${JSON.stringify(events)}));
  `;
}

test("success, mixed and repeated report filenames retain order and count every occurrence", () => {
  const args = ["mixed.json", "success.json", "mixed.json"];
  const actual = run(args, {
    files: { "mixed.json": fixture("mixed-report.json"), "success.json": fixture("success-report.json") },
    stdin: "not JSON", guard: readGuard(args.flatMap((file) => [["read", file], ["decode"]])),
  });
  assert.deepEqual(document(actual, 0), {
    total: 3, succeeded: 3, failed: 0,
    reports: [valid(1, "mixed.json", mixed), valid(2, "success.json", success), valid(3, "mixed.json", mixed)],
    summary: { total: 15, succeeded: 7, failed: 8, failureStages: { read: 2, decode: 2, format: 4 } },
  });
});

test("invalid and missing inputs do not stop later valid reports or count as recorded failures", () => {
  const actual = run(["invalid.json", "missing.json", "success.json"], {
    files: { "invalid.json": "not JSON", "success.json": fixture("success-report.json") },
    guard: readGuard([["read", "invalid.json"], ["decode"], ["read", "missing.json"], ["read", "success.json"], ["decode"]]),
  });
  const output = document(actual, 1);
  const missing = output.reports[1].error;
  assert.equal(missing.name, "Error");
  assert.match(missing.message, /ENOENT/);
  assert.ok(missing.message.includes("missing.json"));
  assert.deepEqual(output, {
    total: 3, succeeded: 1, failed: 2, reports: [
      { position: 1, file: "invalid.json", ok: false, error: {
        stage: "decode", name: "SyntaxError", message: "Report must contain one complete JSON document.",
      } },
      { position: 2, file: "missing.json", ok: false, error: { stage: "read", name: "Error", message: missing.message } },
      valid(3, "success.json", success),
    ], summary: success,
  });
});

test("no valid reports still produces an all-zero summary and repeated failure results", () => {
  const output = document(run(["invalid.json", "invalid.json"], { files: { "invalid.json": "[]" } }), 1);
  assert.deepEqual(output, {
    total: 2, succeeded: 0, failed: 2,
    reports: [1, 2].map((position) => ({ position, file: "invalid.json", ok: false, error: {
      stage: "decode", name: "TypeError", message: "Report must be an object",
    } })), summary: empty,
  });
});

test("batch summary documents are rejected by the singular CLI", async (t) => {
  for (const [label, input, status] of [
    ["all-invalid batch", "not JSON", 1],
    ["valid-report batch control", fixture("success-report.json"), 0],
  ]) {
    await t.test(label, () => {
      const batch = run(["report.json"], { files: { "report.json": input } });
      document(batch, status);
      const consumer = spawnSync(process.execPath, [join(__dirname, "summarize-address-report.js")], {
        input: batch.stdout, encoding: "utf8", timeout: 10000,
      });
      assert.ifError(consumer.error);
      assert.equal(consumer.signal, null);
      assert.equal(consumer.status, 1);
      assert.equal(consumer.stdout, "");
      assert.match(consumer.stderr, /^stdin \(decode\): TypeError: .+\n$/);
    });
  }
});

test("valid empty and all-failure reports exit zero; saved strings and extra fields are not interpreted", () => {
  const failures = ["read", "decode", "format"].map((stage, index) => ({
    position: index + 1, file: "DO-NOT-OPEN.json", ok: false,
    error: { stage, name: "", message: "\r\n\ufeff\ud800", extra: true },
  }));
  const literal = { total: 1, succeeded: 1, failed: 0, extra: null, results: [
    { position: 1, file: "DO-NOT-OPEN.json", ok: true, formatted: "\r\n\ufeff\ud800", error: { stage: "read" } },
  ] };
  const allFailed = { total: 3, succeeded: 0, failed: 3, failureStages: { read: 1, decode: 1, format: 1 } };
  const one = { total: 1, succeeded: 1, failed: 0, failureStages: { read: 0, decode: 0, format: 0 } };
  const args = ["empty.json", "failures.json", "literal.json"];
  assert.deepEqual(document(run(args, { files: {
    "empty.json": bytes(zero),
    "failures.json": bytes({ total: 3, succeeded: 0, failed: 3, results: failures }),
    "literal.json": Buffer.concat([Buffer.from("\ufeff"), bytes(literal)]),
    "DO-NOT-OPEN.json": "not a draft",
  }, guard: readGuard(args.flatMap((file) => [["read", file], ["decode"]])) }), 0), {
    total: 3, succeeded: 3, failed: 0,
    reports: [valid(1, "empty.json", empty), valid(2, "failures.json", allFailed), valid(3, "literal.json", one)],
    summary: { total: 4, succeeded: 1, failed: 3, failureStages: { read: 1, decode: 1, format: 1 } },
  });
});

test("representative UTF-8 and structure errors use the shared decoder and continue", () => {
  const output = document(run(["utf8.json", "count.json", "empty.json"], { files: {
    "utf8.json": Buffer.from([0xc3, 0x28]),
    "count.json": bytes({ ...zero, succeeded: 1 }), "empty.json": bytes(zero),
  } }), 1);
  assert.deepEqual(output, {
    total: 3, succeeded: 1, failed: 2, reports: [
      { position: 1, file: "utf8.json", ok: false, error: {
        stage: "decode", name: "TypeError", message: "Report must contain valid UTF-8.",
      } },
      { position: 2, file: "count.json", ok: false, error: {
        stage: "decode", name: "RangeError", message: "succeeded and failed must match the result outcomes",
      } }, valid(3, "empty.json", empty),
    ], summary: empty,
  });
});

test("one report works; path spelling is retained, with no stdin fallback or option parsing", () => {
  assert.deepEqual(document(run(["./empty.json"], { files: { "empty.json": bytes(zero) } }), 0), {
    total: 1, succeeded: 1, failed: 0, reports: [valid(1, "./empty.json", empty)], summary: empty,
  });
  const args = ["-", "--", "--unknown", "--help", "./--help", "literal*.json", "empty.json"];
  const output = document(run(args, { files: { "empty.json": bytes(zero) },
    guard: readGuard([...args.slice(0, -1).map((file) => ["read", file]), ["read", "empty.json"], ["decode"]]),
  }), 1);
  assert.equal(output.failed, 6);
  assert.deepEqual(output.reports.map((result) => result.file), args);
  assert.ok(output.reports.slice(0, -1).every((result) => !result.ok && result.error.stage === "read"));
  assert.deepEqual(output.reports[6], valid(7, "empty.json", empty));
  assert.deepEqual(output.summary, empty);
});

test("an explicitly named directory is not discovered, and a later file is still read", () => {
  const output = document(run([".", "empty.json"], { files: { "empty.json": bytes(zero) } }), 1);
  assert.equal(output.reports[0].ok, false);
  // Directory read behavior is OS-dependent; either read or decode must refuse.
  assert.ok(["read", "decode"].includes(output.reports[0].error.stage));
  assert.deepEqual(output.reports[1], valid(2, "empty.json", empty));
  assert.deepEqual(output.summary, empty);
});

test("preload guard rejects real draft and formatter modules", () => {
  for (const file of ["delivery-address.js", "delivery-address-draft.js", "format-address-drafts.js"]) {
    // Resolve actual files without executing them; the child must reject the load.
    const modulePath = require.resolve("./" + file);
    const guard = readGuard([]) + "require(" + JSON.stringify(modulePath) + ");";
    const actual = run(["--help"], { guard });
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout, "");
    assert.ok(actual.stderr.includes("AssertionError [ERR_ASSERTION]: draft/formatter import: " + modulePath), actual.stderr);
  }
});

test("help and no-argument usage do not read input", () => {
  const guard = readGuard([]);
  const help = run(["--help"], { guard });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.ok(help.stdout.startsWith(usage));
  for (const phrase of ["No stdin", "argument order", "repeated filenames", "./--help", "valid reports only", "entries under reports", "Exit 0:", "1:", "2:", "memory"]) {
    assert.ok(help.stdout.includes(phrase), phrase);
  }
  const actual = run([], { guard });
  assert.equal(actual.status, 2, actual.stderr);
  assert.equal(actual.stdout, "");
  assert.equal(actual.stderr, usage);
});
