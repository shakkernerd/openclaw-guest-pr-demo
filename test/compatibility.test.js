"use strict";
// Consumer-owned fixtures derived from our original report. No producer code,
// imports, copied implementation or producer installation is needed by tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createBrief, renderBrief } = require("../lib/review-handoff.js");
const root = path.join(__dirname, "..");
const originalSelection = fs.readFileSync(path.join(root, "examples/inputs/review-selection-dispatch-evidence.json"));
const originalReport = fs.readFileSync(path.join(root, "examples/inputs/comparison.json"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => Buffer.from(JSON.stringify(value));
function fixture(index) {
  const report = JSON.parse(originalReport);
  const selection = JSON.parse(originalSelection);
  const record = report.records[index];
  selection.selectedCount = 1;
  selection.selectedRecords = [{ recordIndex: index, jsonPointer: "/records/" + index,
    groupKey: record.groupKey, classification: record.classification,
    currentPresent: record.current !== null, incomingPresent: record.incoming !== null }];
  return { report, selection, record };
}
function bind(f) {
  const report = encode(f.report);
  // Explicit fixture construction only, never repair a selection inside the API.
  const selection = structuredClone(f.selection);
  selection.comparison.bytes = report.length;
  selection.comparison.sha256 = hash(report);
  return [encode(selection), report];
}
function expectError(f, code) { assert.throws(() => createBrief(...bind(f)), { code }); }
function sourceFixture(key = "revised:15") {
  const f = fixture(3);
  const current = f.record.current.sourceEvidence[1];
  const incoming = f.record.incoming.sourceEvidence[1];
  current.occurrenceKey = key; incoming.occurrenceKey = key;
  incoming.sourcePath += ".relocated";
  const label = key.replace(/~/g, "~0").replace(/\//g, "~1");
  const change = { path: "/sourceEvidence/" + label + "/sourcePath", current: current.sourcePath, incoming: incoming.sourcePath };
  f.record.changes.push(change);
  f.record.sourceEvidenceIdentityChanged = true;
  f.record.sourceEvidenceChanges = [{ occurrenceKey: key, classification: "changed", current: structuredClone(current), incoming: structuredClone(incoming), changes: [structuredClone(change)], identityChanged: true }];
  return f;
}

test("reported order-only classification and original snapshot order are preserved", () => {
  for (const fields of [["categories"], ["sourceEvidence"], ["categories", "sourceEvidence"]]) {
    const f = fixture(0);
    for (const key of fields) f.record.incoming[key].reverse();
    const bytes = bind(f); const before = bytes.map(b => Buffer.from(b));
    const brief = createBrief(...bytes);
    assert.equal(brief.records[0].classification, "unchanged");
    assert.deepEqual(brief.records[0].reportRecord, f.record);
    assert.deepEqual(brief.records[0].reportRecord.changes, []);
    assert.equal(brief.outsideRequestedScopeCount, 9);
    assert.deepEqual(bytes, before);
  }
});

test("producer classifications and flags are retained without recomputing comparison policy", () => {
  // Deliberately divergent facts demonstrate the ownership boundary, not that
  // these reports are semantically correct or authentic producer output.
  for (const mutate of [
    r => r.incoming.categories.push("different"),
    r => r.incoming.categories.push(r.incoming.categories[0]),
    r => r.incoming.sourceEvidence.pop(),
    r => r.incoming.sourceEvidence.push(structuredClone(r.incoming.sourceEvidence[0])),
    r => { r.incoming.sourceEvidence[0].salesIncluded = false; },
    r => { r.incoming.sourceEvidence[0].sourcePath += ".changed"; },
    r => { r.incoming.note = "different"; },
    r => { r.incoming.extraFacts = [2, 1]; r.current.extraFacts = [1, 2]; }
  ]) {
    const f = fixture(0); mutate(f.record);
    assert.deepEqual(createBrief(...bind(f)).records[0].reportRecord, f.record);
  }
  const f = fixture(0); // Identical snapshots, but the producer reports changed.
  f.record.classification = "changed"; f.selection.selectedRecords[0].classification = "changed";
  f.record.statusChanged = true; f.record.noteChanged = true;
  f.report.summary.unchanged--; f.report.summary.changed++;
  assert.deepEqual(createBrief(...bind(f)).records[0].reportRecord, f.record);
  f.selection.selectedRecords[0].classification = "unchanged";
  expectError(f, "SELECTION_MISMATCH"); // Selection must still match this report.
});

test("producer logical path labels, including escaped and numeric text, remain exact", () => {
  for (const key of ["revised:15", "source/~label", "0", "__proto__", "constructor"]) {
    const f = sourceFixture(key);
    f.record.incoming.sourceEvidence.reverse(); // Report data is not reordered to interpret its labels.
    const brief = createBrief(...bind(f));
    assert.deepEqual(brief.records[0].reportRecord, f.record);
    assert.equal(brief.records[0].reportRecord.changes.at(-1).path,
      "/sourceEvidence/" + key.replace(/~/g, "~0").replace(/\//g, "~1") + "/sourcePath");
  }
});

test("opaque change labels and supplied delta values are not resolved or repaired", () => {
  for (const label of ["/sourceEvidence/1/sourcePath", "/sourceEvidence/no-such-key/sourcePath", "/sourceEvidence/revised%3A15/sourcePath", "/sourceEvidence/revised~215/sourcePath", "/sourceEvidence/revised:15/__proto__/x", "not/a/pointer", ""]) {
    const f = sourceFixture(); const change = f.record.changes.at(-1);
    change.path = label;
    change.current = { producerClaim: "not independently verified", empty: "", flag: false };
    change.incoming = null;
    f.record.changes.push(structuredClone(change)); // Repeated labels stay repeated.
    assert.deepEqual(createBrief(...bind(f)).records[0].reportRecord, f.record);
    assert.equal({}.producerClaim, undefined);
  }
});

test("reported delta structure is still required, not its semantics", () => {
  for (const mutate of [
    r => { r.changes = {}; },
    r => { r.changes[0] = null; },
    r => { r.changes[0].path = 3; },
    r => { delete r.changes[0].path; },
    r => { delete r.changes[0].current; },
    r => { delete r.changes[0].incoming; },
    r => { r.sourceEvidenceChanges = {}; },
    r => { r.statusChanged = "true"; }
  ]) {
    const f = sourceFixture(); mutate(f.record); expectError(f, "INVALID_CONTRACT");
  }
});

test("presentation never substitutes snapshot notes/status for differing reported deltas", () => {
  for (const field of ["note", "status"]) {
    const f = sourceFixture();
    f.record.changes = [{ path: "/" + field, current: "producer delta before", incoming: "producer delta after" }];
    const bytes = bind(f); const md = renderBrief(...bytes);
    const top = md.split("## Reference appendix")[0];
    assert.ok(top.includes('"producer delta before"'));
    assert.ok(top.includes('"producer delta after"'));
    assert.equal(top.includes("exact current/incoming values shown above"), false);
    assert.deepEqual(createBrief(...bytes).records[0].reportRecord, f.record);
  }
});

test("whole-occurrence addition/removal keeps null absence without creating snapshots", () => {
  for (const absentSide of ["current", "incoming"]) {
    const f = fixture(3); const presentSide = absentSide === "current" ? "incoming" : "current";
    const occurrence = f.record[absentSide].sourceEvidence.pop();
    const present = f.record[presentSide].sourceEvidence.find(e => e.occurrenceKey === occurrence.occurrenceKey);
    const change = { path: "/sourceEvidence/" + occurrence.occurrenceKey, current: absentSide === "current" ? null : present, incoming: absentSide === "incoming" ? null : present };
    f.record.changes.push(change);
    f.record.sourceEvidenceChanges = [{ occurrenceKey: occurrence.occurrenceKey, classification: absentSide === "current" ? "added" : "missing", current: change.current, incoming: change.incoming, changes: [structuredClone(change)], identityChanged: true }];
    f.record.sourceEvidenceIdentityChanged = true;
    const brief = createBrief(...bind(f));
    assert.deepEqual(brief.records[0].reportRecord, f.record);
    assert.equal(brief.records[0].reportRecord.changes.at(-1)[absentSide], null);
    f.record.changes.at(-1).path += "/sourcePath"; // An opaque producer label, not a lookup.
    assert.deepEqual(createBrief(...bind(f)).records[0].reportRecord, f.record);
  }
});

test("byte identity and stale selection checks remain strict for compatible reports", () => {
  const f = sourceFixture(); const [s, r] = bind(f);
  assert.throws(() => createBrief(s, Buffer.concat([r, Buffer.from("\n")])), { code: "COMPARISON_IDENTITY" });
  const edited = Buffer.from(r); edited[1] = 32;
  assert.throws(() => createBrief(s, edited), { code: "COMPARISON_IDENTITY" });
  for (const mutate of [
    e => { e.jsonPointer = "/records/03"; },
    e => { e.jsonPointer = "/records/4"; },
    e => { e.recordIndex = 4; e.jsonPointer = "/records/4"; },
    e => { e.groupKey = "wrong"; },
    e => { e.classification = "unchanged"; },
    e => { e.incomingPresent = false; }
  ]) {
    const bad = JSON.parse(s); mutate(bad.selectedRecords[0]);
    assert.throws(() => createBrief(encode(bad), r));
  }
});

test("actual CLI accepts compatible reports and rejects stale pairs with empty stdout", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-compatibility-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const order = fixture(0); order.record.incoming.categories.reverse(); order.record.incoming.sourceEvidence.reverse();
  for (const [name, f] of [["order", order], ["source", sourceFixture()]]) {
    const [s, r] = bind(f); const sp = path.join(dir, name + '.selection.json'); const rp = path.join(dir, name + '.report.json');
    fs.writeFileSync(sp, s); fs.writeFileSync(rp, r);
    const args = [path.join(root, "bin/review-handoff.js"), "--selection", sp, "--comparison", rp];
    const run = format => spawnSync(process.execPath, [...args, "--format", format], { encoding: "utf8", timeout: 5000 });
    const good = run("json"); assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout).records[0].reportRecord, f.record);
    assert.equal(run("markdown").status, 0);
    const bad = JSON.parse(s); bad.selectedRecords[0].jsonPointer += "/"; fs.writeFileSync(sp, encode(bad));
    let result = run("json"); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /SELECTION_POINTER/);
    fs.writeFileSync(sp, s); fs.writeFileSync(rp, Buffer.concat([r, Buffer.from("\n")]));
    result = run("json"); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /COMPARISON_IDENTITY/);
  }
});

test("all existing inputs/examples and current renderings remain byte-identical", () => {
  const expected = {
    "examples/inputs/comparison.json": "bae2cfbcb560d40d145ce87ee48e7ad3ac17e551505250fddcf66b32df860783",
    "examples/inputs/review-selection-dispatch-evidence.json": "9aebb1500a30c5feadb9ce7fa165a135031b20664ffc1be192175ce1df71721b",
    "examples/generated/dispatch-brief.md": "cf56d83838e6d833c0f6506fe007e6d018d8750f8a29cfcb00861a5a53f23b31",
    "examples/generated/dispatch-brief-skim.md": "f96f45c1aa12900584fd5c63fbf11f7a3e67bf0f3a65fcf0bb6d4b828b0cfa45",
    "examples/generated/dispatch-brief.json": "aed9daa61ba62b564c0b490f46945c39a5c0c74df136434d298b2abed928dcd3"
  };
  for (const [file, sha] of Object.entries(expected)) assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, file);
  assert.deepEqual(Buffer.from(renderBrief(originalSelection, originalReport, "json")), fs.readFileSync(path.join(root, "examples/generated/dispatch-brief.json")));
  assert.deepEqual(Buffer.from(renderBrief(originalSelection, originalReport)), fs.readFileSync(path.join(root, "examples/generated/dispatch-brief-skim.md")));
});
