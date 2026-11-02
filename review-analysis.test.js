"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeReturns, parseReportJSON } = require("./review-analysis.js");
const { DECISIONS } = require("./review-state.js");

// Synthetic, in-memory snapshots only. Never invoke the CLI or open originals.
function snapshot(ids) {
  return { format: "record-review", version: 1,
    records: ids.map(id => ({ id, title: "Synthetic " + id })),
    reviews: Object.fromEntries(ids.map(id => [id, { decision: "unreviewed", notes: "" }])) };
}
function report() {
  const working = snapshot(["__proto__", "constructor", " conflict ", "only"]);
  const first = structuredClone(working), second = structuredClone(working);
  first.records[2].title = "Changed";
  first.records.push({ id: "<unknown>雪", title: "Unknown" });
  first.reviews["<unknown>雪"] = { decision: "rejected", notes: "" };
  first.reviews.__proto__.notes = "  <script>literal</script>\r\n\r雪 e\u0301\t  ";
  second.reviews.__proto__.notes = "  <script>literal</script>\n\r雪 e\u0301\t  ";
  second.reviews.constructor.decision = "approved";
  second.records = second.records.filter(r => r.id !== "only").reverse();
  delete second.reviews.only;
  const input = (filename, value) => ({ filename, text: JSON.stringify(value) });
  return analyzeReturns(input("  <working>\r雪.json  ", working),
    [input("same\r\n<return>.json", first), input("same\r\n<return>.json", second)]);
}
const parse = value => parseReportJSON(JSON.stringify(value));

test("saved boundary preserves complete producer output, exact strings, ordinals and array order", () => {
  const expected = report();
  const text = JSON.stringify(expected, null, 2) + "\n";
  assert.deepEqual(parseReportJSON(text), expected);
  assert.equal(JSON.stringify(parseReportJSON(text), null, 2) + "\n", text);
  assert.deepEqual(parseReportJSON("﻿" + text), expected);
  assert.deepEqual(expected.overlaps.map(row => row.id), ["__proto__", "constructor"]);
  assert.equal(parse(expected).overlaps[1].proposals[0].notes, "");
  assert.equal(parse(expected).overlaps[0].proposals[0].notes, "  <script>literal</script>\r\n\r雪 e\u0301\t  ");
  assert.equal(parse(expected).sources[0].filename, "same\r\n<return>.json");
});

test("producer compatibility across empty, single, repeated and mixed synthetic sources", () => {
  for (let size = 0; size < 9; size++) for (let sourceCount = 1; sourceCount <= 4; sourceCount++) {
    const ids = ["__proto__", "constructor", "toString", " 雪\r\n<id> ", "0007", "five", "six", "seven"].slice(0, size);
    const working = snapshot(ids);
    const returned = Array.from({ length: sourceCount }, (_, n) => {
      const value = structuredClone(working);
      value.records = value.records.filter((_, i) => (i + n) % 5 !== 4).reverse();
      if (n % 2) value.records.push({ id: "unknown-" + n, title: "Unknown" });
      value.reviews = Object.fromEntries(value.records.map((record, i) => {
        if ((i + n) % 4 === 3) record.title += " changed";
        return [record.id, { decision: DECISIONS[(i + n) % 4],
          notes: ["", "\r", "\r\n", "<b>雪</b>\n  ", "e\u0301"][i % 5] }];
      }));
      return { filename: n % 2 ? "" : "same.json", text: JSON.stringify(value) };
    });
    const output = analyzeReturns({ filename: "", text: JSON.stringify(working) }, returned);
    assert.deepEqual(parse(output), output);
  }
});

test("saved format has no invented version; stored status is a claim, not reclassification", () => {
  const value = report();
  // Boundary validates the vocabulary; it does not repeat proposal comparison.
  assert.equal(value.overlaps[0].status, "disagreement");
  value.overlaps[0].status = "identical";
  assert.equal(parse(value).overlaps[0].status, "identical");
  value.overlaps[0].proposals[1].notes = value.overlaps[0].proposals[0].notes;
  assert.deepEqual(value.overlaps[0].proposals.map(p => p.decision), ["unreviewed", "unreviewed"]);
  value.overlaps[0].status = "disagreement";
  assert.equal(parse(value).overlaps[0].status, "disagreement");
  value.version = 1;
  assert.throws(() => parse(value), /Saved report root/);
});

test("reject malformed JSON, snapshots, wrong roots and missing or extra fields at every level", () => {
  for (const text of ["", " ", "{", "id,title\na,A", "null", "[]", "1", '"text"', JSON.stringify(snapshot([]))]) {
    assert.throws(() => parseReportJSON(text), /Saved report/);
  }
  for (const locate of [r => r, r => r.working, r => r.sources[0], r => r.sources[0].counts,
    r => r.sources[0].issues[0], r => r.overlaps[0], r => r.overlaps[0].proposals[0]]) {
    for (const key of Object.keys(locate(report()))) {
      const value = report(); delete locate(value)[key];
      assert.throws(() => parse(value), /Saved report/);
    }
    for (const key of ["extra", "version", "__proto__", "constructor"]) {
      const value = report(); Object.defineProperty(locate(value), key, { value: "unexpected", enumerable: true });
      assert.throws(() => parse(value), /Saved report/);
    }
  }
});

test("reject invalid types, count summaries, issue lists and proposal references atomically", () => {
  const mutations = [
    r => { r.kind = "record-review"; },
    r => { r.working = []; }, r => { r.working.filename = null; },
    r => { r.sources = []; }, r => { r.sources = {}; }, r => { r.overlaps = {}; },
    r => { r.sources[0] = null; }, r => { r.sources[0].filename = 9; },
    r => { r.sources[0].ordinal = 0; }, r => { r.sources[1].ordinal = 1; },
    r => { r.sources[0].counts = []; }, r => { r.sources[0].counts.total++; },
    r => { r.working.recordCount = 0; }, r => { r.sources[0].issues = null; },
    r => { r.sources[0].issues[0].kind = "eligible"; },
    r => { r.sources[0].issues[0].id = " \t\n"; },
    r => { r.sources[0].issues[0].id = 3; },
    r => { r.sources[0].issues.reverse(); },
    r => { r.sources[0].issues[1].id = r.sources[0].issues[0].id; },
    r => { r.sources[0].issues.pop(); },
    r => { r.overlaps[0].id = ""; }, r => { r.overlaps[0].status = "winner"; },
    r => { r.overlaps[1].id = r.overlaps[0].id; },
    r => { r.overlaps[0].proposals = {}; }, r => { r.overlaps[0].proposals.pop(); },
    r => { r.overlaps[0].proposals[0].sourceOrdinal = 0; },
    r => { r.overlaps[0].proposals[0].sourceOrdinal = "1"; },
    r => { r.overlaps[0].proposals[1].sourceOrdinal = 99; },
    r => { r.overlaps[0].proposals[1].sourceOrdinal = 1; },
    r => { r.overlaps[0].proposals.reverse(); },
    r => { r.overlaps[0].proposals[0].filename = "not its source"; },
    r => { r.overlaps[0].proposals[0].decision = "constructor"; },
    r => { r.overlaps[0].proposals[0].notes = null; },
    r => { r.overlaps[0].id = r.sources[0].issues[0].id; },
    r => { r.overlaps.push({ ...structuredClone(r.overlaps[0]), id: "one-more" },
      { ...structuredClone(r.overlaps[0]), id: "yet-another" }); },
  ];
  for (const bad of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    mutations.push(r => { r.working.recordCount = bad; });
    for (const key of ["total", "eligible", "unchanged", "unknown", "conflict"]) {
      mutations.push(r => { r.sources[0].counts[key] = bad; });
    }
  }
  for (const mutate of mutations) {
    const value = report(); mutate(value);
    assert.throws(() => parse(value), /Saved report/, mutate.toString());
  }
});


test("report-wide ID claims share one working snapshot, without reclassifying proposals", () => {
  const value = {
    kind: "record-review-return-analysis", working: { filename: "w", recordCount: 1 },
    sources: [1, 2].map(ordinal => ({ ordinal, filename: "same",
      counts: { total: 1, eligible: 1, unchanged: 0, unknown: 0, conflict: 0 }, issues: [] })),
    overlaps: [{ id: "__proto__", status: "identical", proposals: [1, 2].map(sourceOrdinal =>
      ({ sourceOrdinal, filename: "same", decision: "approved", notes: "" })) }],
  };
  const issueSource = (ordinal, id, kind) => ({ ordinal, filename: "same",
    counts: { total: 1, eligible: 0, unchanged: 0, unknown: kind === "unknown" ? 1 : 0,
      conflict: kind === "conflict" ? 1 : 0 }, issues: [{ id, kind }] });
  for (const [id, kind, expected] of [["__proto__", "unknown", /cannot also be recorded as unknown/],
    ["constructor", "conflict", /exceed the recorded working count/]]) {
    const invalid = structuredClone(value); invalid.sources.push(issueSource(3, id, kind));
    assert.throws(() => parse(invalid), expected);
  }
  const conflicts = { ...structuredClone(value), overlaps: [], sources:
    [issueSource(1, "__proto__", "conflict"), issueSource(2, "constructor", "conflict")] };
  assert.throws(() => parse(conflicts), /exceed the recorded working count/);
  conflicts.sources[1] = issueSource(2, "__proto__", "unknown");
  assert.throws(() => parse(conflicts), /cannot also be recorded as unknown/);
  // The same working ID may conflict in one source and propose in other sources.
  // Distinct unknown IDs do not consume the working-record count.
  value.sources.push(issueSource(3, "__proto__", "conflict"), issueSource(4, "constructor", "unknown"));
  assert.deepEqual(parse(value), value);
});
