"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const posixSignals = { skip: process.platform === "win32" ? "Requires POSIX signal interception, not Windows programmatic termination" : false };

const cli = path.join(__dirname, "examples", "batch-totals.js");
const order = '{"items":[{"sku":"A","quantity":1},{"sku":"B","quantity":1}],"maxItemsPerBox":4}';
const summary = {
  line: 3,
  mixed: { mode: "mixed", maxItemsPerBox: 4, totalItems: 2, boxCount: 1, fullBoxes: 0, partialBoxes: 1, unusedItemSlots: "2" },
  "single-sku": { mode: "single-sku", maxItemsPerBox: 4, totalItems: 2, boxCount: 2, fullBoxes: 0, partialBoxes: 2, unusedItemSlots: "6" },
};
const line = JSON.stringify(summary) + "\n";
const zero = { boxCount: "0", fullBoxes: "0", partialBoxes: "0", unusedItemSlots: "0" };
const once = {
  successfulOrders: "1", totalItems: "2",
  mixed: { boxCount: "1", fullBoxes: "0", partialBoxes: "1", unusedItemSlots: "2" },
  "single-sku": { boxCount: "2", fullBoxes: "0", partialBoxes: "2", unusedItemSlots: "6" },
};
const twice = {
  successfulOrders: "2", totalItems: "4",
  mixed: { boxCount: "2", fullBoxes: "0", partialBoxes: "2", unusedItemSlots: "4" },
  "single-sku": { boxCount: "4", fullBoxes: "0", partialBoxes: "4", unusedItemSlots: "12" },
};

function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "batch-totals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function start(t, args = [], options = {}) {
  const child = spawn(process.execPath, [...(options.nodeArgs || []), options.cli || cli, ...args], {
    cwd: options.cwd || __dirname, stdio: ["pipe", "pipe", "pipe"],
    // Test hang guard only: the example has no processing timeout.
    timeout: 5000, killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const captureStderr = chunk => { stderr += chunk; };
  if (!options.holdStderr) child.stderr.on("data", captureStderr);
  child.stdin.on("error", () => {});
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // Also clean up a fixture child if a regression left it orphaned.
    for (const [, pid] of stderr.matchAll(/fixture-pid:(\d+)/g)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, releaseStderr() {
    child.stderr.on("data", captureStderr);
    child.stderr.resume();
  } };
}

async function run(t, args, input = "", options) {
  const { child, done } = start(t, args, options);
  child.stdin.end(input);
  return done;
}

function report(result, code) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, code, result.stderr);
  assert.ok(result.stdout.endsWith("\n"));
  assert.equal(result.stdout.split("\n").length, 2, "exactly one final JSON line");
  return JSON.parse(result.stdout);
}

function expected(totals, exitCode = 0) {
  return { failed: exitCode !== 0, producer: { exitCode, signal: null }, consumerError: null, ...totals };
}

// A copied CLI resolves this controlled dependency naturally. No production
// flags, exports, injected paths, or packing-engine mocks are introduced.
function fixture(t, source) {
  const dir = directory(t);
  mkdirSync(path.join(dir, "examples"));
  copyFileSync(cli, path.join(dir, "examples", "batch-totals.js"));
  writeFileSync(path.join(dir, "packaging-batch-cli.js"), source);
  return { cli: path.join(dir, "examples", "batch-totals.js") };
}

function assertProducerTermination(outcome, signal) {
  if (process.platform !== "win32") {
    assert.deepEqual(outcome, { exitCode: null, signal });
  } else {
    // Windows programmatic termination is not POSIX signal delivery. Preserve
    // the reported unsuccessful outcome without demanding POSIX signal metadata.
    assert.notDeepEqual(outcome, { exitCode: 0, signal: null });
    assert.ok(outcome.signal !== null || Number.isInteger(outcome.exitCode));
  }
}

function interruptOn(child, marker) {
  let seen = "";
  const onData = chunk => {
    seen += chunk;
    if (seen.includes(marker)) {
      child.stderr.off("data", onData);
      child.kill("SIGTERM");
    }
  };
  child.stderr.on("data", onData);
}

function assertSettled(result) {
  const match = result.stderr.match(/fixture-pid:(\d+)/);
  assert.ok(match, result.stderr);
  assert.throws(() => process.kill(Number(match[1]), 0), { code: "ESRCH" });
}

test("real producer: file and stdin keep orders separate and emit one exact report", async t => {
  const dir = directory(t);
  const file = "--orders with spaces.jsonl";
  const input = order + "\n" + order; // Producer accepts a clean input tail.
  writeFileSync(path.join(dir, file), input);
  for (const [args, stdin] of [[["--", file], "ignored"], [["-"], input]]) {
    const result = await run(t, args, stdin, { cwd: dir });
    assert.deepEqual(report(result, 0), expected(twice));
    assert.equal(result.stderr, "");
  }
});

test("real producer: partial file/stdin results retain exact source diagnostics", async t => {
  const dir = directory(t);
  const file = path.join(dir, "orders.jsonl");
  const input = "\n" + order + "\nnull\n \t\r\n" + order;
  writeFileSync(file, input);
  for (const args of [[file], []]) {
    const result = await run(t, args, input);
    assert.deepEqual(report(result, 1), expected(twice, 1));
    const source = args.length ? JSON.stringify(file) : "standard input";
    assert.equal(result.stderr, "packaging-batch: " + source +
      ": line 3: order must be an object with items and maxItemsPerBox\n");
  }
});

test("real producer: additions exceed safe integers without pooling or double counting", async t => {
  const huge = '{"items":[{"sku":"A","quantity":9007199254740991}],"maxItemsPerBox":1}';
  const sparse = '{"items":[{"sku":"A","quantity":1},{"sku":"B","quantity":2}],"maxItemsPerBox":9007199254740991}';
  const sparseTwo = '{"items":[{"sku":"A","quantity":1},{"sku":"B","quantity":1}],"maxItemsPerBox":9007199254740991}';
  const result = await run(t, [], [huge, huge, sparse, sparseTwo].join("\n"));
  assert.deepEqual(report(result, 0), expected({
    successfulOrders: "4", totalItems: "18014398509481987",
    mixed: { boxCount: "18014398509481984", fullBoxes: "18014398509481982", partialBoxes: "2", unusedItemSlots: "18014398509481977" },
    "single-sku": { boxCount: "18014398509481986", fullBoxes: "18014398509481982", partialBoxes: "4", unusedItemSlots: "36028797018963959" },
  }));
  assert.equal(result.stderr, "");
});

test("real producer: empty success, unreadable input, and argument exit 2 stay distinct", async t => {
  const totals = { successfulOrders: "0", totalItems: "0", mixed: zero, "single-sku": zero };
  const empty = await run(t, [], " \t\r\n");
  assert.deepEqual(report(empty, 0), expected(totals));
  assert.equal(empty.stderr, "");
  const missing = path.join(directory(t), "missing.jsonl");
  const unreadable = await run(t, [missing]);
  assert.deepEqual(report(unreadable, 1), expected(totals, 1));
  assert.equal(unreadable.stderr, "packaging-batch: " + JSON.stringify(missing) + ": cannot read input (ENOENT)\n");
  const { done } = start(t, ["--unknown"]); // Deliberately leave stdin open.
  const misuse = await done;
  assert.deepEqual(report(misuse, 2), expected(totals, 2));
  assert.match(misuse.stderr, /^packaging-batch: unknown option "--unknown"\nUsage:/);
});

test("live malformed output proves incremental consumption and escalated child cleanup", posixSignals, async t => {
  const options = fixture(t, String.raw`
    process.on('SIGTERM', () => {});
    process.stderr.write('fixture-pid:' + process.pid + '\n');
    const line = ${JSON.stringify(line)};
    process.stdout.write(line.slice(0, 17));
    setImmediate(() => process.stdout.write(line.slice(17) + line + '{PRIVATE MALFORMED}\n'));
    setInterval(() => {}, 1000); // No EOF: a whole-output consumer would hang.
  `);
  const { done } = start(t, [], options);
  const result = await done;
  assert.deepEqual(report(result, 1), {
    failed: true, producer: { exitCode: null, signal: "SIGKILL" },
    consumerError: "invalid producer summary", ...twice,
  });
  assert.match(result.stderr, /batch-totals: invalid producer summary\n$/);
  assert.doesNotMatch(result.stderr, /PRIVATE|\n\s+at /);
  assertSettled(result);
});

test("a parseable unterminated output tail is not a successful result", async t => {
  const result = await run(t, [], "", fixture(t,
    String.raw`process.stdout.write(${JSON.stringify(line + line.trimEnd())});`));
  assert.deepEqual(report(result, 1), {
    failed: true, producer: { exitCode: 0, signal: null },
    consumerError: "incomplete producer output", ...once,
  });
  assert.equal(result.stderr, "batch-totals: incomplete producer output\n");
});

test("invalid second-policy fields do not partly update aggregates", async t => {
  const bad = structuredClone(summary);
  bad["single-sku"].unusedItemSlots = 6;
  const result = await run(t, [], "", fixture(t, String.raw`
    process.stderr.write('fixture-pid:' + process.pid + '\n');
    process.stdout.write(${JSON.stringify(line + JSON.stringify(bad) + "\n")});
    setInterval(() => {}, 1000);
  `));
  const observed = report(result, 1);
  assertProducerTermination(observed.producer, "SIGTERM");
  assert.deepEqual(observed, {
    failed: true, producer: observed.producer,
    consumerError: "invalid producer summary", ...once,
  });
  assertSettled(result);
});

test("producer termination retains its unsuccessful outcome and prior totals", async t => {
  const result = await run(t, [], "", fixture(t, String.raw`
    process.stdout.write(${JSON.stringify(line)}, () => process.kill(process.pid, 'SIGTERM'));
  `));
  const observed = report(result, 1);
  assertProducerTermination(observed.producer, "SIGTERM");
  assert.deepEqual(observed, {
    failed: true, producer: observed.producer, consumerError: null, ...once,
  });
  assert.equal(result.stderr, "");
});

test("consumer interruption settles its open child and exits 1 rather than by signal", posixSignals, async t => {
  const options = fixture(t, String.raw`
    process.stderr.write('fixture-pid:' + process.pid + '\n');
    setInterval(() => {}, 1000);
  `);
  const { child, done } = start(t, [], options);
  child.stderr.once("data", () => child.kill("SIGINT"));
  const result = await done;
  assert.deepEqual(report(result, 1), {
    failed: true, producer: { exitCode: null, signal: "SIGINT" },
    consumerError: "interrupted (SIGINT)",
    successfulOrders: "0", totalItems: "0", mixed: zero, "single-sku": zero,
  });
  assertSettled(result);
});

test("standalone help is local and does not wait for stdin", async t => {
  const { done } = start(t, ["--help"]);
  const result = await done;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Usage: node examples\/batch-totals\.js/);
});

test("stdout EOF alone does not finish the report before the producer exits", async t => {
  const result = await run(t, [], "", fixture(t, String.raw`
    process.stdout.end(${JSON.stringify(line)}, () => {
      setTimeout(() => { process.stderr.write('late diagnostic\n'); process.exitCode = 1; }, 50);
    });
  `));
  assert.deepEqual(report(result, 1), expected(once, 1));
  assert.equal(result.stderr, "late diagnostic\n");
});

test("real broken report pipe fails cleanly after producer completion", async t => {
  const { child, done } = start(t);
  child.stdout.destroy();
  child.stdin.end(order + "\n");
  const result = await done;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^batch-totals: cannot write report \(EPIPE\)\n$/);
});

test("dependency spawn failure has no invented producer exit code", async t => {
  const dir = directory(t);
  const preload = path.join(dir, "spawn-failure.cjs");
  writeFileSync(preload, String.raw`
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = (command, args, options) => spawn(${JSON.stringify(path.join(dir, "missing-node"))}, args, options);
  `);
  const result = await run(t, [], "", { nodeArgs: ["--require", preload] });
  assert.deepEqual(report(result, 1), {
    failed: true, producer: { exitCode: null, signal: null },
    consumerError: "producer process error (ENOENT)",
    successfulOrders: "0", totalItems: "0", mixed: zero, "single-sku": zero,
  });
  assert.equal(result.stderr, "batch-totals: producer process error (ENOENT)\n");
});

test("an observed report-stream failure settles an owned producer with stdin still open", async t => {
  const dir = directory(t);
  const preload = path.join(dir, "output-failure.cjs");
  writeFileSync(preload, String.raw`
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = (...args) => {
      const child = spawn(...args);
      child.once('spawn', () => {
        process.stderr.write('fixture-pid:' + child.pid + '\n');
        process.stdout.emit('error', Object.assign(new Error('PRIVATE'), { code: 'EPIPE' }));
      });
      return child;
    };
  `);
  const { done } = start(t, [], { nodeArgs: ["--require", preload] });
  const result = await done;
  // The injected event leaves the actual test stdout writable, so the failure
  // envelope is observable; the separate broken-pipe case uses a real OS pipe.
  const observed = report(result, 1);
  assertProducerTermination(observed.producer, "SIGTERM");
  assert.deepEqual(observed, {
    failed: true, producer: observed.producer,
    consumerError: "cannot write report (EPIPE)",
    successfulOrders: "0", totalItems: "0", mixed: zero, "single-sku": zero,
  });
  assert.doesNotMatch(result.stderr, /PRIVATE|\n\s+at /);
  assertSettled(result);
});


test("real producer: interruption with held-open undrained stderr retains a usable report", posixSignals, async t => {
  const file = path.join(directory(t), "invalid.jsonl");
  writeFileSync(file, order + "\n" + "null\n".repeat(20000));
  const { child, done, releaseStderr } = start(t, [file], { holdStderr: true });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let outcome;
  try {
    await new Promise(resolve => child.stderr.once("readable", resolve));
    // Back up both the readable buffer and inherited OS pipe. Do not read, end,
    // or destroy the diagnostic destination until after consumer exit.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(child.stderr.readableLength > 0);
    assert.equal(child.exitCode, null);
    child.kill("SIGTERM");
    outcome = await exited;
  } finally {
    releaseStderr();
  }
  const result = await done;
  assert.deepEqual(outcome, { code: 1, signal: null });
  assert.deepEqual(report(result, 1), {
    failed: true, producer: { exitCode: null, signal: "SIGTERM" },
    consumerError: "interrupted (SIGTERM)", ...once,
  });
  assert.match(result.stderr, /^packaging-batch:/);
  assert.doesNotMatch(result.stderr, /batch-totals:/);
});

test("interrupt an already pending own diagnostic without retrying its blocked sink", posixSignals, async t => {
  const options = fixture(t, String.raw`
    process.stderr.write('fixture-pid:' + process.pid + '\n');
    process.stdout.write(${JSON.stringify(line + 'broken\n')});
    setInterval(() => {}, 1000);
  `);
  const preload = path.join(directory(t), "held-diagnostic.cjs");
  writeFileSync(preload, String.raw`
    const { Writable } = require('node:stream');
    const { writeSync } = require('node:fs');
    let keeper;
    let calls = 0;
    Object.defineProperty(process, 'stderr', { value: new Writable({
      write(chunk, encoding, callback) {
        calls++;
        keeper = setInterval(() => {}, 1000);
        writeSync(2, 'diagnostic-pending\n');
      },
      destroy(error, callback) {
        clearInterval(keeper);
        writeSync(2, 'diagnostic-cancelled:' + calls + '\n');
        callback(error);
      },
    }) });
  `);
  const { child, done } = start(t, [], { ...options, nodeArgs: ["--require", preload] });
  interruptOn(child, "diagnostic-pending\n");
  const result = await done;
  assert.deepEqual(report(result, 1), {
    failed: true, producer: { exitCode: null, signal: "SIGTERM" },
    consumerError: "invalid producer summary", ...once,
  });
  assert.match(result.stderr, /diagnostic-cancelled:1\n$/);
  assertSettled(result);
});

// Controlled writable callbacks supplement real OS-pipe evidence. The producer
// here remains the real CLI; no production hook or replacement path is added.
function reportSink(t, mode) {
  const preload = path.join(directory(t), "held-report.cjs");
  writeFileSync(preload, String.raw`
    const { Writable } = require('node:stream');
    const original = process.stdout;
    let keeper;
    Object.defineProperty(process, 'stdout', { value: new Writable({
      write(chunk, encoding, callback) {
        process.stderr.write('report-pending\n');
        keeper = ${mode === "release" ? "setTimeout(() => original.write(chunk, callback), 1200)" : "setInterval(() => {}, 1000)"};
      },
      destroy(error, callback) {
        clearTimeout(keeper);
        clearInterval(keeper);
        callback(error);
      },
    }) });
    ${mode === "before" ? String.raw`
      const cp = require('node:child_process');
      const spawn = cp.spawn;
      cp.spawn = (...args) => {
        const child = spawn(...args);
        child.once('spawn', () => process.kill(process.pid, 'SIGTERM'));
        child.once('close', (code, signal) => process.stderr.write('producer-closed:' + signal + '\n'));
        return child;
      };
    ` : ""}
  `);
  return { nodeArgs: ["--require", preload] };
}

test("normal report flushing waits beyond the interruption grace", async t => {
  const result = await run(t, [], order + "\n", reportSink(t, "release"));
  assert.deepEqual(report(result, 0), expected(once));
  assert.equal(result.stderr, "report-pending\n");
});

test("interruption cancels a pending final report without entering diagnostics", posixSignals, async t => {
  const { child, done } = start(t, [], reportSink(t, "hold"));
  interruptOn(child, "report-pending\n");
  child.stdin.end(order + "\n");
  const result = await done;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "report-pending\n");
});

test("a post-interruption report has bounded flushing after owned-child closure", posixSignals, async t => {
  const { done } = start(t, [], reportSink(t, "before"));
  const result = await done;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "producer-closed:SIGTERM\nreport-pending\n");
});
