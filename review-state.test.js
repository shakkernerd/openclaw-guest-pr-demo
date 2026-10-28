"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const R = require("./review-state.js");
const { build } = require("./build-review.js");

const records = [{ id: "a", title: "Alpha", payload: { count: 3 } }, { id: "b", title: "Beta" }];
const initial = () => R.importJSON(JSON.stringify(records));
const reviewed = () => R.updateReview(initial(), "a", { decision: "approved", notes: "Checked ✓\nKeep this." });
function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return value;
}

test("raw import retains arbitrary JSON fields and creates independent blank reviews", () => {
  const state = initial();
  assert.deepEqual(state.records, records);
  assert.deepEqual(state.reviews.a, { decision: "unreviewed", notes: "" });
  assert.notEqual(state.reviews.a, state.reviews.b);
  assert.deepEqual(R.importJSON("\uFEFF" + JSON.stringify(records)), state);
});

const invalidImports = [
  "", " ", "{bad json", "null", "true", "42", '"text"', "{}", '{"records":[]}',
  "[null]", "[[]]", '[{"id":1,"title":"Numeric ID"}]',
  '[{"id":" ","title":"Empty ID"}]', '[{"title":"Missing ID"}]',
  '[{"id":"a"}]', '[{"id":"a","title":" "}]', '[{"id":"a","title":3}]',
  '[{"id":"a","title":"Valid first"},{"id":"a","title":"Late duplicate"}]',
  '[{"id":"a","title":"Valid first"},{"id":"b","title":null}]',
];
for (const input of invalidImports) test("invalid import is atomic: " + input.slice(0, 70), () => {
  const previous = freeze(reviewed());
  const before = R.exportJSON(previous);
  assert.throws(() => R.importJSON(input, previous));
  assert.equal(R.exportJSON(previous), before);
});

test("reimport/reorder preserves exact matching IDs, not position or title", () => {
  const previous = freeze(reviewed());
  const next = R.importJSON(JSON.stringify([
    { id: "b", title: "Now first" }, { id: "a", title: "Renamed" }, { id: "c", title: "New" },
  ]), previous);
  assert.deepEqual(next.reviews.a, previous.reviews.a);
  assert.notEqual(next.reviews.a, previous.reviews.a);
  assert.equal(next.reviews.b.decision, "unreviewed");
  assert.equal(next.reviews.c.notes, "");
  assert.equal(next.records[1].title, "Renamed");
  const replaced = R.importJSON('[{"id":"A","title":"Case differs"}]', previous);
  assert.deepEqual(Object.keys(replaced.reviews), ["A"]);
  assert.equal(replaced.reviews.A.decision, "unreviewed");
  assert.deepEqual(R.importJSON("[]", previous), R.emptyState());
});

test("prototype-like IDs are ordinary keys, never inherited reviews", () => {
  const state = R.importJSON(JSON.stringify(["__proto__", "constructor", "toString", "hasOwnProperty"].map(id => ({ id, title: id }))));
  assert.equal(Object.keys(state.reviews).length, 4);
  assert.equal(Object.getPrototypeOf(state.reviews), Object.prototype);
  const next = R.updateReview(state, "__proto__", { decision: "follow-up", notes: "Safe" });
  assert.deepEqual(R.importJSON(R.exportJSON(next)), next);
  assert.equal({}.decision, undefined);
});

test("all decisions and notes update immutably, including return to unreviewed", () => {
  const previous = freeze(reviewed());
  for (const decision of R.DECISIONS) {
    const next = R.updateReview(previous, "a", { decision, notes: "" });
    assert.equal(next.reviews.a.decision, decision);
    assert.equal(next.reviews.a.notes, "");
    assert.equal(previous.reviews.a.decision, "approved");
  }
  for (const patch of [{ decision: "unknown" }, { notes: null }]) assert.throws(() => R.updateReview(previous, "a", patch));
  assert.throws(() => R.updateReview(previous, "missing", { notes: "lost" }));
});

test("search and decision filters compose without mutating reviews", () => {
  const state = freeze(reviewed());
  assert.deepEqual(R.visibleRecords(state, " ALPHA ", "approved").map(r => r.id), ["a"]);
  assert.deepEqual(R.visibleRecords(state, "B", "unreviewed").map(r => r.id), ["b"]);
  assert.equal(R.visibleRecords(state, "alpha", "rejected").length, 0);
  assert.equal(R.visibleRecords(state, "no match").length, 0);
  assert.deepEqual(R.counts(state), { unreviewed: 1, approved: 1, rejected: 0, "follow-up": 0, total: 2, reviewed: 1 });
  assert.equal(R.counts(R.emptyState()).reviewed, 0);
});

test("exports round-trip full data and replace rather than merge review snapshots", () => {
  const snapshot = reviewed();
  const competing = R.updateReview(snapshot, "b", { decision: "rejected", notes: "Not in backup" });
  assert.deepEqual(R.importJSON(R.exportJSON(snapshot), competing), snapshot);
  const special = R.importJSON('[{"id":"x","title":"<img src=x onerror=alert(1)>","extra":[null,true,"雪"]}]');
  const withNotes = R.updateReview(special, "x", { notes: "quotes: \" and newline\n</textarea>" });
  assert.deepEqual(R.importJSON(R.exportJSON(withNotes)), withNotes);
});

test("invalid snapshots never partially replace accepted state", () => {
  const previous = freeze(reviewed());
  const before = R.exportJSON(previous);
  const mutations = [
    value => { value.version = 2; },
    value => { value.format = "other"; },
    value => { value.reviews.a.decision = "maybe"; },
    value => { value.reviews.a.notes = 1; },
    value => { value.reviews.a = null; },
    value => { delete value.reviews.b; },
    value => { value.reviews.unknown = value.reviews.b; delete value.reviews.b; },
    value => { value.reviews = []; },
    value => { value.records.push(value.records[0]); },
  ];
  for (const mutate of mutations) {
    const invalid = JSON.parse(before);
    mutate(invalid);
    assert.throws(() => R.importJSON(JSON.stringify(invalid), previous));
    assert.equal(R.exportJSON(previous), before);
  }
});

test("storage restore and save use a versioned key and preserve the full snapshot", () => {
  const map = new Map();
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  assert.deepEqual(R.restore(() => storage), { status: "empty", state: null });
  assert.equal(R.persist(() => storage, reviewed()), true);
  assert.deepEqual([...map.keys()], [R.STORAGE_KEY]);
  assert.deepEqual(R.restore(() => storage), { status: "restored", state: reviewed() });
});

test("blocked getters, denied reads, quota failures, and corrupt saves are safe", () => {
  const denied = () => { throw new Error("SecurityError"); };
  assert.deepEqual(R.restore(denied), { status: "unavailable", state: null });
  assert.equal(R.persist(denied, reviewed()), false);
  assert.equal(R.restore(() => ({ getItem: denied })).status, "unavailable");
  const previous = reviewed();
  const before = R.exportJSON(previous);
  assert.equal(R.persist(() => ({ setItem: denied }), previous), false);
  assert.equal(R.exportJSON(previous), before);
  let writes = 0;
  for (const text of ["{broken", "null", "[]", '{"format":"record-review","version":99}', '{"format":"record-review","version":1,"records":[],"reviews":{"ghost":{}}}']) {
    assert.deepEqual(R.restore(() => ({ getItem: () => text, setItem: () => writes++ })), { status: "invalid", state: null });
  }
  assert.equal(writes, 0);
});

test("shipped preview is fresh, self-contained, and its actual scripts parse", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.equal(html, build());
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import|\bfetch\s*\(|XMLHttpRequest/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const [, source] of scripts) new vm.Script(source);
});
