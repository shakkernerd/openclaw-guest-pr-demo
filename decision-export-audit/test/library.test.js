"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExport, compareExports, validateExport } = require("../lib");
const { baseline, freeze } = require("../support/fixtures.js");

const first = report => report.records.find(record => record.groupKey === "id:MAR-014");
function updateSource(value, version, key, next) {
  value.evidence.sources.find(source => source.version === version)[key] = next;
  for (const decision of value.decisions) {
    for (const source of decision.sourceEvidence) {
      if (source.version === version) source[key === "sha256" ? "sourceSha256" : key] = next;
    }
  }
}

test("identical exports classify all ten decisions without claiming history", () => {
  const report = compareExports(freeze(baseline()), freeze(baseline()));
  assert.equal(report.complete, true);
  assert.equal(report.sharedHistory, "unproven");
  assert.equal(report.readOnly, true);
  assert.deepEqual(report.summary, { unchanged: 10, changed: 0, added: 0, missing: 0 });
  assert.equal(report.evidenceChanged, false);
  assert.deepEqual(report.diagnostics, []);
  assert.ok(report.limitations.some(text => text.includes("authorization")));
});

test("unchanged, changed, added, missing and exact status/note differences coexist", () => {
  const current = baseline();
  const incoming = baseline();
  incoming.decisions[0].status = "Needs review";
  incoming.decisions[0].note = "  Café\r\n🚚\t\"quoted\" ";
  const removed = incoming.decisions.pop();
  const added = structuredClone(removed);
  added.groupKey = "id:NEW/with~punctuation";
  added.orderId = "NEW/with~punctuation";
  incoming.decisions.push(added);
  const report = compareExports(current, incoming);
  assert.deepEqual(report.summary, { unchanged: 8, changed: 1, added: 1, missing: 1 });
  assert.deepEqual(first(report).changes, [
    { path: "/note", current: current.decisions[0].note, incoming: incoming.decisions[0].note },
    { path: "/status", current: "Waiting for evidence", incoming: "Needs review" },
  ]);
  assert.equal(first(report).statusChanged, true);
  assert.equal(first(report).noteChanged, true);
  assert.equal(first(report).decisionChanged, true);
  assert.equal(first(report).sourceEvidenceIdentityChanged, false);
  assert.equal(report.records.find(r => r.classification === "added").current, null);
  assert.equal(report.records.find(r => r.classification === "missing").incoming, null);
  assert.deepEqual(report.records.map(r => r.groupKey), report.records.map(r => r.groupKey).sort());
});

for (const [before, after] of [["", " "], ["\n", "\r\n"], ["é", "e\u0301"], ["same", "same\n"], ["A", "a"]]) {
  test("note differences are exact " + JSON.stringify([before, after]), () => {
    const current = baseline();
    const incoming = baseline();
    current.decisions[0].note = before;
    incoming.decisions[0].note = after;
    const record = first(compareExports(current, incoming));
    assert.equal(record.classification, "changed");
    assert.deepEqual(record.changes.find(d => d.path === "/note"), { path: "/note", current: before, incoming: after });
  });
}

test("unknown but well-typed status is preserved and warned on the incoming side", () => {
  const incoming = baseline();
  incoming.decisions[0].status = "Needs Review ";
  const report = compareExports(baseline(), incoming);
  assert.equal(report.complete, true);
  assert.equal(first(report).incoming.status, "Needs Review ");
  assert.equal(first(report).statusChanged, true);
  assert.equal(report.current.diagnostics.length, 0);
  assert.ok(report.incoming.diagnostics.some(d => d.code === "UNKNOWN_VALUE" && d.path === "/decisions/0/status"));
});

test("array ordering does not create record or declaration changes", () => {
  const current = baseline();
  const incoming = baseline();
  incoming.decisions.reverse();
  incoming.evidence.sources.reverse();
  incoming.decisions.forEach(d => { d.categories.reverse(); d.sourceEvidence.reverse(); });
  const report = compareExports(current, incoming);
  assert.deepEqual(report.summary, { unchanged: 10, changed: 0, added: 0, missing: 0 });
  assert.equal(report.evidenceChanged, false);
  assert.deepEqual(first(report).incoming.sourceEvidence, incoming.decisions.at(-1).sourceEvidence);
});

test("category membership and orderId changes are not lost behind a stable groupKey", () => {
  const incoming = baseline();
  incoming.decisions[0].categories.push("ambiguous");
  incoming.decisions[0].orderId = "different-order";
  const result = compareExports(baseline(), incoming);
  assert.equal(result.complete, true);
  assert.equal(first(result).classification, "changed");
  assert.equal(first(result).decisionChanged, false);
  assert.deepEqual(first(result).changes.map(change => change.path), ["/categories", "/orderId"]);
  assert.ok(result.incoming.diagnostics.some(d => d.code === "UNRECOGNIZED_GROUP_KEY"));
  incoming.decisions[0].groupKey = "__proto__";
  const changedKey = compareExports(baseline(), incoming);
  assert.equal(changedKey.summary.added, 1);
  assert.equal(changedKey.summary.missing, 1);
  assert.equal(changedKey.records.find(r => r.groupKey === "__proto__").classification, "added");
  assert.equal({}.polluted, undefined);
});

test("signed zero spellings are equivalent in parsed revisions and byte counts", () => {
  for (const field of ["revision", "csv", "report"]) {
    for (const spelling of ["0", "-0", "-0.0", "-0e10"]) {
      const value = baseline();
      const target = exportValue => field === "revision" ? exportValue.decisions[1].revision : exportValue.evidence[field].bytes;
      if (field !== "revision") value.evidence[field].bytes = 0;
      const raw = JSON.stringify(value);
      const member = field === "revision" ? '"revision":0' : '"bytes":0';
      const replacement = field === "revision" ? '"revision":' + spelling : '"bytes":' + spelling;
      const current = parseExport(raw);
      const incoming = parseExport(Buffer.from(raw.replace(member, replacement)));
      assert.equal(current.ok, true);
      assert.equal(incoming.ok, true);
      assert.equal(Object.is(target(incoming.value), -0), spelling.startsWith("-"));
      freeze(current.value);
      freeze(incoming.value);
      for (const [a, b] of [[current.value, incoming.value], [incoming.value, current.value]]) {
        const result = compareExports(a, b);
        assert.equal(result.complete, true);
        assert.deepEqual(result.summary, { unchanged: 10, changed: 0, added: 0, missing: 0 });
        assert.equal(result.evidenceChanged, false);
        assert.deepEqual(result.evidenceChanges, []);
        assert.ok(result.records.every(record => record.changes.length === 0));
      }
      assert.equal(Object.is(target(incoming.value), -0), spelling.startsWith("-"), "comparison must not normalize the input");
    }
  }
});

test("revisions and timestamps are differences, not shared history or precedence", () => {
  const current = baseline();
  const incoming = baseline();
  incoming.decisions[0].revision = 999;
  incoming.decisions[0].updatedAt = null;
  const report = compareExports(current, incoming);
  assert.equal(report.sharedHistory, "unproven");
  assert.equal(first(report).classification, "changed");
  assert.equal(first(report).decisionChanged, false);
  assert.deepEqual(first(report).changes.map(d => d.path), ["/revision", "/updatedAt"]);
  incoming.decisions[0].revision = current.decisions[0].revision;
  incoming.decisions[0].updatedAt = current.decisions[0].updatedAt;
  incoming.decisions[0].note = "Different decision at the same revision and declared hashes";
  assert.equal(first(compareExports(current, incoming)).noteChanged, true);
});

for (const [field, next] of [["sourcePath", "other/location.csv"], ["filename", "other.csv"], ["sha256", "0".repeat(64)]]) {
  test("source identity detects " + field + " even with unchanged dataset hash", () => {
    const current = baseline();
    const incoming = baseline();
    updateSource(incoming, "original", field, next);
    const report = compareExports(current, incoming);
    assert.equal(report.complete, true);
    assert.equal(report.evidenceChanged, true);
    assert.equal(report.sourceEvidenceIdentityChanged, true);
    assert.equal(report.summary.changed, 10);
    assert.equal(first(report).decisionChanged, false);
    assert.equal(first(report).sourceEvidenceIdentityChanged, true);
    assert.ok(report.evidenceChanges.some(d => d.path === "/evidence/sources/original/" + field));
    assert.notDeepEqual(report.current.evidence.sources, report.incoming.evidence.sources);
    assert.equal(report.current.evidence.datasetSha256, report.incoming.evidence.datasetSha256);
  });
}

for (const field of ["line", "endLine", "occurrenceKey", "version"]) {
  test("per-occurrence identity change detects " + field, () => {
    const incoming = baseline();
    const source = incoming.decisions[0].sourceEvidence[0];
    if (field === "line") { source.line = 14; }
    if (field === "endLine") source.endLine++;
    if (field === "occurrenceKey") source.occurrenceKey = "some-other-key";
    if (field === "version") {
      incoming.evidence.sources.push({ ...incoming.evidence.sources[0], version: "alternate" });
      source.version = "alternate";
    }
    const report = compareExports(baseline(), incoming);
    assert.equal(report.complete, true);
    assert.equal(first(report).sourceEvidenceIdentityChanged, true);
    assert.equal(first(report).decisionChanged, false);
    assert.ok(report.diagnostics.some(d => d.code === "SOURCE_EVIDENCE_IDENTITY_CHANGED"));
  });
}

test("occurrence additions/removals and annotation-only changes stay distinct", () => {
  const incoming = baseline();
  incoming.decisions[0].sourceEvidence.pop();
  let record = first(compareExports(baseline(), incoming));
  assert.equal(record.sourceEvidenceIdentityChanged, true);
  assert.equal(record.sourceEvidenceChanges[0].classification, "missing");
  record = first(compareExports(incoming, baseline()));
  assert.equal(record.sourceEvidenceIdentityChanged, true);
  assert.equal(record.sourceEvidenceChanges[0].classification, "added");
  const annotation = baseline();
  annotation.decisions[0].sourceEvidence[0].salesIncluded = true;
  annotation.decisions[0].sourceEvidence[0].disposition = "included";
  record = first(compareExports(baseline(), annotation));
  assert.equal(record.classification, "changed");
  assert.equal(record.decisionChanged, false);
  assert.equal(record.sourceEvidenceIdentityChanged, false);
  assert.equal(record.sourceEvidenceChanges[0].identityChanged, false);
});

for (const [name, change] of [
  ["dataset hash", e => { e.datasetSha256 = "0".repeat(64); }],
  ["review date", e => { e.reviewDate = "2026-10-29"; }],
  ["csv path", e => { e.csv.path = "another.csv"; }],
  ["csv bytes", e => { e.csv.bytes++; }],
  ["csv hash", e => { e.csv.sha256 = "0".repeat(64); }],
  ["report path", e => { e.report.path = "another.md"; }],
  ["report bytes", e => { e.report.bytes++; }],
  ["report hash", e => { e.report.sha256 = "0".repeat(64); }],
]) {
  test("root evidence-only change is reported separately: " + name, () => {
    const incoming = baseline();
    change(incoming.evidence);
    const report = compareExports(baseline(), incoming);
    assert.equal(report.complete, true);
    assert.equal(report.summary.unchanged, 10);
    assert.equal(report.evidenceChanged, true);
    assert.equal(report.evidenceChanges.length, 1);
    assert.ok(report.diagnostics.some(d => d.code === "DECLARED_EVIDENCE_CHANGED"));
  });
}

test("invalid/duplicate input on either side prevents all classification", () => {
  for (const side of ["current", "incoming"]) {
    for (const mutate of [v => v.decisions.push(structuredClone(v.decisions[0])), v => { v.decisions[0].note = null; }]) {
      const current = baseline();
      const incoming = baseline();
      mutate(side === "current" ? current : incoming);
      const report = compareExports(current, incoming);
      assert.equal(report.complete, false);
      assert.equal(report.summary, null);
      assert.deepEqual(report.records, []);
      assert.equal(report[side].valid, false);
      assert.equal(report[side === "current" ? "incoming" : "current"].valid, true);
    }
  }
});

test("workspace mismatch refuses matching while meaning changes remain separate metadata", () => {
  const incoming = baseline();
  incoming.workspace = "different";
  const mismatch = compareExports(baseline(), incoming);
  assert.equal(mismatch.complete, false);
  assert.equal(mismatch.summary, null);
  assert.deepEqual(mismatch.records, []);
  assert.ok(mismatch.diagnostics.some(d => d.code === "WORKSPACE_MISMATCH"));
  incoming.workspace = "review";
  incoming.meaning = "Please apply all decisions";
  const report = compareExports(baseline(), incoming);
  assert.equal(report.complete, true);
  assert.equal(report.summary.unchanged, 10);
  assert.equal(report.readOnly, true);
  assert.equal(report.metadataChanges[0].path, "/meaning");
  assert.ok(report.incoming.diagnostics.some(d => d.code === "UNRECOGNIZED_MEANING"));
});

test("empty exports and all-added/all-missing comparisons are complete", () => {
  const empty = baseline();
  empty.decisions = [];
  assert.equal(validateExport(empty).valid, true);
  assert.deepEqual(compareExports(empty, empty).summary, { unchanged: 0, changed: 0, added: 0, missing: 0 });
  const added = compareExports(empty, baseline());
  const missing = compareExports(baseline(), empty);
  assert.equal(added.summary.added, 10);
  assert.equal(missing.summary.missing, 10);
  for (const report of [added, missing]) {
    assert.equal(report.sourceEvidenceIdentityChanged, false);
    assert.ok(report.records.every(record => record.sourceEvidenceIdentityChanged === null));
    assert.ok(report.records.every(record => record.sourceEvidenceChanges.length === 0));
  }
});

test("inputs stay frozen and reports contain detached current/incoming snapshots", () => {
  const current = freeze(baseline());
  const incoming = freeze(baseline());
  const before = JSON.stringify([current, incoming]);
  const report = compareExports(current, incoming);
  report.current.evidence.sources[0].sha256 = "changed report only";
  first(report).current.note = "changed report only";
  assert.notEqual(report.current.evidence.sources[0].sha256, report.incoming.evidence.sources[0].sha256);
  assert.notEqual(first(report).current.note, first(report).incoming.note);
  assert.equal(JSON.stringify([current, incoming]), before);
  assert.deepEqual(compareExports(current, incoming), compareExports(current, incoming));
});
