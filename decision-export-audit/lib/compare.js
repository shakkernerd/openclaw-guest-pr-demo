"use strict";

const { isDeepStrictEqual } = require("node:util");
const { validateExport } = require("./validate.js");
const { LIMITATIONS, clone, compareKeys, pointer, isObject, diagnostic } = require("./common.js");
const IDENTITY_FIELDS = new Set(["version", "occurrenceKey", "filename", "sourcePath", "sourceSha256", "line", "endLine"]);

function diffFields(current, incoming, path = "") {
  // JSON numeric spellings 0 and -0 denote the same value for this contract.
  // Do not emit a false 0 -> 0 delta after JSON report serialization.
  if (current === incoming || isDeepStrictEqual(current, incoming)) return [];
  if (isObject(current) && isObject(incoming)) {
    return [...new Set([...Object.keys(current), ...Object.keys(incoming)])].sort(compareKeys)
      .flatMap(key => diffFields(current[key], incoming[key], pointer(path, key)));
  }
  return [{ path, current: current === undefined ? null : clone(current), incoming: incoming === undefined ? null : clone(incoming) }];
}

function collectionChanges(current, incoming, key, path) {
  const a = new Map(current.map(value => [value[key], value]));
  const b = new Map(incoming.map(value => [value[key], value]));
  return [...new Set([...a.keys(), ...b.keys()])].sort(compareKeys).flatMap(identity => {
    const left = a.get(identity);
    const right = b.get(identity);
    const changes = diffFields(left, right, pointer(path, identity));
    if (!changes.length) return [];
    return [{
      [key]: identity,
      classification: !left ? "added" : !right ? "missing" : "changed",
      current: left ? clone(left) : null,
      incoming: right ? clone(right) : null,
      changes,
    }];
  });
}

function side(value, validation) {
  return {
    ...validation,
    metadata: validation.valid ? { schemaVersion: value.schemaVersion, workspace: value.workspace, meaning: value.meaning } : null,
    evidence: validation.valid ? clone(value.evidence) : null,
  };
}

function compareRecord(groupKey, current, incoming) {
  if (!current || !incoming) {
    return {
      groupKey, classification: current ? "missing" : "added",
      current: current ? clone(current) : null, incoming: incoming ? clone(incoming) : null,
      statusChanged: null, noteChanged: null, decisionChanged: null,
      sourceEvidenceIdentityChanged: null, sourceEvidenceChanges: [], changes: [],
    };
  }
  const changes = [];
  for (const key of ["orderId", "status", "note", "revision", "updatedAt"]) {
    changes.push(...diffFields(current[key], incoming[key], pointer("", key)));
  }
  if (!isDeepStrictEqual([...current.categories].sort(compareKeys), [...incoming.categories].sort(compareKeys))) {
    changes.push({ path: "/categories", current: clone(current.categories), incoming: clone(incoming.categories) });
  }
  const sourceEvidenceChanges = collectionChanges(current.sourceEvidence, incoming.sourceEvidence, "occurrenceKey", "/sourceEvidence");
  let identityChanged = false;
  for (const entry of sourceEvidenceChanges) {
    entry.identityChanged = entry.classification !== "changed" ||
      [...IDENTITY_FIELDS].some(field => !isDeepStrictEqual(entry.current[field], entry.incoming[field]));
    if (entry.identityChanged) identityChanged = true;
    changes.push(...entry.changes);
  }
  changes.sort((a, b) => compareKeys(a.path, b.path));
  const statusChanged = current.status !== incoming.status;
  const noteChanged = current.note !== incoming.note;
  return {
    groupKey, classification: changes.length ? "changed" : "unchanged",
    current: clone(current), incoming: clone(incoming),
    statusChanged, noteChanged, decisionChanged: statusChanged || noteChanged,
    sourceEvidenceIdentityChanged: identityChanged, sourceEvidenceChanges, changes,
  };
}

/** Pure comparison of parsed exports. No ancestry, authorization, or winner is inferred. */
function compareExports(current, incoming) {
  const a = validateExport(current);
  const b = validateExport(incoming);
  const report = {
    reportVersion: 1, operation: "compare", readOnly: true, complete: false,
    sharedHistory: "unproven", matchBasis: "exact workspace and groupKey only; not source identity or lineage",
    limitations: [...LIMITATIONS],
    current: side(current, a), incoming: side(incoming, b),
    diagnostics: [], summary: null, evidenceChanged: null, sourceEvidenceIdentityChanged: null,
    evidenceChanges: [], metadataChanges: [], records: [],
  };
  if (!a.valid || !b.valid) {
    report.diagnostics.push(diagnostic("INVALID_COMPARISON_INPUT", "", "Both exports must be valid and unambiguous; no record classifications were produced."));
    return report;
  }
  report.metadataChanges = diffFields(report.current.metadata, report.incoming.metadata);
  for (const key of ["datasetSha256", "reviewDate", "csv", "report"]) {
    report.evidenceChanges.push(...diffFields(current.evidence[key], incoming.evidence[key], pointer("/evidence", key)));
  }
  report.evidenceChanges.push(...collectionChanges(current.evidence.sources, incoming.evidence.sources, "version", "/evidence/sources").flatMap(entry => entry.changes));
  report.evidenceChanges.sort((x, y) => compareKeys(x.path, y.path));
  report.evidenceChanged = report.evidenceChanges.length > 0;
  if (report.evidenceChanged) {
    report.diagnostics.push(diagnostic("DECLARED_EVIDENCE_CHANGED", "/evidence",
      "Evidence declarations differ. Any same-key decision matches are review candidates, not proof of the same underlying event.", { severity: "warning" }));
  }
  if (current.workspace !== incoming.workspace) {
    report.diagnostics.push(diagnostic("WORKSPACE_MISMATCH", "/workspace", "Different workspaces cannot be matched by groupKey; no record classifications were produced."));
    return report;
  }
  const left = new Map(current.decisions.map(record => [record.groupKey, record]));
  const right = new Map(incoming.decisions.map(record => [record.groupKey, record]));
  report.records = [...new Set([...left.keys(), ...right.keys()])].sort(compareKeys)
    .map(key => compareRecord(key, left.get(key), right.get(key)));
  report.summary = { unchanged: 0, changed: 0, added: 0, missing: 0 };
  for (const record of report.records) {
    report.summary[record.classification]++;
    if (record.sourceEvidenceIdentityChanged) {
      report.diagnostics.push(diagnostic("SOURCE_EVIDENCE_IDENTITY_CHANGED", pointer("/decisions", record.groupKey),
        "Source occurrence identity differs; inspect both sides and their exact deltas.", { severity: "warning" }));
    }
  }
  report.sourceEvidenceIdentityChanged = report.records.some(record => record.sourceEvidenceIdentityChanged === true);
  report.complete = true;
  return report;
}

module.exports = { compareExports };
