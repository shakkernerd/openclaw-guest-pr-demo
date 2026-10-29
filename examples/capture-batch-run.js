#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const USAGE = "Usage: node examples/capture-batch-run.js [--fail-fast] [--] ORDERS_FILE NEW_DIRECTORY\n" +
  "       node examples/capture-batch-run.js --help\n";

function parseArguments(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const files = [];
  let failFast = false;
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") options = false;
    else if (options && arg === "--fail-fast" && !failFast) failFast = true;
    else if (!arg || (options && arg.startsWith("-"))) throw new Error("expected two paths and optional --fail-fast");
    else files.push(arg);
  }
  if (files.length !== 2 || files[0] === "-") throw new Error("expected one orders file and one new directory; no stdin");
  return { input: files[0], directory: files[1], failFast };
}

const errorDetails = error => ({ code: error.code ?? null, message: error.message });
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

// One spawn, no shell, timeout, retry, decoding, or parent-side stream buffering.
// Inherited file descriptors keep producer bytes separate from wrapper messages.
function observe(executable, args, stdout, stderr) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, { stdio: ["ignore", stdout, stderr] });
    } catch (error) {
      resolve({ exitCode: null, signal: null, launchError: errorDetails(error) });
      return;
    }
    let launched = false;
    let launchError = null;
    child.once("spawn", () => { launched = true; });
    child.once("error", error => { launchError = errorDetails(error); });
    child.once("close", (code, signal) => resolve({
      // Failed spawn can supply an OS error number as code, not a producer exit.
      exitCode: launched ? code : null,
      signal: launched ? signal : null,
      launchError,
    }));
  });
}

async function main(args) {
  let options;
  try { options = parseArguments(args); } catch (error) {
    process.stderr.write("capture-batch-run: " + error.message + "\n" + USAGE);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { directory: requestedDirectory, failFast } = options;
  // Resolve existing input in this process, before setup or child fd redirection.
  // Native realpath follows symlink/.. traversal; path.resolve would erase it.
  let input = options.input;
  try { input = fs.realpathSync.native(input); } catch {
    // Preserve unresolved spelling so missing/unreadable input stays producer-owned.
  }
  const inputWasPresent = fs.existsSync(input);
  // Let the filesystem traverse the supplied output path and refuse any existing
  // final entry. Only then anchor artifact joins to the directory actually made.
  fs.mkdirSync(requestedDirectory);
  const directory = fs.realpathSync.native(requestedDirectory);
  const executable = process.execPath;
  const producerArgs = [path.join(__dirname, "..", "packaging-batch-cli.js"),
    "--diagnostics=jsonl", ...(failFast ? ["--fail-fast"] : []), "--", input];
  save(path.join(directory, "attempt.json"), {
    version: 1, state: "prepared", executable, args: producerArgs, cwd: process.cwd(),
  });
  const descriptors = [];
  let result;
  try {
    descriptors.push(fs.openSync(path.join(directory, "stdout.jsonl"), "wx"));
    descriptors.push(fs.openSync(path.join(directory, "stderr.jsonl"), "wx"));
    // Also catch dangling input symlinks/parent aliases made readable by setup.
    // Ordinary missing input remains missing and is diagnosed by the producer.
    if (!inputWasPresent && fs.existsSync(input)) {
      throw new Error("orders input appeared during capture setup; refusing to read capture artifacts");
    }
    result = await observe(executable, producerArgs, ...descriptors);
  } finally {
    // Attempt both closes, but do not publish a terminal record if either fails.
    let failure;
    for (const fd of descriptors) {
      try { fs.closeSync(fd); } catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  }
  save(path.join(directory, "result.json"), { version: 1, state: "observed", ...result });
  return result.launchError || result.signal || result.exitCode === null ? 1 : result.exitCode;
}

// Default signal behavior deliberately leaves an unfinished attempt if this
// observer is interrupted. It does not manage a process tree or invent a result.
process.stdout.on("error", () => { process.exitCode = 1; });
process.stderr.on("error", () => { process.exitCode = 1; });
main(process.argv.slice(2)).then(code => { process.exitCode ||= code; }).catch(error => {
  process.exitCode = 1;
  process.stderr.write("capture-batch-run: " + error.message + "\n");
});
