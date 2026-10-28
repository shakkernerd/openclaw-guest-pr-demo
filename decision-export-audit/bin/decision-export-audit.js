"use strict";

const { openSync, fstatSync, readSync, closeSync, constants } = require("node:fs");
const { createHash } = require("node:crypto");
const { parseExport, validateExport, compareExports } = require("../lib/index.js");
const { MAX_BYTES, LIMITATIONS, clone, diagnostic } = require("../lib/common.js");

const USAGE = [
  "Usage:",
  "  node decision-export-audit/bin/decision-export-audit.js --help",
  "  node decision-export-audit/bin/decision-export-audit.js validate <export-file>",
  "  node decision-export-audit/bin/decision-export-audit.js compare <current-file> <incoming-file>",
  "",
  "Pretty-printed JSON review reports on stdout; never applies or merges decisions.",
  "Current and incoming evidence remain separate. Declared hashes are not authorization.",
  "Revision numbers alone never establish shared history or select a winner.",
  "Reads only the named local regular files (up to 16 MiB each); never follows evidence paths.",
  "No output-file, apply, merge, network, or configuration operation exists.",
  "",
  "Exit codes:",
  "  0  Valid export or complete comparison (including differences and warnings), or help",
  "  1  Invalid input, parsing/size/depth failure, or workspace mismatch; comparison incomplete",
  "  2  Invalid command/arguments or file-read failure",
  "",
  "Quote paths with spaces. Paths beginning with '-' need a prefix, for example ./-export.",
  "Never redirect stdout over an input file: shell redirection can truncate it before Node starts.",
  "",
].join("\n");

function readInput(path) {
  const input = { path, bytes: null, sha256: null };
  let fd;
  try {
    // Nonblocking open lets us reject FIFOs/devices rather than waiting for data.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error("Expected a regular file."), { code: "NOT_REGULAR_FILE" });
    if (stat.size > MAX_BYTES) throw Object.assign(new Error("Input exceeds the 16 MiB local limit."), { code: "INPUT_TOO_LARGE" });
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_BYTES) throw Object.assign(new Error("Input grew beyond the 16 MiB local limit."), { code: "INPUT_TOO_LARGE" });
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    input.bytes = bytes.length;
    input.sha256 = createHash("sha256").update(bytes).digest("hex");
    return { input, parsed: parseExport(bytes), ioError: false };
  } catch (error) {
    const tooLarge = error.code === "INPUT_TOO_LARGE";
    return {
      input, ioError: !tooLarge,
      parsed: { ok: false, value: null, diagnostics: [diagnostic(tooLarge ? "INPUT_TOO_LARGE" : "FILE_READ_ERROR", "", error.message, { systemCode: error.code || null })] },
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function failedValidation(parsed) {
  return { valid: false, decisionCount: null, diagnostics: parsed.diagnostics, metadata: null, evidence: null };
}

function main(args) {
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, ...paths] = args;
  const arity = command === "validate" ? 1 : command === "compare" ? 2 : null;
  if (arity === null || paths.length !== arity || paths.some(path => !path.length || path.startsWith("-"))) {
    process.stderr.write("Invalid command or arguments.\n" + USAGE);
    return 2;
  }
  const current = readInput(paths[0]);
  let report;
  let code;
  if (command === "validate") {
    const result = current.parsed.ok ? validateExport(current.parsed.value) : failedValidation(current.parsed);
    const value = current.parsed.value;
    report = {
      reportVersion: 1, operation: "validate", readOnly: true, sharedHistory: "unproven",
      limitations: [...LIMITATIONS], input: current.input, ...result,
      metadata: result.valid ? { schemaVersion: value.schemaVersion, workspace: value.workspace, meaning: value.meaning } : null,
      evidence: result.valid ? clone(value.evidence) : null,
    };
    code = current.ioError ? 2 : result.valid ? 0 : 1;
  } else {
    const incoming = readInput(paths[1]);
    report = compareExports(current.parsed.value, incoming.parsed.value);
    if (!current.parsed.ok) report.current = failedValidation(current.parsed);
    if (!incoming.parsed.ok) report.incoming = failedValidation(incoming.parsed);
    report.current.input = current.input;
    report.incoming.input = incoming.input;
    code = current.ioError || incoming.ioError ? 2 : report.complete ? 0 : 1;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return code;
}

if (require.main === module) {
  // head may close stdout, stderr, or both (2>&1) before a write completes.
  // Preserve main's result; do not log to a closed stream or hide other errors.
  const onOutputError = error => {
    if (error.code !== "EPIPE") throw error;
  };
  process.stdout.on("error", onOutputError);
  process.stderr.on("error", onOutputError);
  process.exitCode = main(process.argv.slice(2));
}
