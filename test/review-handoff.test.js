"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createBrief, renderBrief, BriefError } = require("../lib/review-handoff.js");
const { parseJson } = require("../lib/strict-json.js");
const selectionBytes = fs.readFileSync(path.join(__dirname, "../examples/inputs/review-selection-dispatch-evidence.json"));
const comparisonBytes = fs.readFileSync(path.join(__dirname, "../examples/inputs/comparison.json"));
const sourceSelection = JSON.parse(selectionBytes);
const sourceReport = JSON.parse(comparisonBytes);
const encode = value => Buffer.from(JSON.stringify(value));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const selection = () => structuredClone(sourceSelection);
const report = () => structuredClone(sourceReport);
function bind(bytes, selected = selection()) {
  selected.comparison.bytes = bytes.length;
  selected.comparison.sha256 = digest(bytes);
  return encode(selected);
}
function rejects(fn, code, pattern) {
  assert.throws(fn, error => {
    assert.ok(error instanceof BriefError);
    if (code) assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}
function reportFailure(mutate, code, pattern) {
  const changed = report(); mutate(changed);
  const bytes = encode(changed);
  rejects(() => createBrief(bind(bytes), bytes), code, pattern);
}
function blocks(markdown) {
  const result = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^~{3,}json$/.test(lines[i])) continue;
    const fence = lines[i].slice(0, -4);
    const content = [];
    while (++i < lines.length && lines[i] !== fence) content.push(lines[i]);
    assert.ok(i < lines.length, "fence closes");
    result.push(JSON.parse(content.join("\n")));
  }
  return result;
}

test("real files: identity and complete selected report facts are retained", () => {
  assert.equal(comparisonBytes.length, 35795);
  assert.equal(digest(comparisonBytes), "bae2cfbcb560d40d145ce87ee48e7ad3ac17e551505250fddcf66b32df860783");
  assert.equal(selectionBytes.length, 1693);
  assert.equal(digest(selectionBytes), "9aebb1500a30c5feadb9ce7fa165a135031b20664ffc1be192175ce1df71721b");
  const brief = createBrief(selectionBytes, comparisonBytes);
  assert.equal(brief.purpose, sourceSelection.purpose);
  assert.deepEqual(brief.reviewContext, sourceSelection.reviewContext);
  assert.equal(brief.selectedCount, 2);
  assert.equal(brief.outsideRequestedScopeCount, 8);
  assert.deepEqual(brief.records.map(r => r.reportRecord), [sourceReport.records[3], sourceReport.records[4]]);
  const missing = brief.records[1];
  assert.equal(missing.incomingPresent, false);
  assert.equal(missing.reportRecord.incoming, null);
  assert.equal(missing.reportRecord.current.note, "");
  assert.equal(missing.reportRecord.current.revision, 0);
  assert.equal(missing.reportRecord.current.updatedAt, null);
  assert.equal(missing.reportRecord.current.sourceEvidence[0].salesIncluded, false);
  assert.equal(brief.records[0].reportRecord.current.revision, brief.records[0].reportRecord.incoming.revision);
  assert.notEqual(brief.records[0].reportRecord.current.updatedAt, brief.records[0].reportRecord.incoming.updatedAt);
  assert.deepEqual(JSON.parse(renderBrief(selectionBytes, comparisonBytes, "json")), brief);
  assert.doesNotMatch(JSON.stringify(brief), /MAR-DUP/);
  assert.match(brief.notices.join(" "), /not authenticity/);
});

test("Markdown contains losslessly recoverable purpose and selected records only", () => {
  const md = renderBrief(selectionBytes, comparisonBytes);
  const data = blocks(md);
  assert.equal(data[0].purpose, sourceSelection.purpose);
  assert.deepEqual(data[0].reviewContext, sourceSelection.reviewContext);
  assert.deepEqual(data.slice(2, -1).map(r => r.reportRecord), [sourceReport.records[3], sourceReport.records[4]]);
  assert.match(md, /Incoming: ABSENT/);
  assert.match(md, /Not a deletion or approval/);
  assert.doesNotMatch(md, /MAR-DUP/);
});

test("raw bytes: newline, same-length edit, reformatting and BOM all fail identity", () => {
  for (const changed of [Buffer.concat([comparisonBytes, Buffer.from("\n")]),
    Buffer.from(comparisonBytes.toString().replace("Waiting", "waiting")),
    encode(sourceReport), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), comparisonBytes])]) {
    rejects(() => createBrief(selectionBytes, changed), "COMPARISON_IDENTITY", /expected.*measured/);
  }
  const s = selection(); s.comparison.sha256 = "0".repeat(64);
  rejects(() => createBrief(encode(s), comparisonBytes), "COMPARISON_IDENTITY");
  s.comparison.sha256 = sourceSelection.comparison.sha256; s.comparison.bytes++;
  rejects(() => createBrief(encode(s), comparisonBytes), "COMPARISON_IDENTITY");
});

for (const [key, value, code] of [
  ["groupKey", "id:MAR-DUP", "SELECTION_MISMATCH"], ["classification", "unchanged", "SELECTION_MISMATCH"],
  ["currentPresent", false, "SELECTION_MISMATCH"], ["incomingPresent", false, "SELECTION_MISMATCH"],
  ["currentPresent", 1, "SELECTION_MISMATCH"], ["incomingPresent", "true", "SELECTION_MISMATCH"],
  ["recordIndex", 4, "SELECTION_POINTER"], ["recordIndex", "3", "INVALID_CONTRACT"],
  ["recordIndex", -1, "INVALID_CONTRACT"], ["recordIndex", 3.5, "INVALID_CONTRACT"],
  ["jsonPointer", "/records/4", "SELECTION_POINTER"], ["jsonPointer", "/records/03", "SELECTION_POINTER"],
  ["jsonPointer", "/records/3/", "SELECTION_POINTER"], ["jsonPointer", "/records/%33", "SELECTION_POINTER"],
  ["jsonPointer", "/records/~03", "SELECTION_POINTER"], ["jsonPointer", "/__proto__", "SELECTION_POINTER"],
  ["jsonPointer", "#/records/3", "SELECTION_POINTER"], ["jsonPointer", "/records/-", "SELECTION_POINTER"]
]) test("reject selected " + key + " = " + JSON.stringify(value), () => {
  const s = selection(); s.selectedRecords[0][key] = value;
  rejects(() => createBrief(encode(s), comparisonBytes), code, new RegExp(key));
});

test("reject stale references instead of key search; reject duplicate selection", () => {
  const s = selection(); s.selectedRecords[0].recordIndex = 999; s.selectedRecords[0].jsonPointer = "/records/999";
  rejects(() => createBrief(encode(s), comparisonBytes), "SELECTION_POINTER", /outside/);
  s.selectedRecords[0].recordIndex = 7; s.selectedRecords[0].jsonPointer = "/records/7";
  rejects(() => createBrief(encode(s), comparisonBytes), "SELECTION_MISMATCH", /groupKey/);
  const duplicate = selection(); duplicate.selectedRecords[1] = structuredClone(duplicate.selectedRecords[0]);
  rejects(() => createBrief(encode(duplicate), comparisonBytes), "DUPLICATE_SELECTION");
});

test("every selected field is required, with no coercion or repair", () => {
  for (const key of Object.keys(sourceSelection.selectedRecords[0])) {
    const s = selection(); delete s.selectedRecords[0][key];
    rejects(() => createBrief(encode(s), comparisonBytes), undefined, new RegExp(key));
  }
  const s = selection(); s.selectedRecords[1].incomingPresent = true;
  rejects(() => createBrief(encode(s), comparisonBytes), "SELECTION_MISMATCH", /incomingPresent/);
});

test("selection envelope, counts and metadata are checked", () => {
  for (const [key, value] of [["format", "wrong"], ["version", 2], ["selectedCount", 0], ["selectedCount", "2"], ["selectedRecords", {}], ["authentication", "proven"]]) {
    const s = selection(); s[key] = value;
    rejects(() => createBrief(encode(s), comparisonBytes), undefined, new RegExp(key));
  }
  for (const key of ["currentWorkspace", "incomingWorkspace", "reportVersion"]) {
    const s = selection(); s.comparison[key] = key === "reportVersion" ? 2 : "other";
    rejects(() => createBrief(encode(s), comparisonBytes));
  }
});

test("report completeness, counts, identities and required field shapes are checked", () => {
  for (const mutate of [r => { r.complete = false; }, r => { r.readOnly = false; }, r => { r.operation = "apply"; },
    r => { r.reportVersion = 2; }, r => { r.current.valid = false; }, r => { r.incoming.valid = false; },
    r => { r.current.metadata.workspace = "other"; }, r => { r.records = {}; },
    r => { r.summary.changed++; }, r => { r.incoming.decisionCount++; },
    r => { r.records[3].groupKey = r.records[0].groupKey; },
    r => { r.records[3].current.groupKey = "other"; }, r => { r.records[3].classification = "unsupported"; },
    r => { r.records[3].changes[0].path = false; }, r => { delete r.records[3].changes[0].incoming; },
    r => { r.records[3].noteChanged = "false"; }, r => { delete r.records[4].incoming; },
    r => { r.records[4].current = null; }, r => { delete r.records[4].current.updatedAt; }
  ]) reportFailure(mutate);
  for (const value of [false, "", 0, [], {}]) reportFailure(r => { r.records[4].incoming = value; });
});

test("valid empty selection keeps purpose and identity, and still validates report", () => {
  const s = selection(); s.selectedRecords = []; s.selectedCount = 0;
  const bytes = encode(s);
  const brief = createBrief(bytes, comparisonBytes);
  assert.equal(brief.reviewContext.purposeLabel, "Dispatch evidence follow-up");
  assert.deepEqual(brief.comparison, sourceSelection.comparison);
  assert.deepEqual(brief.records, []);
  assert.equal(brief.outsideRequestedScopeCount, 10);
  assert.match(renderBrief(bytes, comparisonBytes), /No records selected for review/);
  assert.match(brief.scopeMessage, /does not mean.*no differences/);
  rejects(() => createBrief(bytes, Buffer.concat([comparisonBytes, Buffer.from(" ")])), "COMPARISON_IDENTITY");
  const r = report(); r.complete = false; const bad = encode(r);
  rejects(() => createBrief(bind(bad, s), bad), "INVALID_CONTRACT", /complete/);
});

test("selection order, optional/empty purpose label, and filename-as-label", () => {
  const s = selection(); s.selectedRecords.reverse(); s.reviewContext.purposeLabel = "";
  s.comparison.filename = "../../not-a-path-to-open.json";
  const brief = createBrief(encode(s), comparisonBytes);
  assert.deepEqual(brief.records.map(r => r.recordIndex), [4, 3]);
  assert.equal(brief.reviewContext.purposeLabel, "");
  delete s.reviewContext;
  assert.equal(Object.hasOwn(createBrief(encode(s), comparisonBytes), "reviewContext"), false);
});

test("Unicode, whitespace, Markdown/HTML and extra snapshot facts remain literal data", () => {
  const r = report();
  const literal = "  Ω e\u0301 \"quotes\" \\\n~~~\n# not a heading <script>alert(1)</script> | [link](https://example.invalid)  ";
  r.records[4].current.note = literal;
  r.records[4].current.extra = { empty: "", zero: 0, no: false, nil: null, decimal: 0.125, nested: ["b", "a"] };
  const bytes = encode(r); const s = selection(); s.reviewContext.purposeLabel = literal;
  const bound = bind(bytes, s);
  const brief = createBrief(bound, bytes);
  assert.deepEqual(brief.records[1].reportRecord, r.records[4]);
  const data = blocks(renderBrief(bound, bytes));
  assert.equal(data[0].reviewContext.purposeLabel, literal);
  assert.deepEqual(data[3].reportRecord, r.records[4]);
});

test("strict JSON rejects duplicates, malformed UTF-8/BOM and lossy numbers", () => {
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":{"x":1,"x":2}}'])
    rejects(() => parseJson(Buffer.from(text), "input"), "DUPLICATE_KEY");
  rejects(() => parseJson(Buffer.from([0xc0, 0xaf]), "input"), "INVALID_UTF8");
  rejects(() => parseJson(Buffer.from("\ufeff{}"), "input"), "INVALID_JSON");
  for (const token of ["9007199254740993", "9007199254740992", "-0", "-0.0", "1e400", "1e-400", "0.10000000000000001"]) {
    const bytes = Buffer.from('{"number":' + token + '}');
    rejects(() => parseJson(bytes, "input"), "UNSAFE_NUMBER");
  }
  for (const token of ["0", "1.0", "1e0", "0.1", "1.25e-7", "9007199254740991"]) {
    assert.deepEqual(parseJson(Buffer.from('{"n":' + token + '}'), "input"), { n: Number(token) });
  }
  rejects(() => createBrief(Buffer.from('{"purpose":"a","purpose":"b"}'), comparisonBytes), "DUPLICATE_KEY");
  const duplicateReport = Buffer.from(comparisonBytes.toString().replace('"reportVersion": 1,', '"reportVersion": 1, "reportVersion": 1,'));
  rejects(() => createBrief(bind(duplicateReport), duplicateReport), "DUPLICATE_KEY");
  const badNumber = Buffer.from(comparisonBytes.toString().replace('"revision": 1,', '"revision": 9007199254740993,'));
  rejects(() => createBrief(bind(badNumber), badNumber), "UNSAFE_NUMBER");
});

test("prototype-named fields remain own data, not inherited lookups", () => {
  const parsed = parseJson(Buffer.from('{"__proto__":{"x":1},"constructor":2}'), "input");
  assert.ok(Object.hasOwn(parsed, "__proto__"));
  assert.equal({}.x, undefined);
  const r = report(); r.records[3].changes[0].path = "/__proto__/x";
  const bytes = encode(r);
  assert.equal(createBrief(bind(bytes), bytes).records[0].reportRecord.changes[0].path, "/__proto__/x");
  assert.equal({}.x, undefined);
});

test("library rejects malformed JSON/types/depth and does not mutate inputs", () => {
  rejects(() => createBrief(sourceSelection, comparisonBytes), "INPUT_TYPE");
  rejects(() => createBrief(selectionBytes, comparisonBytes.toString()), "INPUT_TYPE");
  rejects(() => createBrief(Buffer.from("{"), comparisonBytes), "INVALID_JSON");
  const bad = Buffer.from("{");
  rejects(() => createBrief(bind(bad), bad), "INVALID_JSON");
  rejects(() => parseJson(Buffer.from("[".repeat(130) + "0" + "]".repeat(130)), "input"), "JSON_DEPTH");
  const s = Buffer.from(selectionBytes); const r = Buffer.from(comparisonBytes);
  const brief = createBrief(new Uint8Array(s), new Uint8Array(r));
  brief.records[0].reportRecord.current.note = "mutated output";
  assert.deepEqual(s, selectionBytes); assert.deepEqual(r, comparisonBytes);
  assert.notEqual(createBrief(s, r).records[0].reportRecord.current.note, "mutated output");
  rejects(() => renderBrief(s, r, "html"), "OUTPUT_FORMAT");
});


test("unchanged and added records work with explicit sides, including index zero", () => {
  const s = selection();
  s.selectedRecords = [{ groupKey: sourceReport.records[0].groupKey, recordIndex: 0, jsonPointer: "/records/0", classification: "unchanged", currentPresent: true, incomingPresent: true }];
  s.selectedCount = 1;
  assert.deepEqual(createBrief(encode(s), comparisonBytes).records[0].reportRecord, sourceReport.records[0]);
  const r = report(); const item = r.records[0];
  item.current = null; item.classification = "added";
  for (const flag of ["statusChanged", "noteChanged", "decisionChanged", "sourceEvidenceIdentityChanged"]) item[flag] = null;
  r.current.decisionCount--; r.summary.unchanged--; r.summary.added++;
  s.selectedRecords[0].classification = "added"; s.selectedRecords[0].currentPresent = false;
  const bytes = encode(r);
  const brief = createBrief(bind(bytes, s), bytes);
  assert.equal(brief.records[0].currentPresent, false);
  assert.equal(brief.records[0].reportRecord.current, null);
  assert.deepEqual(brief.records[0].reportRecord.incoming, item.incoming);
});

test("reported change path labels and values are preserved without pointer interpretation", () => {
  const r = report(); const item = r.records[3];
  item.current["a/b~c"] = "old"; item.incoming["a/b~c"] = "new";
  item.changes.push({ path: "/a~1b~0c", current: "old", incoming: "new" });
  const bytes = encode(r);
  assert.deepEqual(createBrief(bind(bytes), bytes).records[0].reportRecord, item);
  for (const label of ["/absent", "/note/~2", "/sourceEvidence/00", "/constructor", "not/a/pointer"]) {
    const variant = report(); variant.records[3].changes[0].path = label;
    const bytes = encode(variant);
    assert.deepEqual(createBrief(bind(bytes), bytes).records[0].reportRecord, variant.records[3]);
  }
});
