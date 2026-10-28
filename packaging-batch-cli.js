#!/usr/bin/env node
"use strict";

const { createReadStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { StringDecoder } = require("node:string_decoder");
const { parseOrder } = require("./order-json.js");
const { summarizePackaging } = require("./packaging.js");

const USAGE = [
  "Usage: node packaging-batch-cli.js [--diagnostics=jsonl] [FILE|-]",
  "       node packaging-batch-cli.js --help",
  "",
  "Read one order per LF-delimited line; omit FILE or use - for standard input.",
  "Skip only empty lines or lines containing spaces, tabs, and CR characters.",
  "Write compact JSON lines with physical line, mixed, and single-sku summaries.",
  "Invalid records: diagnose on stderr, omit the result, and continue.",
  "--diagnostics=jsonl  Replace human batch stderr with versioned JSONL events.",
  "                    Use once, before --; stdout and exit codes are unchanged.",
  "--help, -h   Show this help (use alone).",
  "--           End options, allowing filenames that begin with a dash.",
  "",
  "Exit codes: 0 success/help, 1 any invalid record or fatal I/O error, 2 argument error.",
].join("\n") + "\n";

function parseArguments(args) {
  let file;
  let diagnostics;
  let options = true;
  for (const arg of args) {
    if (options && (arg === "--help" || arg === "-h")) {
      if (args.length !== 1) throw new Error("help option must be used alone");
      return { help: true };
    }
    if (options && arg === "--") {
      options = false;
    } else if (options && arg.startsWith("--diagnostics=")) {
      if (diagnostics !== undefined) throw new Error("repeated option --diagnostics");
      if (arg !== "--diagnostics=jsonl") throw new Error("--diagnostics requires jsonl");
      diagnostics = "jsonl";
    } else if (options && arg.startsWith("-") && arg !== "-") {
      throw new Error("unknown option " + JSON.stringify(arg));
    } else {
      if (file !== undefined) throw new Error("expected at most one FILE argument");
      file = arg;
    }
  }
  return { file, diagnostics, help: false };
}

// Only LF delimits records. StringDecoder matches Node's replacement decoding,
// including split UTF-8 sequences; it does not strip BOMs or normalize CR.
async function* lines(chunks) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of chunks) {
    const text = decoder.write(chunk);
    let start = 0;
    let end;
    while ((end = text.indexOf("\n", start)) !== -1) {
      const line = pending + text.slice(start, end);
      pending = "";
      start = end + 1;
      yield line;
    }
    pending += text.slice(start);
  }
  // Reached only on clean EOF, never on an error or premature close.
  pending += decoder.end();
  if (pending.length !== 0) yield pending;
}

function streamError(code) {
  return Object.assign(new Error(code), { code });
}

// Await the write callback, not just write() acceptance. Abort also releases a
// pending diagnostic when another stream fails. Listeners are per-write, bounded.
function writeText(stream, text, signal) {
  return new Promise((resolve, reject) => {
    const onClose = () => done(streamError("ERR_STREAM_PREMATURE_CLOSE"));
    const onAbort = () => done(signal.reason);
    function done(error) {
      stream.off("error", done);
      stream.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    stream.once("error", done);
    stream.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    if (stream.destroyed || stream.writableEnded) return onClose();
    try { stream.write(text, done); } catch (error) { done(error); }
  });
}

/**
 * Consume a byte Readable and write JSONL to a Writable, ending output on success.
 * Owns input/output for this run (pipeline destroys them on fatal errors), but
 * leaves diagnostics open. Returns the batch exit status; no process globals.
 * The optional fifth argument selects { diagnostics: "jsonl" }; text is the default.
 */
async function runBatch(input, output, diagnostics, source = "standard input", options = {}) {
  const jsonl = options.diagnostics === "jsonl";
  let invalid = false;
  let recordsComplete = false;
  let outputFinished = false;
  let failure;
  const controller = new AbortController();
  const remember = (operation, error) => { failure ||= { operation, error }; };
  const onInputError = error => remember("read input", error);
  const onOutputError = error => {
    remember("write output", error);
    // A generator awaiting input may not reach another write. Cancel it now.
    controller.abort(error);
    input.destroy();
  };
  const onInputClose = () => {
    if (!input.readableEnded) remember("read input", streamError("ERR_STREAM_PREMATURE_CLOSE"));
  };
  const onOutputClose = () => {
    // Standard output can reset writable state on close; use the observed finish.
    if (!outputFinished) onOutputError(streamError("ERR_STREAM_PREMATURE_CLOSE"));
  };
  const onOutputFinish = () => {
    if (!recordsComplete) onOutputError(streamError("ERR_STREAM_PREMATURE_CLOSE"));
    else outputFinished = true;
  };
  const onDiagnosticError = error => {
    remember("write diagnostics", error);
    controller.abort(error);
    input.destroy();
  };
  const onDiagnosticClose = () => onDiagnosticError(streamError("ERR_STREAM_PREMATURE_CLOSE"));
  const writeEvent = async (event, signal) => {
    try {
      await writeText(diagnostics, JSON.stringify(event) + "\n", signal);
    } catch (error) {
      // Also retain ownership when a write rejects before an error event arrives.
      onDiagnosticError(error);
      throw error;
    }
  };
  input.on("error", onInputError);
  input.on("close", onInputClose);
  output.on("error", onOutputError);
  output.on("close", onOutputClose);
  output.on("finish", onOutputFinish);
  diagnostics.on("error", onDiagnosticError);
  diagnostics.on("close", onDiagnosticClose);
  try {
    if (output.destroyed || output.writableEnded) onOutputError(streamError("ERR_STREAM_PREMATURE_CLOSE"));
    if (diagnostics.destroyed || diagnostics.writableEnded) onDiagnosticClose();
    await pipeline(input, async function* (chunks, { signal }) {
      let line = 0;
      for await (const text of lines(chunks)) {
        line += 1;
        if (/^[ \t\r]*$/.test(text)) continue;
        let result;
        try {
          const order = parseOrder(text);
          result = {
            line,
            mixed: summarizePackaging(order.items, order.maxItemsPerBox, { mode: "mixed" }),
            "single-sku": summarizePackaging(order.items, order.maxItemsPerBox, { mode: "single-sku" }),
          };
        } catch (error) {
          invalid = true;
          if (jsonl) {
            await writeEvent({ version: 1, type: "record-error", line, message: error.message }, signal);
          } else {
            await writeText(diagnostics, "packaging-batch: " + source + ": line " + line + ": " + error.message + "\n", signal);
          }
          continue;
        }
        // I/O is outside the record-validation catch. Pipeline supplies output
        // backpressure and cancels an open input if the output closes or fails.
        yield JSON.stringify(result) + "\n";
      }
      recordsComplete = true;
    }, output, { signal: controller.signal });
    const exitCode = invalid ? 1 : 0;
    if (jsonl) {
      // Pipeline has exhausted input and finalized output. Never retry completion:
      // even a failed write may already have delivered some or all of its bytes.
      if (failure) throw failure.error;
      await writeEvent({ version: 1, type: "complete", exitCode }, controller.signal);
      // A late input error can arrive while the completion write is draining.
      if (failure) throw failure.error;
    }
    return exitCode;
  } catch (error) {
    remember("read input", error);
    const code = /^[A-Z0-9_]+$/.test(failure.error.code) ? failure.error.code : "IO_ERROR";
    if (!diagnostics.destroyed && !diagnostics.writableEnded) {
      try {
        const diagnostic = jsonl
          ? JSON.stringify({ version: 1, type: "fatal-error", operation: failure.operation.replace(" ", "-"), code: String(code) }) + "\n"
          : "packaging-batch: " + source + ": cannot " + failure.operation + " (" + code + ")\n";
        await writeText(diagnostics, diagnostic);
      } catch { /* A failed diagnostic sink cannot report its own failure. */ }
    }
    return 1;
  } finally {
    input.off("error", onInputError);
    input.off("close", onInputClose);
    output.off("error", onOutputError);
    output.off("close", onOutputClose);
    output.off("finish", onOutputFinish);
    diagnostics.off("error", onDiagnosticError);
    diagnostics.off("close", onDiagnosticClose);
  }
}

async function main() {
  // Also cover help/argument writes without forcing process.exit or truncating pipes.
  process.stdout.on("error", () => { process.exitCode = 1; });
  process.stderr.on("error", () => { process.exitCode = 1; });
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    await writeText(process.stderr, "packaging-batch: " + error.message + "\n" + USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    await writeText(process.stdout, USAGE);
    return;
  }
  const stdin = options.file === undefined || options.file === "-";
  const source = stdin ? "standard input" : JSON.stringify(options.file);
  const input = stdin ? process.stdin : createReadStream(options.file);
  process.exitCode = await runBatch(input, process.stdout, process.stderr, source, { diagnostics: options.diagnostics });
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = { runBatch };
