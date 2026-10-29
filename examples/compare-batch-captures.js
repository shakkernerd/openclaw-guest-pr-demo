#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");

const USAGE = "Usage: node examples/compare-batch-captures.js [--mapping FILE] [--] BEFORE_DIRECTORY AFTER_DIRECTORY\n" +
  "       node examples/compare-batch-captures.js --help\n";
const LIMITS = [
  "Comparison exit 0 means comparison/report production, never producer or capture-command success. Output failure can still leave partial or complete-looking JSON.",
  "Whole-capture, trusted local files only: the reader and companion buffer complete streams/reports in memory; no bounded-memory or hostile JSON-member-duplication guarantee.",
  "No producer, packing calculation or original order input is run/read. Prepared metadata and historical notes do not establish execution; capture-command status is not stored in these sidecars.",
  "Mapping is a caller assertion, not verified order identity. No mapping means no order correspondence. Absence means not observed, never added or deleted.",
  "All observations, reader issues and limits remain attached to their own attempt. No deduplication, merged timeline, inferred gaps or whole-batch unchanged verdict.",
  "Completion is not process exit. Even complete(1) with normal exit 1 cannot exclude a completion-diagnostic write failure after bytes were delivered.",
  "Files must be stable and deliberately paired by the caller. No input snapshot, authentication, atomic multi-file read, durability, intended-input completeness or physical packing is established.",
];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));
const positive = value => Number.isSafeInteger(value) && value > 0;
const errorCode = error => typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "IO_ERROR";

function argumentsFor(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const directories = [];
  let mapping;
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (options && arg === "--") options = false;
    else if (options && arg === "--mapping" && mapping === undefined) {
      mapping = args[++index];
      if (!mapping || mapping.startsWith("-")) throw new Error("expected a mapping file (use ./ for dash-leading names)");
    } else if (!arg || arg === "-" || (options && arg.startsWith("-"))) {
      throw new Error("unknown option or empty/stdin path");
    } else directories.push(arg);
  }
  if (directories.length !== 2) throw new Error("expected ordered before and after directories");
  return { directories, mapping };
}

// Do not normalize away symlink/.. filesystem traversal. Prefix relative paths
// for the unchanged reader, whose CLI rejects dash-leading arguments.
const inDirectory = (directory, file) =>
  (path.isAbsolute(directory) ? directory : "." + path.sep + directory) + path.sep + file;

function jsonFile(file, optional = false) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    return { state: optional && error.code === "ENOENT" ? "absent" : "unresolved",
      problem: { code: "read-error", error: errorCode(error) } };
  }
  try { return { state: "read", record: JSON.parse(text) }; } catch {
    return { state: "unresolved", problem: { code: "malformed-json" } };
  }
}

function resultKind(record) {
  if (!keys(record, ["version", "state", "exitCode", "signal", "launchError"]) ||
      record.version !== 1 || record.state !== "observed") return null;
  const { exitCode, signal, launchError } = record;
  if (Number.isSafeInteger(exitCode) && exitCode >= 0 && signal === null && launchError === null) return "normal-exit";
  if (exitCode === null && typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal) && launchError === null) return "signal";
  if (exitCode === null && signal === null && keys(launchError, ["code", "message"]) &&
      (launchError.code === null || typeof launchError.code === "string" || Number.isSafeInteger(launchError.code)) &&
      typeof launchError.message === "string") return "launch-error";
  return null;
}

function readResult(directory) {
  const result = jsonFile(inDirectory(directory, "result.json"));
  if (result.state !== "read") return result;
  const kind = resultKind(result.record);
  return kind ? { state: "observed", kind, record: result.record } :
    { state: "unresolved", record: result.record, problem: { code: "invalid-result" } };
}

function readAttempt(directory) {
  const attempt = jsonFile(inDirectory(directory, "attempt.json"), true);
  if (attempt.state !== "read") return attempt;
  const r = attempt.record;
  if (keys(r, ["version", "state", "executable", "args", "cwd"]) && r.version === 1 &&
      r.state === "prepared" && typeof r.executable === "string" && typeof r.cwd === "string" &&
      Array.isArray(r.args) && r.args.every(arg => typeof arg === "string")) {
    return { state: "prepared-context", record: r };
  }
  return { state: "unresolved", record: r, problem: { code: "invalid-attempt-context" } };
}

function readMapping(file) {
  if (file === undefined) return { state: "none", pairs: [] };
  const mapping = jsonFile(file);
  if (mapping.state !== "read") return { ...mapping, pairs: [] };
  const r = mapping.record;
  const before = new Set();
  const after = new Set();
  const valid = keys(r, ["version", "pairs"]) && r.version === 1 && Array.isArray(r.pairs) &&
    r.pairs.every(pair => {
      if (!keys(pair, ["before", "after"]) || !positive(pair.before) || !positive(pair.after) ||
          before.has(pair.before) || after.has(pair.after)) return false;
      before.add(pair.before);
      after.add(pair.after);
      return true;
    });
  return valid ? { state: "explicit", pairs: r.pairs } :
    { state: "unresolved", record: r, pairs: [], problem: { code: "invalid-mapping" } };
}

// Reuse the real, unchanged reader rather than cloning its protocol interpreter.
// Only this fixed reader entry point is launched, never anything from metadata.
function runReader(directory) {
  return new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] };
    let error = null;
    let launched = false;
    let child;
    const finish = (exitCode, signal) => {
      const stdout = Buffer.concat(chunks.stdout).toString("utf8");
      const stderr = Buffer.concat(chunks.stderr).toString("utf8");
      let report = null;
      try { report = JSON.parse(stdout); } catch { /* Report problem is explicit below. */ }
      resolve({ reader: { exitCode, signal, error, stderr }, report });
    };
    try {
      child = spawn(process.execPath, [path.join(__dirname, "read-batch-captures.js"),
        inDirectory(directory, "stdout.jsonl"), inDirectory(directory, "stderr.jsonl")],
      { stdio: ["ignore", "pipe", "pipe"] });
    } catch (failure) { error = errorCode(failure); finish(null, null); return; }
    child.once("spawn", () => { launched = true; });
    child.once("error", failure => { error = errorCode(failure); });
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", chunk => chunks[name].push(chunk));
      child[name].on("error", failure => { error ||= errorCode(failure); });
    }
    child.once("close", (code, signal) => finish(launched ? code : null, launched ? signal : null));
  });
}

// These describe failed/incomplete producer activity, not malformed stream files.
// All other reader issues block comparison eligibility. Keep every issue verbatim.
const NON_BLOCKING = new Set(["missing-completion", "fatal-observed"]);
async function inspect(directory) {
  const processResult = readResult(directory);
  const attempt = readAttempt(directory);
  const { reader, report } = await runReader(directory);
  const problems = [];
  const notes = [];
  if (processResult.state !== "observed") problems.push({ code: "unresolved-process-result", problem: processResult.problem, file: "result.json" });
  if (reader.exitCode !== 0 || reader.signal !== null || reader.error !== null) problems.push({ code: "reader-failed" });
  // Report bytes are from the fixed local reader, not a supplied saved-report API.
  const usable = object(report) && Array.isArray(report.rows) && Array.isArray(report.issues) &&
    Array.isArray(report.terminalEvents) && object(report.observed) && Array.isArray(report.limits);
  if (!usable) problems.push({ code: "unusable-reader-report" });
  else {
    for (const issue of report.issues) if (!NON_BLOCKING.has(issue.code)) problems.push({ code: "invalid-stream-evidence", issue });
    if (processResult.state === "observed") {
      const r = processResult.record;
      const completions = report.terminalEvents.filter(event => event.record.type === "complete");
      if (processResult.kind === "normal-exit" && r.exitCode === 0 &&
          (completions.length !== 1 || completions[0].record.exitCode !== 0 ||
           report.observed.rejections || report.observed.fatals)) {
        problems.push({ code: "exit-zero-without-clean-completion" });
      }
      if (processResult.kind === "launch-error" &&
          (report.observed.stdout.frames || report.observed.stderr.frames ||
           report.observed.stdout.fragments || report.observed.stderr.fragments)) {
        problems.push({ code: "launch-error-with-stream-content" });
      }
      if (completions.some(event => processResult.kind !== "normal-exit" || event.record.exitCode !== r.exitCode)) {
        notes.push({ code: "completion-not-confirmed-by-process" });
      }
    }
  }
  return { directory, processResult, attempt, reader, report: usable ? report : null, problems, notes };
}

function indexReport(report) {
  // The reader already groups each unique line's complete outcome array. Index
  // those arrays, never individual outcomes, so duplicates/conflicts stay intact.
  const outcomesByLine = new Map();
  const disagreementFrames = { stdout: new Set(), stderr: new Set() };
  for (const row of report?.rows ?? []) outcomesByLine.set(row.line, row.outcomes);
  for (const issue of report?.issues ?? []) {
    if (issue.code === "summary-disagreement") disagreementFrames[issue.stream].add(issue.frame);
  }
  return { outcomesByLine, disagreementFrames };
}

function group(index, line) {
  const outcomes = index.outcomesByLine.get(line) ?? [];
  const inconsistent = outcomes.some(outcome => index.disagreementFrames[outcome.stream].has(outcome.frame));
  const state = outcomes.length === 0 ? "not-observed" : outcomes.length !== 1 || inconsistent ? "ambiguous" :
    outcomes[0].stream === "stdout" ? "summary" : "rejection";
  return { line, state, outcomes };
}

function comparePair(pair, beforeIndex, afterIndex) {
  const before = group(beforeIndex, pair.before);
  const after = group(afterIndex, pair.after);
  const fields = [];
  let change;
  if ([before.state, after.state].includes("ambiguous")) change = "ambiguous";
  else if ([before.state, after.state].includes("not-observed")) change = "not-observed";
  else if (before.state !== after.state) change = "outcome-changed";
  else {
    const a = before.outcomes[0].record;
    const b = after.outcomes[0].record;
    if (before.state === "summary") {
      for (const policy of ["mixed", "single-sku"]) {
        for (const field of Object.keys(a[policy]).sort()) {
          if (a[policy][field] !== b[policy][field]) fields.push({ policy, field, before: a[policy][field], after: b[policy][field] });
        }
      }
    } else if (a.message !== b.message) fields.push({ field: "message", before: a.message, after: b.message });
    change = fields.length ? before.state + "-changed" : "unchanged";
  }
  return { before, after, change, fields };
}

function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw Object.assign(new Error("write made no progress"), { code: "EIO" });
    offset += count;
  }
}
const diagnostic = text => { try { writeAll(2, text); } catch { /* Best effort only. */ } };

async function main(args) {
  let options;
  try { options = argumentsFor(args); } catch {
    try { writeAll(2, USAGE); } catch { return 1; }
    return 2;
  }
  if (options.help) { try { writeAll(1, USAGE); return 0; } catch { return 1; } }
  const mapping = readMapping(options.mapping);
  const before = await inspect(options.directories[0]);
  const after = await inspect(options.directories[1]);
  const beforeIndex = indexReport(before.report);
  const afterIndex = indexReport(after.report);
  const unresolved = mapping.state === "unresolved" || before.problems.length > 0 || after.problems.length > 0;
  const paired = { before: new Set(mapping.pairs.map(pair => pair.before)), after: new Set(mapping.pairs.map(pair => pair.after)) };
  const processChange = [before, after].some(side => side.processResult.state !== "observed") ? "unresolved" :
    isDeepStrictEqual(before.processResult.record, after.processResult.record) ? "unchanged" : "changed";
  const report = {
    version: 1, state: unresolved ? "unresolved" : "compared",
    processOutcomes: { before: before.processResult, after: after.processResult, change: processChange },
    orders: { mapping, pairs: mapping.pairs.map(pair => comparePair(pair, beforeIndex, afterIndex)),
      unmatched: {
        before: (before.report?.rows ?? []).filter(row => !paired.before.has(row.line)),
        after: (after.report?.rows ?? []).filter(row => !paired.after.has(row.line)),
      } },
    evidence: Object.fromEntries([["before", before], ["after", after]].map(([name, side]) => {
      const { processResult, ...evidence } = side;
      return [name, evidence];
    })),
    limits: LIMITS,
  };
  try { writeAll(1, JSON.stringify(report) + "\n"); } catch (error) {
    diagnostic("compare-batch-captures: cannot write report (" + errorCode(error) + ")\n");
    return 1;
  }
  return unresolved ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  diagnostic("compare-batch-captures: cannot compare (" + errorCode(error) + ")\n");
  process.exitCode = 1;
});
