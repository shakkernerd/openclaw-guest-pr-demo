#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { isDeepStrictEqual } = require("node:util");

const USAGE = "Usage: node examples/read-batch-captures.js STDOUT_FILE STDERR_FILE\n" +
  "Exactly two file paths; no options or stdin. Use ./ for dash-leading filenames.\n";
const LIMITS = [
  "Two files do not establish pairing, draining, process result, intended input completeness, persistence or physical packing.",
  "No cross-stream chronology is inferred; missing input lines are not classified.",
  "Completion is not a process result and cannot exclude a later diagnostic-write failure. Even captured complete(1) plus a separately observed normal producer exit 1 cannot distinguish rejection-only completion from completion-diagnostic bytes delivered before that write failed.",
  "Only supported LF-terminated observations are counted; missing, fatal or conflicting evidence remains unresolved.",
  "Trusted producer captures only: no order validation, packing recalculation, hostile JSON-member-duplication audit or unbounded-input guarantee.",
  "Reader exit 0 means only that a report was produced, not that the batch succeeded.",
];
const SUMMARY_KEYS = [
  "mode", "maxItemsPerBox", "totalItems", "boxCount",
  "fullBoxes", "partialBoxes", "unusedItemSlots",
];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => count(value) && value > 0;
const position = observation => ({ stream: observation.stream, frame: observation.frame });
const errorCode = error => typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
  ? error.code : "IO_ERROR";

function summary(value, mode) {
  return keys(value, SUMMARY_KEYS) && value.mode === mode && positive(value.maxItemsPerBox) &&
    ["totalItems", "boxCount", "fullBoxes", "partialBoxes"].every(key => count(value[key])) &&
    typeof value.unusedItemSlots === "string" && /^(0|[1-9][0-9]*)$/.test(value.unusedItemSlots);
}

// Validate the emitted envelopes and scalar domains, not orders or arithmetic.
function frameProblem(record, stream) {
  if (stream === "stdout") {
    return keys(record, ["line", "mixed", "single-sku"]) && positive(record.line) &&
      summary(record.mixed, "mixed") && summary(record["single-sku"], "single-sku")
      ? null : "invalid-frame";
  }
  if (!object(record)) return "invalid-frame";
  if (record.version !== 1 || !["record-error", "complete", "fatal-error"].includes(record.type)) {
    return "unsupported-frame";
  }
  if (record.type === "record-error") {
    return keys(record, ["version", "type", "line", "message"]) && positive(record.line) &&
      typeof record.message === "string" ? null : "invalid-frame";
  }
  if (record.type === "complete") {
    return keys(record, ["version", "type", "exitCode"]) &&
      (record.exitCode === 0 || record.exitCode === 1) ? null : "invalid-frame";
  }
  return keys(record, ["version", "type", "operation", "code"]) &&
    ["read-input", "write-output", "write-diagnostics"].includes(record.operation) &&
    typeof record.code === "string" && /^[A-Z0-9_]+$/.test(record.code) ? null : "invalid-frame";
}

function inspectCaptures(captures) {
  const report = { observed: {}, rows: [], terminalEvents: [], issues: [], limits: [...LIMITS] };
  const rows = new Map();
  const completions = [];
  const fatals = [];
  let rejections = 0;
  let summaries = 0;
  const issue = (code, observation, extra = {}) => {
    report.issues.push({ code, ...position(observation), ...extra });
  };

  // Fixed traversal makes report ordering deterministic, not a merged timeline.
  for (const stream of ["stdout", "stderr"]) {
    const capture = captures[stream];
    const observed = { frames: 0, accepted: 0, fragments: 0, readError: capture.readError ?? null };
    report.observed[stream] = observed;
    if (capture.readError) {
      report.issues.push({ code: "read-error", stream, error: capture.readError });
      continue;
    }
    let previousOutcome;
    let lastTerminal;
    const frames = capture.text.split("\n");
    const tail = frames.pop(); // A normal final LF does not invent a blank frame.
    for (let index = 0; index < frames.length; index += 1) {
      const text = frames[index];
      const location = { stream, frame: index + 1 };
      observed.frames += 1;
      if (/^[ \t\r]*$/.test(text)) {
        issue("blank-frame", location);
        continue;
      }
      let record;
      try { record = JSON.parse(text); } catch {
        issue("malformed-json", location, { text });
        continue;
      }
      const problem = frameProblem(record, stream);
      if (problem) {
        issue(problem, location, { text });
        continue;
      }
      observed.accepted += 1;
      const observation = { ...location, record };
      if (stream === "stdout" || record.type === "record-error") {
        if (previousOutcome && record.line <= previousOutcome.record.line) {
          issue("non-increasing-line", observation, { previous: position(previousOutcome) });
        }
        previousOutcome = observation;
        if (lastTerminal) issue("outcome-after-terminal", observation, { previous: position(lastTerminal) });
        let row = rows.get(record.line);
        if (!row) {
          row = { line: record.line, outcomes: [] };
          rows.set(record.line, row);
        }
        const same = row.outcomes.filter(item => item.stream === stream);
        const other = row.outcomes.find(item => item.stream !== stream);
        if (same.length) {
          issue("duplicate-outcome", observation, { previous: position(same[0]) });
          if (same.some(item => !isDeepStrictEqual(item.record, record))) {
            issue("conflicting-outcomes", observation, { line: record.line });
          }
        }
        if (other) issue("overlapping-outcomes", observation, { previous: position(other) });
        row.outcomes.push(observation);
        if (stream === "stdout") {
          summaries += 1;
          for (const field of ["maxItemsPerBox", "totalItems"]) {
            if (record.mixed[field] !== record["single-sku"][field]) {
              issue("summary-disagreement", observation, { field });
            }
          }
        } else rejections += 1;
      } else {
        report.terminalEvents.push(observation);
        lastTerminal = observation;
        if (record.type === "complete") {
          if (completions.length) {
            issue("duplicate-completion", observation, { previous: position(completions[0]) });
            if (completions.some(item => item.record.exitCode !== record.exitCode)) {
              issue("conflicting-completions", observation);
            }
          }
          if (fatals.length) issue("completion-after-fatal", observation, { previous: position(fatals[0]) });
          completions.push(observation);
        } else {
          issue("fatal-observed", observation);
          if (fatals.length) issue("duplicate-fatal", observation, { previous: position(fatals[0]) });
          fatals.push(observation);
          // Complete then fatal is supported failure evidence, not an ordering error.
        }
      }
    }
    if (tail !== "") {
      observed.fragments = 1;
      issue("incomplete-fragment", { stream, frame: frames.length + 1 }, { text: tail });
    }
  }
  report.rows = [...rows.values()].sort((a, b) => a.line - b.line);
  Object.assign(report.observed, { summaries, rejections, completions: completions.length, fatals: fatals.length });
  if (!completions.length) report.issues.push({ code: "missing-completion", stream: "stderr" });
  for (const completion of completions) {
    if (completion.record.exitCode === 0 && rejections > 0) {
      issue("completion-zero-with-rejections", completion);
    } else if (completion.record.exitCode === 1 && rejections === 0) {
      // This is an evidence gap, not a claim that the producer had no rejections.
      issue("completion-one-without-observed-rejection", completion);
    }
  }
  return report;
}

function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw Object.assign(new Error("write made no progress"), { code: "EIO" });
    offset += written;
  }
}

// Synchronous file reads/writes keep this small, whole-capture example standalone.
// Return values are reader statuses, never producer statuses.
function main(args) {
  if (args.length !== 2 || args.some(arg => !arg || arg.startsWith("-"))) {
    try { writeAll(2, USAGE); } catch { return 1; }
    return 2;
  }
  const captures = {};
  for (const [index, stream] of ["stdout", "stderr"].entries()) {
    try { captures[stream] = { text: fs.readFileSync(args[index], "utf8") }; } catch (error) {
      captures[stream] = { readError: errorCode(error) };
    }
  }
  const report = inspectCaptures(captures);
  try { writeAll(1, JSON.stringify(report) + "\n"); } catch (error) {
    try { writeAll(2, "read-batch-captures: cannot write report (" + errorCode(error) + ")\n"); } catch { /* Best effort only. */ }
    return 1;
  }
  return captures.stdout.readError || captures.stderr.readError ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
