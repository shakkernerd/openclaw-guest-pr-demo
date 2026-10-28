"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { runInNewContext } = require("node:vm");

const root = resolve(__dirname, "../..");
const cli = resolve(root, "decision-export-audit/bin/decision-export-audit.js");
const current = "decision-export-audit/test/fixtures/review-decisions-review.json";
const incoming = "decision-export-audit/test/fixtures/incoming-review-decisions.json";
const saved = "decision-export-audit/examples/colleague-handoff/comparison.json";
const comparison = ["compare", current, incoming];
const available = spawnSync("bash", ["-c", "command -v head"], { encoding: "utf8" });
const shellOptions = { skip: available.error || available.status !== 0 ? "Installed Bash and head are required for real pipeline checks" : false };

function piped(args, mode = "stdout", lines = 0) {
  const command = mode === "merged" ? '"$@" 2>&1' : mode === "stderr" ? '"$@" 2>&1 >/dev/null' : '"$@"';
  // Capture producer and reader status immediately; a successful head alone can hide failure.
  const script = command + " | head -n " + lines + '\ncodes=("' + '$' + '{PIPESTATUS[@]}")\n' +
    "printf '\\n__PIPE_STATUS__:%s:%s\\n' " + '"' + '$' + '{codes[0]}" "' + '$' + '{codes[1]}" >&2\n' +
    'exit "' + '$' + '{codes[0]}"';
  const result = spawnSync("bash", ["-o", "pipefail", "-c", script, "cli-pipe", process.execPath, cli, ...args], {
    cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const marker = /\n__PIPE_STATUS__:(\d+):(\d+)\n$/.exec(result.stderr);
  assert.ok(marker, "Missing pipeline statuses: " + result.stderr);
  return { ...result, producerStatus: Number(marker[1]), readerStatus: Number(marker[2]), diagnostics: result.stderr.slice(0, marker.index) };
}

function expectQuiet(result, code, output = "") {
  assert.equal(result.producerStatus, code, "Producer status; stderr: " + result.diagnostics);
  assert.equal(result.readerStatus, 0);
  assert.equal(result.status, code);
  assert.equal(result.diagnostics, "", "No unhandled exception or diagnostic retry to a closed stream");
  assert.equal(result.stdout, output);
}

for (const mode of ["stdout", "merged"]) {
  test("real comparison | head -n 1 closes " + mode + " without changing success", shellOptions, () => {
    expectQuiet(piped(comparison, mode, 1), 0, "{\n");
  });
}

for (const mode of ["stdout", "merged"]) {
  test("large comparison | head -n 1 closes " + mode + " mid-write", shellOptions, t => {
    const dir = mkdtempSync(join(tmpdir(), "decision-pipe-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const large = join(dir, "large.json");
    const value = JSON.parse(readFileSync(resolve(root, current), "utf8"));
    value.decisions[0].note = "preview ".repeat(65536);
    writeFileSync(large, JSON.stringify(value));
    // Larger than pipe buffers: do not rely on the small real handoff triggering EPIPE.
    expectQuiet(piped(["compare", large, large], mode, 1), 0, "{\n");
  });
}

for (const args of [["--help"], ["validate", current], comparison]) {
  test("stdout reader closed immediately preserves success for " + args[0], shellOptions, () => {
    expectQuiet(piped(args), 0);
  });
}

test("closed stdout preserves invalid-data exit 1 without an exception", shellOptions, t => {
  const dir = mkdtempSync(join(tmpdir(), "decision-pipe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invalid = join(dir, "invalid.json");
  writeFileSync(invalid, '{"schemaVersion":2}\n');
  expectQuiet(piped(["validate", invalid]), 1);
});

test("closed stdout preserves file-read failure exit 2", shellOptions, t => {
  const dir = mkdtempSync(join(tmpdir(), "decision-pipe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  expectQuiet(piped(["validate", join(dir, "missing.json")]), 2);
});

for (const mode of ["stderr", "merged"]) {
  test("closed " + mode + " usage output preserves exit 2", shellOptions, () => {
    expectQuiet(piped(["unknown-command"], mode), 2);
  });
}

function sandbox(main = true) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  stdout.write = stderr.write = () => true;
  const process = { argv: ["node", cli, "--help"], stdout, stderr };
  const module = {};
  const actualRequire = createRequire(cli);
  const require = id => actualRequire(id);
  require.main = main ? module : {};
  runInNewContext(readFileSync(cli, "utf8"), { require, module, process }, { filename: cli });
  return process;
}

test("only EPIPE is ignored on either output stream, preserving the command result", () => {
  const process = sandbox();
  for (const code of [0, 1, 2]) {
    process.exitCode = code;
    for (const stream of [process.stdout, process.stderr]) {
      assert.doesNotThrow(() => stream.emit("error", Object.assign(new Error("reader closed"), { code: "EPIPE" })));
      assert.equal(process.exitCode, code);
      const other = Object.assign(new Error("unexpected output failure"), { code: "EIO" });
      assert.throws(() => stream.emit("error", other), error => error === other);
    }
  }
});

test("loading CLI as a module does not install process-wide stream handlers", () => {
  const process = sandbox(false);
  assert.equal(process.stdout.listenerCount("error"), 0);
  assert.equal(process.stderr.listenerCount("error"), 0);
  assert.equal(process.exitCode, undefined);
});

test("untruncated CLI report, real inputs, and saved report retain exact bytes", () => {
  const paths = [current, incoming, saved];
  const before = paths.map(path => readFileSync(resolve(root, path)));
  const result = spawnSync(process.execPath, [cli, ...comparison], { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr.length, 0);
  assert.ok(result.stdout.equals(before[2]), "Full CLI stdout must equal the existing saved report");
  const expectedHashes = [
    "1d3119bcc05c601dcae42c79cd1e22d0765300d2ce90138b8e4d47483ee7151d",
    "a5b3582c51aede5a77e535783f2caebb8ba26b50c893635c1d351414f5d9bf66",
    "bae2cfbcb560d40d145ce87ee48e7ad3ac17e551505250fddcf66b32df860783",
  ];
  paths.forEach((path, index) => {
    const after = readFileSync(resolve(root, path));
    assert.ok(after.equals(before[index]), path + " changed");
    assert.equal(createHash("sha256").update(after).digest("hex"), expectedHashes[index]);
  });
});
