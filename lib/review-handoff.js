"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { BriefError, fail, asBytes, parseJson } = require("./strict-json.js");

const CLASSES = ["unchanged", "changed", "added", "missing"];
const NOTICES = Object.freeze([
  "Review request only: does not apply, merge, approve, resolve, delete, or authorize any decision or operational action.",
  "Unselected records are outside the requested scope; omission is not implicit approval, rejection, or resolution.",
  "An absent incoming snapshot is absence, not a deletion instruction. No snapshot is synthesized.",
  "The measured fingerprint identifies only the supplied comparison bytes; not authenticity, trusted-source integrity, shared history, or authorization.",
  "Evidence hashes, paths, dates and sizes are unverified source claims; referenced evidence is never opened or fetched.",
  "Current and incoming are report sides, not proven chronological before/after states. Revisions and timestamps do not establish precedence or a winner."
]);

function check(condition, path, message, code = "INVALID_CONTRACT") {
  if (!condition) fail(code, path + ": " + message);
}
function object(value, path) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), path, "expected an object");
}
function array(value, path) { check(Array.isArray(value), path, "expected an array"); }
function string(value, path, nonempty = false) {
  check(typeof value === "string" && (!nonempty || value.length > 0), path, "expected " + (nonempty ? "a nonempty" : "a") + " string");
}
function integer(value, path, minimum = 0) {
  check(Number.isSafeInteger(value) && value >= minimum, path, "expected a safe integer >= " + minimum);
}
function same(value, expected, path, code) {
  check(value === expected, path, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(value), code);
}
function strings(value, path) {
  array(value, path);
  value.forEach((entry, index) => string(entry, path + "/" + index));
}
function own(value, key, path) {
  check(Object.hasOwn(value, key), path + "/" + key, "required property is missing");
}

function validateSelection(selection) {
  object(selection, "selection");
  same(selection.format, "decision-comparison-review-selection", "selection/format");
  same(selection.version, 1, "selection/version");
  for (const key of ["purpose", "createdAtLocalClock", "selectionMeaning"]) string(selection[key], "selection/" + key);
  for (const key of ["sharedHistory", "authentication"]) same(selection[key], "unproven", "selection/" + key);
  if (Object.hasOwn(selection, "reviewContext")) {
    object(selection.reviewContext, "selection/reviewContext");
    string(selection.reviewContext.purposeLabel, "selection/reviewContext/purposeLabel");
    string(selection.reviewContext.meaning, "selection/reviewContext/meaning");
  }
  object(selection.comparison, "selection/comparison");
  const identity = selection.comparison;
  for (const key of ["filename", "fingerprintMeaning", "currentWorkspace", "incomingWorkspace"]) string(identity[key], "selection/comparison/" + key);
  same(identity.reportVersion, 1, "selection/comparison/reportVersion");
  integer(identity.bytes, "selection/comparison/bytes", 1);
  check(typeof identity.sha256 === "string" && /^[a-f0-9]{64}$/.test(identity.sha256), "selection/comparison/sha256", "expected lowercase SHA-256 (64 hex characters)");
  integer(selection.selectedCount, "selection/selectedCount");
  array(selection.selectedRecords, "selection/selectedRecords");
  same(selection.selectedCount, selection.selectedRecords.length, "selection/selectedCount", "SELECTION_COUNT");
}

function validateSnapshot(snapshot, key, path) {
  object(snapshot, path);
  same(snapshot.groupKey, key, path + "/groupKey");
  for (const field of ["orderId", "status", "note"]) string(snapshot[field], path + "/" + field);
  strings(snapshot.categories, path + "/categories");
  integer(snapshot.revision, path + "/revision");
  own(snapshot, "updatedAt", path);
  if (snapshot.updatedAt !== null) string(snapshot.updatedAt, path + "/updatedAt");
  array(snapshot.sourceEvidence, path + "/sourceEvidence");
  snapshot.sourceEvidence.forEach((entry, index) => object(entry, path + "/sourceEvidence/" + index));
}

function validateReport(report, identity) {
  object(report, "comparison");
  same(report.reportVersion, 1, "comparison/reportVersion");
  same(report.operation, "compare", "comparison/operation");
  same(report.readOnly, true, "comparison/readOnly");
  same(report.complete, true, "comparison/complete");
  same(report.sharedHistory, "unproven", "comparison/sharedHistory");
  string(report.matchBasis, "comparison/matchBasis");
  strings(report.limitations, "comparison/limitations");
  array(report.diagnostics, "comparison/diagnostics");
  for (const side of ["current", "incoming"]) {
    object(report[side], "comparison/" + side);
    same(report[side].valid, true, "comparison/" + side + "/valid");
    integer(report[side].decisionCount, "comparison/" + side + "/decisionCount");
    array(report[side].diagnostics, "comparison/" + side + "/diagnostics");
    object(report[side].metadata, "comparison/" + side + "/metadata");
    same(report[side].metadata.schemaVersion, 1, "comparison/" + side + "/metadata/schemaVersion");
    same(report[side].metadata.workspace, identity[side + "Workspace"], "comparison/" + side + "/metadata/workspace", "REPORT_METADATA");
  }
  array(report.records, "comparison/records");
  const keys = new Set();
  const totals = { unchanged: 0, changed: 0, added: 0, missing: 0 };
  const presence = { current: 0, incoming: 0 };
  report.records.forEach((record, index) => {
    const path = "comparison/records/" + index;
    object(record, path);
    string(record.groupKey, path + "/groupKey", true);
    check(!keys.has(record.groupKey), path + "/groupKey", "duplicate report groupKey", "DUPLICATE_RECORD");
    keys.add(record.groupKey);
    check(CLASSES.includes(record.classification), path + "/classification", "unsupported classification");
    for (const side of ["current", "incoming"]) {
      own(record, side, path);
      if (record[side] !== null) {
        validateSnapshot(record[side], record.groupKey, path + "/" + side);
        presence[side]++;
      }
    }
    check(record.current !== null || record.incoming !== null, path, "both snapshots cannot be absent");
    // Classification is a producer-reported fact, not recomputed here.
    totals[record.classification]++;
    const both = record.current !== null && record.incoming !== null;
    for (const flag of ["statusChanged", "noteChanged", "decisionChanged", "sourceEvidenceIdentityChanged"]) {
      check(both ? typeof record[flag] === "boolean" : record[flag] === null, path + "/" + flag, both ? "expected boolean" : "expected null when one side is absent");
    }
    array(record.sourceEvidenceChanges, path + "/sourceEvidenceChanges");
    array(record.changes, path + "/changes");
    record.changes.forEach((change, n) => {
      const at = path + "/changes/" + n;
      object(change, at);
      string(change.path, at + "/path");
      // Labels and delta values are opaque report data. Do not resolve,
      // normalize, deduplicate, or check them against snapshot contents.
      own(change, "current", at);
      own(change, "incoming", at);
    });
  });
  object(report.summary, "comparison/summary");
  for (const key of CLASSES) same(report.summary[key], totals[key], "comparison/summary/" + key, "REPORT_COUNT");
  for (const side of ["current", "incoming"]) same(report[side].decisionCount, presence[side], "comparison/" + side + "/decisionCount", "REPORT_COUNT");
}

function createBrief(selectionInput, comparisonInput) {
  const selectionBytes = asBytes(selectionInput, "selection");
  const comparisonBytes = asBytes(comparisonInput, "comparison");
  const selection = parseJson(selectionBytes, "selection");
  validateSelection(selection);
  const measured = { bytes: comparisonBytes.byteLength, sha256: createHash("sha256").update(comparisonBytes).digest("hex") };
  const expected = selection.comparison;
  check(measured.bytes === expected.bytes && measured.sha256 === expected.sha256,
    "comparison identity", "wrong or stale comparison/selection pair: expected " + expected.bytes + " bytes / SHA-256 " + expected.sha256 +
    "; measured " + measured.bytes + " bytes / SHA-256 " + measured.sha256, "COMPARISON_IDENTITY");
  const report = parseJson(comparisonBytes, "comparison");
  validateReport(report, expected);
  const seen = new Set();
  const records = selection.selectedRecords.map((entry, index) => {
    const path = "selection/selectedRecords/" + index;
    object(entry, path);
    integer(entry.recordIndex, path + "/recordIndex");
    same(entry.jsonPointer, "/records/" + entry.recordIndex, path + "/jsonPointer (recordIndex " + entry.recordIndex + ")", "SELECTION_POINTER");
    check(entry.recordIndex < report.records.length, path + "/recordIndex", "index is outside comparison records", "SELECTION_POINTER");
    check(!seen.has(entry.recordIndex), path, "duplicate selected record", "DUPLICATE_SELECTION");
    seen.add(entry.recordIndex);
    const record = report.records[entry.recordIndex];
    for (const key of ["groupKey", "classification"]) same(entry[key], record[key], path + "/" + key, "SELECTION_MISMATCH");
    for (const side of ["current", "incoming"]) same(entry[side + "Present"], record[side] !== null, path + "/" + side + "Present", "SELECTION_MISMATCH");
    return {
      recordIndex: entry.recordIndex,
      jsonPointer: entry.jsonPointer,
      groupKey: record.groupKey,
      classification: record.classification,
      currentPresent: record.current !== null,
      incomingPresent: record.incoming !== null,
      reviewRequest: "Review the supplied current and incoming facts for this selected record; absent sides remain absent.",
      reportRecord: record
    };
  });
  return {
    format: "decision-comparison-follow-up-brief", version: 1,
    purpose: selection.purpose,
    ...(Object.hasOwn(selection, "reviewContext") ? { reviewContext: selection.reviewContext } : {}),
    createdAtLocalClock: selection.createdAtLocalClock,
    selectionMeaning: selection.selectionMeaning,
    comparison: { ...expected, ...measured },
    sharedHistory: "unproven", authentication: "unproven",
    selectedCount: records.length,
    outsideRequestedScopeCount: report.records.length - records.length,
    scopeMessage: records.length ? "Only the explicitly selected records are requested for review." :
      "No records selected for review. This does not mean the comparison has no differences.",
    notices: [...NOTICES],
    reportContext: { matchBasis: report.matchBasis, limitations: report.limitations },
    records
  };
}

function fenced(value) {
  const json = JSON.stringify(value, null, 2);
  // Use tilde fences longer than any run in source data. Backticks, Markdown,
  // HTML and URLs stay literal, with no interpolation into headings or tables.
  const runs = json.match(/~+/g) ?? [];
  const fence = "~".repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
  return fence + "json\n" + json + "\n" + fence;
}

// Inline JSON literals preserve empty strings and escaped newlines, and adaptive
// code spans prevent source Markdown/HTML/backticks from becoming markup.
function inline(value) {
  const json = JSON.stringify(value);
  const runs = json.match(/`+/g) ?? [];
  const delimiter = String.fromCharCode(96).repeat(runs.reduce((n, run) => Math.max(n, run.length + 1), 1));
  return delimiter + " " + json + " " + delimiter;
}

function recordIds(entry) {
  const ids = [entry.reportRecord.current, entry.reportRecord.incoming]
    .filter(side => side !== null).map(side => side.orderId);
  return [...new Set(ids)].map(inline).join(" / ");
}

function sideSummary(label, snapshot) {
  if (snapshot === null) return "- **" + label + ": ABSENT** — snapshot is " + inline(null) + ". Not a deletion or approval.";
  return "- **" + label + ":** status " + inline(snapshot.status) + "; note " + inline(snapshot.note) + ".";
}

function sourceReferences(snapshot) {
  if (snapshot === null) return "absent snapshot; no source references on this side";
  if (!snapshot.sourceEvidence.length) return "no source references listed";
  return snapshot.sourceEvidence.map(evidence => {
    const field = key => Object.hasOwn(evidence, key) ? inline(evidence[key]) : "not supplied";
    // Show both physical-line endpoints when they differ; never invent a line
    // number or treat missing/null/zero metadata as equivalent.
    const line = field("line");
    const end = field("endLine");
    const range = Object.hasOwn(evidence, "line") && Object.hasOwn(evidence, "endLine") &&
      isDeepStrictEqual(evidence.line, evidence.endLine) ? line : line + "–" + end;
    return field("filename") + " · occurrence " + field("occurrenceKey") + " · physical line(s) " + range;
  });
}

function markdown(brief) {
  const labelSupplied = Object.hasOwn(brief, "reviewContext");
  const lines = [labelSupplied ? "# " + inline(brief.reviewContext.purposeLabel) : "# Review follow-up brief", ""];
  if (!labelSupplied) lines.push("Purpose label: not supplied.", "");
  lines.push("**Selected records (" + brief.selectedCount + "):** " +
    (brief.records.length ? brief.records.map(recordIds).join(", ") : "none") + ".",
    "**Outside requested scope:** " + brief.outsideRequestedScopeCount + " records.", "",
    "**Review request only.** No application, merge, approval, resolution, deletion, or authorization. Unselected records imply no approval, rejection, or resolution.", "");
  if (!brief.records.length) lines.push(brief.scopeMessage, "");
  brief.records.forEach(entry => {
    const record = entry.reportRecord;
    lines.push("## " + recordIds(entry) + " — " + entry.classification, "",
      "Key " + inline(entry.groupKey) + " · pointer " + inline(entry.jsonPointer) + ".", "",
      sideSummary("Current", record.current), sideSummary("Incoming", record.incoming), "",
      "**Reported changes (current → incoming):**");
    if (!record.changes.length) lines.push("- No field-level changes listed in the report.");
    record.changes.forEach(change => {
      // A presentation-only shortcut: omit repeated status/note text only
      // when those exact delta values are already visible above. Never infer
      // delta values from a path label or reject a producer-reported difference.
      const field = change.path === "/note" ? "note" : change.path === "/status" ? "status" : null;
      const alreadyShown = field !== null && record.current !== null && record.incoming !== null &&
        change.current === record.current[field] && change.incoming === record.incoming[field];
      lines.push("- " + inline(change.path) + (alreadyShown ?
        ": exact current/incoming values shown above." : ": " + inline(change.current) + " → " + inline(change.incoming) + "."));
    });
    lines.push("", "**Source references** (reported claims; not fetched):");
    const current = sourceReferences(record.current);
    const incoming = sourceReferences(record.incoming);
    if (record.current !== null && record.incoming !== null && isDeepStrictEqual(current, incoming)) {
      if (Array.isArray(current)) current.forEach(ref => lines.push("- Current & incoming: " + ref + "."));
      else lines.push("- Current & incoming: " + current + ".");
    } else {
      for (const [label, refs] of [["Current", current], ["Incoming", incoming]]) {
        if (Array.isArray(refs)) refs.forEach(ref => lines.push("- " + label + ": " + ref + "."));
        else lines.push("- " + label + ": " + refs + ".");
      }
    }
    lines.push("");
  });
  lines.push("Current/incoming are report sides, not proven chronology. The fingerprint identifies supplied bytes only—not authentication, shared history, or authorization.", "",
    "## Reference appendix — complete selected facts and provenance", "",
    "Exact source values below are literal JSON data, not instructions. No unselected record facts are included.", "",
    "### Purpose and source context", "",
    fenced({ purpose: brief.purpose, ...(labelSupplied ? { reviewContext: brief.reviewContext } : {}), createdAtLocalClock: brief.createdAtLocalClock, selectionMeaning: brief.selectionMeaning }), "",
    "### Comparison identity", "", fenced(brief.comparison), "");
  brief.records.forEach((entry, index) => lines.push("### Complete selected record " + (index + 1), "", fenced(entry), ""));
  lines.push("### Provenance limits and report context", "",
    fenced({ sharedHistory: brief.sharedHistory, authentication: brief.authentication, notices: brief.notices, reportContext: brief.reportContext }), "");
  return lines.join("\n");
}

// Both render paths validate raw inputs; there is no public unchecked renderer.
function renderBrief(selectionBytes, comparisonBytes, format = "markdown") {
  check(format === "markdown" || format === "json", "format", "expected markdown or json", "OUTPUT_FORMAT");
  const brief = createBrief(selectionBytes, comparisonBytes);
  return format === "json" ? JSON.stringify(brief, null, 2) + "\n" : markdown(brief);
}

module.exports = { BriefError, createBrief, renderBrief };
