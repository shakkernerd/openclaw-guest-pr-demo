"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateExport, parseExport } = require("../lib");
const { baseline, freeze } = require("../support/fixtures.js");

function expectError(mutate, code, path) {
  const value = baseline();
  mutate(value);
  const result = validateExport(value);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(d => d.code === code && d.path === path && d.severity === "error"), JSON.stringify(result.diagnostics));
  return result;
}

test("real baseline validates; duplicate source rows and malformed dispositions are not malformed decisions", () => {
  const value = freeze(baseline());
  assert.deepEqual(validateExport(value), { valid: true, decisionCount: 10, diagnostics: [] });
  assert.equal(value.decisions[1].sourceEvidence.length, 3);
  assert.equal(value.decisions[2].groupKey, "id:MAR,007");
});

for (const [name, mutate, code, path] of [
  ["schema version", v => { v.schemaVersion = 2; }, "UNSUPPORTED_SCHEMA_VERSION", "/schemaVersion"],
  ["coerced version", v => { v.schemaVersion = "1"; }, "UNSUPPORTED_SCHEMA_VERSION", "/schemaVersion"],
  ["missing note", v => { delete v.decisions[0].note; }, "MISSING_FIELD", "/decisions/0/note"],
  ["null note", v => { v.decisions[0].note = null; }, "INVALID_TYPE", "/decisions/0/note"],
  ["empty status", v => { v.decisions[0].status = ""; }, "INVALID_TYPE", "/decisions/0/status"],
  ["numeric status", v => { v.decisions[0].status = 7; }, "INVALID_TYPE", "/decisions/0/status"],
  ["negative revision", v => { v.decisions[0].revision = -1; }, "INVALID_INTEGER", "/decisions/0/revision"],
  ["unsafe revision", v => { v.decisions[0].revision = 9007199254740992; }, "INVALID_INTEGER", "/decisions/0/revision"],
  ["fractional bytes", v => { v.evidence.csv.bytes = 1.5; }, "INVALID_INTEGER", "/evidence/csv/bytes"],
  ["uppercase hash", v => { v.evidence.datasetSha256 = "A".repeat(64); }, "INVALID_HASH", "/evidence/datasetSha256"],
  ["impossible review date", v => { v.evidence.reviewDate = "2026-02-30"; }, "INVALID_DATE", "/evidence/reviewDate"],
  ["impossible timestamp", v => { v.decisions[0].updatedAt = "2026-02-30T10:55:10.448Z"; }, "INVALID_TIMESTAMP", "/decisions/0/updatedAt"],
  ["empty timestamp", v => { v.decisions[0].updatedAt = ""; }, "INVALID_TIMESTAMP", "/decisions/0/updatedAt"],
  ["zero line", v => { v.decisions[0].sourceEvidence[0].line = 0; }, "INVALID_INTEGER", "/decisions/0/sourceEvidence/0/line"],
  ["reversed line range", v => { v.decisions[0].sourceEvidence[0].endLine = 1; }, "INVALID_LINE_RANGE", "/decisions/0/sourceEvidence/0/endLine"],
  ["coerced boolean", v => { v.decisions[0].sourceEvidence[0].salesIncluded = "false"; }, "INVALID_TYPE", "/decisions/0/sourceEvidence/0/salesIncluded"],
  ["empty evidence", v => { v.decisions[0].sourceEvidence = []; }, "EMPTY_ARRAY", "/decisions/0/sourceEvidence"],
  ["empty categories", v => { v.decisions[0].categories = []; }, "EMPTY_ARRAY", "/decisions/0/categories"],
  ["empty sources", v => { v.evidence.sources = []; }, "EMPTY_ARRAY", "/evidence/sources"],
  ["not an array", v => { v.decisions = {}; }, "INVALID_TYPE", "/decisions"],
  ["null record", v => { v.decisions[0] = null; }, "INVALID_TYPE", "/decisions/0"],
  ["unknown source reference", v => { v.decisions[0].sourceEvidence[0].version = "elsewhere"; }, "UNKNOWN_SOURCE_REFERENCE", "/decisions/0/sourceEvidence/0/version"],
  ["conflicting source hash", v => { v.decisions[0].sourceEvidence[0].sourceSha256 = "0".repeat(64); }, "SOURCE_REFERENCE_MISMATCH", "/decisions/0/sourceEvidence/0/sourceSha256"],
  ["conflicting source path", v => { v.decisions[0].sourceEvidence[0].sourcePath += "-other"; }, "SOURCE_REFERENCE_MISMATCH", "/decisions/0/sourceEvidence/0/sourcePath"],
  ["conflicting filename", v => { v.decisions[0].sourceEvidence[0].filename += "-other"; }, "SOURCE_REFERENCE_MISMATCH", "/decisions/0/sourceEvidence/0/filename"],
]) test("validation diagnoses " + name, () => expectError(mutate, code, path));

for (const [path, locate] of [
  ["", v => v], ["/evidence", v => v.evidence], ["/evidence/csv", v => v.evidence.csv],
  ["/evidence/report", v => v.evidence.report], ["/evidence/sources/0", v => v.evidence.sources[0]],
  ["/decisions/0", v => v.decisions[0]], ["/decisions/0/sourceEvidence/0", v => v.decisions[0].sourceEvidence[0]],
]) {
  test("unknown fields are located at " + (path || "root"), () => {
    expectError(v => { locate(v)["extra/~"] = 1; }, "UNKNOWN_FIELD", path + "/extra~1~0");
  });
  test("missing fields are located at " + (path || "root"), () => {
    const value = baseline();
    const object = locate(value);
    const key = Object.keys(object)[0];
    delete object[key];
    const result = validateExport(value);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.code === "MISSING_FIELD" && d.path === path + "/" + key));
  });
}

for (const [name, mutate, code, path, first] of [
  ["decision", v => v.decisions.push(structuredClone(v.decisions[0])), "DUPLICATE_DECISION_IDENTITY", "/decisions/10/groupKey", "/decisions/0/groupKey"],
  ["source version", v => v.evidence.sources.push(structuredClone(v.evidence.sources[0])), "DUPLICATE_SOURCE_VERSION", "/evidence/sources/2/version", "/evidence/sources/0/version"],
  ["occurrence", v => v.decisions[0].sourceEvidence.push(structuredClone(v.decisions[0].sourceEvidence[0])), "DUPLICATE_OCCURRENCE", "/decisions/0/sourceEvidence/2/occurrenceKey", "/decisions/0/sourceEvidence/0/occurrenceKey"],
  ["category", v => v.decisions[0].categories.push(v.decisions[0].categories[0]), "DUPLICATE_CATEGORY", "/decisions/0/categories/2", "/decisions/0/categories/0"],
]) {
  test("duplicate " + name + " reports both locations", () => {
    const result = expectError(mutate, code, path);
    assert.deepEqual(result.diagnostics.find(d => d.code === code).relatedPaths, [first]);
  });
}

test("unknown vocabulary is warned, preserved, and not invented as a closed enum", () => {
  const value = baseline();
  value.decisions[0].status = "Unobserved status";
  value.decisions[0].categories.push("unobserved-category");
  value.decisions[0].sourceEvidence[0].disposition = "unobserved-disposition";
  const result = validateExport(value);
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.filter(d => d.code === "UNKNOWN_VALUE").length, 3);
  assert.ok(result.diagnostics.every(d => d.severity === "warning"));
  assert.equal(value.decisions[0].status, "Unobserved status");
});

test("prototype-shaped unknown fields remain data and are diagnosed", () => {
  const value = parseExport(JSON.stringify(baseline()).replace('"schemaVersion":1', '"__proto__":{},"schemaVersion":1')).value;
  assert.ok(validateExport(value).diagnostics.some(d => d.path === "/__proto__" && d.code === "UNKNOWN_FIELD"));
  assert.equal({}.polluted, undefined);
});

test("bad root types are diagnostics, not thrown exceptions", () => {
  for (const value of [null, undefined, 1, [], "{}", new Date()]) {
    assert.equal(validateExport(value).valid, false);
    assert.equal(validateExport(value).diagnostics[0].path, "");
  }
});
