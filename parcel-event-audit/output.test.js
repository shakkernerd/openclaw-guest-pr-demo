"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const cli = path.join(__dirname, "cli.js");

async function largeExport(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "parcel-audit-output-"));
  const filename = path.join(directory, "large.jsonl");
  const line = JSON.stringify({
    eventId: "retry", parcelId: "large", type: "created", occurredAt: "2026-10-28T08:00:00Z",
  }) + "\n";
  // Enough provenance to exceed pipe buffers, so closing after the first chunk
  // exercises a failed write, not a fully buffered successful delivery.
  const bytes = Buffer.from(line.repeat(12000));
  await writeFile(filename, bytes);
  t.after(async () => {
    try { assert.deepEqual(await readFile(filename), bytes); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return filename;
}

function combinedPipe(t, filename, closeEarly) {
  // POSIX fd duplication: both CLI streams really share ONE pipe. Arguments
  // are passed positionally, never interpolated into shell source. The shell
  // execs Node so the observed status is the CLI's, not a downstream reader's.
  const child = spawn("sh", ["-c", 'exec "$@" 2>&1', "parcel-audit-pipe-test", process.execPath, cli, filename], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  return new Promise((resolve, reject) => {
    let output = "";
    let shellError = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (closeEarly) child.stdout.destroy();
    });
    child.stderr.on("data", chunk => { shellError += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output, shellError }));
  });
}

test("combined output pipe closed by its reader preserves exit 2 without an uncaught failure", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const filename = await largeExport(t);
  const result = await combinedPipe(t, filename, true);
  assert.equal(result.shellError, "");
  assert.equal(result.signal, null);
  assert.match(result.output, /^\{/);
  assert.doesNotMatch(result.output, /Unhandled 'error' event|node:events|\n\s+at /);
  assert.equal(result.code, 2, "output failure must remain exit 2 even when stderr shares the closed pipe");
});

test("normally drained combined output pipe delivers the complete report and exit 0", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const filename = await largeExport(t);
  const result = await combinedPipe(t, filename, false);
  assert.equal(result.shellError, "");
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.output);
  assert.equal(report.summary.inputRecords, 12000);
  assert.equal(report.summary.retryDuplicates, 11999);
  assert.equal(report.summary.exceptions, 0);
  assert.equal(report.parcels[0].timeline[0].sources.length, 12000);
  assert.ok(result.output.endsWith("\n"));
});
