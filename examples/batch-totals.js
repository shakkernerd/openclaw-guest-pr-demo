#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const modes = ["mixed", "single-sku"];
const counts = ["boxCount", "fullBoxes", "partialBoxes"];
const emptyCounts = () => ({ boxCount: 0n, fullBoxes: 0n, partialBoxes: 0n, unusedItemSlots: 0n });

function ioMessage(operation, error) {
  const code = /^[A-Z0-9_]+$/.test(error?.code) ? error.code : "IO_ERROR";
  return operation + " (" + code + ")";
}

function writeText(stream, text, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      done(Object.assign(new Error(), { code: "ABORT_ERR" }));
      // Best effort for ordinary streams. Process stdio may retain the native
      // write even after destroy(); main settles that case after child cleanup.
      stream.destroy();
    };
    const onClose = () => done(Object.assign(new Error(), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
    function done(error) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      stream.off("error", done);
      stream.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    stream.once("error", done);
    stream.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    if (stream.destroyed || stream.writableEnded) return onClose();
    try { stream.write(text, done); } catch (error) { done(error); }
  });
}

function addSummary(text, totals) {
  // Validate the fields we consume, not orders or packing rules. Prepare BOTH
  // policies before changing totals, so a malformed result is never half counted.
  const row = JSON.parse(text);
  const prepared = {};
  for (const mode of modes) {
    const summary = row?.[mode];
    if (!summary || summary.mode !== mode ||
        !Number.isSafeInteger(summary.totalItems) || summary.totalItems < 0 ||
        counts.some(key => !Number.isSafeInteger(summary[key]) || summary[key] < 0) ||
        typeof summary.unusedItemSlots !== "string" || !/^(0|[1-9][0-9]*)$/.test(summary.unusedItemSlots)) {
      throw new Error("invalid summary fields");
    }
    prepared[mode] = Object.fromEntries([...counts, "unusedItemSlots"].map(key => [key, BigInt(summary[key])]));
  }
  if (row.mixed.totalItems !== row["single-sku"].totalItems) throw new Error("inconsistent item totals");
  totals.successfulOrders += 1n;
  totals.totalItems += BigInt(row.mixed.totalItems);
  for (const mode of modes) {
    for (const key of [...counts, "unusedItemSlots"]) totals[mode][key] += prepared[mode][key];
  }
}

async function consume(output, totals) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of output) {
    const text = decoder.write(chunk);
    let start = 0;
    let end;
    while ((end = text.indexOf("\n", start)) !== -1) {
      const line = pending + text.slice(start, end);
      pending = "";
      start = end + 1;
      try { addSummary(line, totals); } catch { throw new Error("invalid producer summary"); }
    }
    pending += text.slice(start);
  }
  // Unlike producer INPUT, producer OUTPUT always promises a terminating LF.
  pending += decoder.end();
  if (pending.length) throw new Error("incomplete producer output");
}

async function main() {
  const totals = { successfulOrders: 0n, totalItems: 0n, mixed: emptyCounts(), "single-sku": emptyCounts() };
  let producer = { exitCode: null, signal: null };
  let child;
  let closed = false;
  let started = false;
  let killTimer;
  let failure = null;
  let reportWritten = false;
  let interrupted = false;
  let pendingWrite;
  let abandonedWrite = false;

  async function writeOwn(stream, text) {
    const controller = new AbortController();
    pendingWrite = controller;
    // Only a post-interruption report gets a bounded flush opportunity. Normal
    // output has no deadline; child cleanup has its separate existing grace.
    const timer = interrupted ? setTimeout(() => controller.abort(), 1000) : undefined;
    try { await writeText(stream, text, controller.signal); }
    finally {
      if (controller.signal.aborted) abandonedWrite = true;
      clearTimeout(timer);
      pendingWrite = undefined;
    }
  }

  function fail(message, signal = "SIGTERM") {
    failure ||= message;
    process.exitCode = 1;
    child?.stdout?.destroy();
    if (child?.pid && !closed && child.exitCode === null && child.signalCode === null && !killTimer) {
      child.kill(signal);
      // Only failed/cancelled runs have a cleanup deadline; healthy runs do not.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    }
  }
  const onInterrupt = signal => {
    interrupted = true;
    fail("interrupted (" + signal + ")", signal);
    pendingWrite?.abort();
  };
  // These stdio error guards live for this CLI process, including late write errors.
  process.stdout.on("error", error => fail(ioMessage("cannot write report", error)));
  process.stdout.on("close", () => {
    if (!reportWritten) fail("report stream closed prematurely");
  });
  process.stderr.on("error", error => fail(ioMessage("cannot write diagnostics", error)));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  async function diagnose(message) {
    // Do not enter (or re-enter) a possibly blocked diagnostic sink after SIGINT/TERM.
    if (interrupted) return;
    try { await writeOwn(process.stderr, "batch-totals: " + message + "\n"); }
    catch (error) { fail(ioMessage("cannot write diagnostics", error)); }
  }

  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      await writeOwn(process.stdout, "Usage: node examples/batch-totals.js [FILE|-]\n" +
        "Use -- before a dash-prefixed filename; omit FILE or use - for stdin.\n" +
        "Write one JSON report of observed successful summaries, even on failure.\n" +
        "Exit: producer status 0/1/2; consumer errors or signals 1.\n");
      reportWritten = true;
      return;
    }
    try {
      child = spawn(process.execPath, [path.join(__dirname, "..", "packaging-batch-cli.js"), ...args], {
        stdio: ["inherit", "pipe", "inherit"],
      });
      // Observe immediately; neither an early exit nor an error can be missed
      // while stdout is being drained. A spawn failure has no producer status.
      const done = new Promise(resolve => {
        child.once("spawn", () => { started = true; });
        child.on("error", error => fail(ioMessage("producer process error", error)));
        child.once("close", (exitCode, signal) => {
          closed = true;
          if (started) producer = { exitCode, signal };
          clearTimeout(killTimer);
          resolve();
        });
      });
      try { await consume(child.stdout, totals); }
      catch (error) {
        const message = ["invalid producer summary", "incomplete producer output"].includes(error.message)
          ? error.message : ioMessage("cannot read producer output", error);
        fail(message);
      }
      await done;
    } catch (error) {
      fail(ioMessage("cannot start producer", error));
    }

    if (failure) await diagnose(failure);
    const failed = failure !== null || producer.exitCode !== 0 || producer.signal !== null;
    process.exitCode = failure || producer.signal || producer.exitCode === null ? 1 : producer.exitCode;
    const report = { failed, producer, consumerError: failure, ...totals };
    await writeOwn(process.stdout, JSON.stringify(report, (_, value) =>
      typeof value === "bigint" ? value.toString() : value) + "\n");
    reportWritten = true;
  } catch (error) {
    fail(ioMessage("cannot write report", error));
    await diagnose(ioMessage("cannot write report", error));
  } finally {
    clearTimeout(killTimer);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    // Only an interrupted, abandoned own write takes this path. All own writes
    // occur before spawning (help) or after child close. A usable partial report
    // has already flushed; an undrained native stdio write must not keep us alive.
    if (abandonedWrite) process.exit(1);
  }
}

main().catch(() => { process.exitCode = 1; });
