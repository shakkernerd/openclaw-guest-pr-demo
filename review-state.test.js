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

test("CSV preserves source strings, quoted syntax, exact headers and special object keys", () => {
  const csv = '\uFEFFid,title,amount,notes,decision,__proto__,constructor, extra ,"a,b","say ""hi""",empty\r\n' +
    '001,"  雪, ""hello""\r\nnext\nline\rlast  ",1e3,"source notes",rejected,safe,false, null ,value,quote,\r' +
    '__proto__,Title,0007,,not a decision,own,key,  ,comma,"""",\n';
  const state = R.importCSV(csv);
  const headers = ["id", "title", "amount", "notes", "decision", "__proto__", "constructor", " extra ", "a,b", 'say "hi"', "empty"];
  const expected = [
    ["001", '  雪, "hello"\r\nnext\nline\rlast  ', "1e3", "source notes", "rejected", "safe", "false", " null ", "value", "quote", ""],
    ["__proto__", "Title", "0007", "", "not a decision", "own", "key", "  ", "comma", '"', ""],
  ].map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
  assert.deepEqual(state.records, expected);
  assert.ok(state.records.every(record => Object.values(record).every(value => typeof value === "string")));
  assert.equal(Object.getPrototypeOf(state.records[0]), Object.prototype);
  assert.deepEqual(state.reviews["001"], { decision: "unreviewed", notes: "" });
  assert.deepEqual(state.reviews.__proto__, { decision: "unreviewed", notes: "" });
  assert.equal({}.safe, undefined);
  assert.deepEqual(R.importJSON(R.exportJSON(state)), state);
});

test("CSV and JSON arrays share exact-ID reconciliation and separate source fields from reviews", () => {
  const previous = freeze(reviewed());
  const csv = "id,title,notes,decision\nb,Now first,source note,approved\na,Renamed,not a review,rejected\nA,Case differs,,approved\n a ,Spaced ID, ,follow-up";
  const next = R.importCSV(csv, previous);
  assert.deepEqual(next, R.importJSON(JSON.stringify(next.records), previous));
  assert.deepEqual(next.reviews.a, previous.reviews.a);
  assert.notEqual(next.reviews.a, previous.reviews.a);
  assert.equal(next.reviews.b.decision, "unreviewed");
  assert.equal(next.records[1].notes, "not a review");
  assert.equal(next.reviews.A.decision, "unreviewed");
  assert.equal(next.reviews[" a "].notes, "");
  const replaced = R.importCSV("title,id\nOnly B,b", previous);
  assert.deepEqual(Object.keys(replaced.reviews), ["b"]);
  assert.equal(previous.records.length, 2);
  // Saved reviews still restore their own metadata rather than reconciling it.
  assert.deepEqual(R.importJSON(R.exportJSON(previous), next), previous);
  assert.throws(() => R.parseSnapshotJSON(csv));
});

test("CSV permits LF, CRLF and CR row endings, an optional final ending, and header-only clearing", () => {
  const previous = freeze(reviewed());
  for (const ending of ["\n", "\r\n", "\r"]) {
    for (const final of ["", ending]) {
      assert.deepEqual(R.importCSV("id,title" + final, previous), R.emptyState());
      assert.deepEqual(R.importCSV('"title","id"' + ending + '" X ","\uFEFF007 "' + final).records,
        [{ title: " X ", id: "\uFEFF007 " }]);
    }
  }
  assert.deepEqual(R.importCSV("\uFEFFid,title\n", previous), R.emptyState());
});

test("CSV syntax, header, row and record failures reject atomically, including late failures", () => {
  const previous = freeze(reviewed());
  const before = R.exportJSON(previous);
  const invalid = [
    ["", /header row/], ["\uFEFF", /header row/], [" ", /blank/], ["\n", /blank/],
    ["id,title,id", /unique/], ['id,title,"id"', /unique/], ["id,title,", /blank/],
    ['id,title,""', /blank/], ["id,title, ", /blank/],
    ["ID,title", /exact column/], ["id, title", /exact column/], ["other,title", /exact column/],
    ['id,title\na,"Unclosed', /unclosed/], ['id,title\na,Un"quoted', /quote must start/],
    ['id,title\na,"Closed"x', /closing quote/], ['id,title\na,"Closed" ', /closing quote/],
    ['id,title\na, "Leading space"', /quote must start/],
    ["id,title\na,Valid\nb", /row 3 has 1 cells/], ["id,title\na,Valid\nb,Title,extra", /row 3 has 3 cells/],
    ["id,title\na,Valid\n\n", /row 3 has 1 cells/], ["id,title\n\n", /row 2 has 1 cells/],
    ["id,title\na,Valid\n,Title", /non-empty string id/],
    ["id,title\na,Valid\nb, ", /non-empty string title/],
    ['id,title\na,Valid\nb,""', /non-empty string title/],
    ["id,title\na,Valid\na,Duplicate", /repeats id/],
  ];
  for (const [input, error] of invalid) {
    assert.throws(() => R.importCSV(input, previous), error, JSON.stringify(input));
    assert.equal(R.exportJSON(previous), before);
  }
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

test("search includes current review notes and still intersects the decision filter", () => {
  let state = R.updateReview(initial(), "a", { decision: "approved", notes: "Inventory matches the signed count." });
  state = freeze(R.updateReview(state, "b", { notes: "Check the SIGNED COUNT tomorrow." }));
  const before = R.exportJSON(state);
  const ids = (value, decision) => R.visibleRecords(value, "  signed COUNT  ", decision).map(record => record.id);
  assert.deepEqual(ids(state, "all"), ["a", "b"]);
  assert.deepEqual(ids(state, "approved"), ["a"]);
  assert.deepEqual(ids(state, "unreviewed"), ["b"]);
  assert.deepEqual(ids(state, "rejected"), []);
  assert.equal(R.exportJSON(state), before);

  const edited = R.updateReview(state, "a", { notes: "Inventory differs." });
  const cleared = R.updateReview(edited, "b", { notes: "" });
  assert.deepEqual(ids(edited, "all"), ["b"]);
  assert.deepEqual(ids(cleared, "all"), []);
  assert.deepEqual(ids(state, "approved"), ["a"]); // earlier state is untouched
  assert.deepEqual(ids(R.importJSON(before), "approved"), ["a"]);
  assert.deepEqual(R.visibleRecords(cleared, " ", "approved").map(record => record.id), ["a"]);
});

test("exports round-trip full data and replace rather than merge review snapshots", () => {
  const snapshot = reviewed();
  const competing = R.updateReview(snapshot, "b", { decision: "rejected", notes: "Not in backup" });
  assert.deepEqual(R.importJSON(R.exportJSON(snapshot), competing), snapshot);
  const special = R.importJSON('[{"id":"x","title":"<img src=x onerror=alert(1)>","extra":[null,true,"雪"]}]');
  const withNotes = R.updateReview(special, "x", { notes: "quotes: \" and newline\n</textarea>" });
  assert.deepEqual(R.importJSON(R.exportJSON(withNotes)), withNotes);
});

test("selected export preserves exact IDs, all decisions, full values and working-array order", () => {
  const ids = ["a", "A", " a ", "__proto__", "constructor", "toString", "unselected"];
  let state = R.importJSON(JSON.stringify(ids.map(id => Object.fromEntries([
    ["id", id], ["title", "雪 </script> " + id], ["__proto__", { safe: true }],
    ["values", [null, false, 0, "003", { lines: "CR\rLF\nCRLF\r\n", empty: "" }]],
    ["notes", "source note, not a review"], ["decision", "source decision"],
  ]))));
  ids.forEach((id, index) => { state = R.updateReview(state, id, {
    decision: R.DECISIONS[index % R.DECISIONS.length], notes: '  "quoted" 雪 </textarea>\r\n' + id,
  }); });
  freeze(state);
  const before = R.exportJSON(state);
  const selection = freeze(["toString", "constructor", "__proto__", " a ", "A", "a"]);
  const json = R.exportSelectedJSON(state, selection);
  const expected = { format: R.FORMAT, version: 1, records: state.records.slice(0, -1),
    reviews: Object.fromEntries(ids.slice(0, -1).map(id => [id, state.reviews[id]])) };
  assert.deepEqual(R.importJSON(json, reviewed()), expected);
  assert.deepEqual(R.parseSnapshotJSON(json), expected);
  assert.equal(json, R.exportJSON(expected));
  assert.equal(R.exportJSON(state), before);
  assert.deepEqual(selection, ["toString", "constructor", "__proto__", " a ", "A", "a"]);
  assert.equal(Object.hasOwn(JSON.parse(json).reviews, "unselected"), false);
});

test("selected export rejects empty, implicit, duplicate and stale selections without a full fallback", () => {
  const state = freeze(reviewed());
  const before = R.exportJSON(state);
  for (const ids of [undefined, null, [], "a", new Set(["a"]), ["a", "a"], ["a", "missing"], ["a", 1], ["A"]]) {
    assert.throws(() => R.exportSelectedJSON(state, ids));
    assert.equal(R.exportJSON(state), before);
  }
  assert.throws(() => R.exportSelectedJSON(R.emptyState(), []), /Select at least one/);
  const invalid = { ...state, reviews: { ...state.reviews, a: { decision: "bad", notes: "" } } };
  assert.throws(() => R.exportSelectedJSON(invalid, ["a"]), /Invalid decision/);
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

test("comparison validates saved snapshots only without changing the import contract", () => {
  const previous = freeze(reviewed());
  const before = R.exportJSON(previous);
  assert.deepEqual(R.parseSnapshotJSON("\uFEFF" + before), previous);
  for (const text of [...invalidImports, "[]", JSON.stringify(records)]) assert.throws(() => R.parseSnapshotJSON(text));
  for (const mutate of [
    value => { value.version = 2; },
    value => { value.format = "other"; },
    value => { value.records.push(value.records[0]); },
    value => { value.reviews.a.decision = "maybe"; },
    value => { value.reviews.a.notes = null; },
    value => { delete value.reviews.b; },
    value => { value.reviews.extra = value.reviews.a; },
    value => { value.reviews = []; },
  ]) {
    const invalid = JSON.parse(before);
    mutate(invalid);
    assert.throws(() => R.parseSnapshotJSON(JSON.stringify(invalid)));
  }
  assert.equal(R.exportJSON(previous), before);
  assert.deepEqual(R.importJSON(JSON.stringify(records)).records, records);
});

test("comparison separates membership, fields, decisions and notes in current then added order", () => {
  const dataset = [
    { id: "gone", title: "Removed", empty: "" },
    { id: "both", title: "Old", nested: { a: 1, b: [true, null] } },
    { id: "record", title: "Record only", extra: false },
    { id: "decision", title: "Decision only" },
    { id: "notes", title: "Notes only" },
    { id: "same", title: "Unchanged" },
  ];
  const current = freeze(R.importJSON(JSON.stringify(dataset)));
  let compared = R.importJSON(JSON.stringify([
    { id: "new-2", title: "First added" }, dataset[5], dataset[4], dataset[3],
    { id: "record", title: "Record only", extra: "false" },
    { id: "both", title: "New", nested: { b: [null, true], a: 1 } },
    { id: "new-1", title: "Second added" },
  ]));
  compared = R.updateReview(compared, "both", { decision: "rejected", notes: "雪 ✓ <script>not HTML</script>\n\"" });
  compared = R.updateReview(compared, "decision", { decision: "approved" });
  compared = freeze(R.updateReview(compared, "notes", { notes: " " }));
  const before = R.exportJSON(current);
  const incoming = R.exportJSON(compared);
  const diff = R.compareSnapshots(current, compared);
  assert.deepEqual(diff.counts, { current: 6, compared: 7, added: 2, removed: 1, shared: 5,
    changed: 4, unchanged: 1, recordChanged: 2, reviewChanged: 3, decisionChanged: 2, notesChanged: 2 });
  assert.deepEqual(diff.entries.map(entry => [entry.id, entry.kind]), [
    ["gone", "removed"], ["both", "changed"], ["record", "changed"],
    ["decision", "changed"], ["notes", "changed"], ["new-2", "added"], ["new-1", "added"],
  ]);
  const [removed, both, record, decision, notes, added] = diff.entries;
  assert.equal(removed.after, null);
  assert.deepEqual(removed.before, { record: dataset[0], review: current.reviews.gone });
  assert.deepEqual(both.fields, ["title", "nested"]);
  assert.equal(both.before.review.notes, "");
  assert.equal(both.after.review.notes, compared.reviews.both.notes);
  assert.equal(both.decisionChanged && both.notesChanged, true);
  assert.deepEqual(record.fields, ["extra"]);
  assert.equal(record.decisionChanged || record.notesChanged, false);
  assert.deepEqual(decision.fields, []);
  assert.equal(decision.decisionChanged, true);
  assert.equal(decision.notesChanged, false);
  assert.equal(notes.decisionChanged, false);
  assert.equal(notes.notesChanged, true);
  assert.equal(added.before, null);
  assert.deepEqual(added.after.record, compared.records[0]);
  assert.equal(R.exportJSON(current), before);
  assert.equal(R.exportJSON(compared), incoming);
});

test("comparison ignores object key and record ordering but respects nested arrays and types", () => {
  const make = payload => R.importJSON(JSON.stringify([{ id: "x", title: "X", payload }]));
  const current = freeze(make({ a: 1, b: [{ x: 2, y: 3 }, "雪"], c: {} }));
  const reordered = freeze(make({ c: {}, b: [{ y: 3, x: 2 }, "雪"], a: 1 }));
  assert.equal(R.compareSnapshots(current, reordered).counts.unchanged, 1);
  assert.deepEqual(R.compareSnapshots(current, reordered).entries, []);
  for (const [left, right] of [[[], {}], [[1, 2], [2, 1]], [[1], ["1"]],
    [1, "1"], [false, 0], [null, ""], [{}, { empty: "" }], [{}, { empty: null }],
    [{ nested: [null] }, { nested: [] }]]) {
    const diff = R.compareSnapshots(make(left), make(right));
    assert.equal(diff.counts.recordChanged, 1, JSON.stringify([left, right]));
    assert.deepEqual(diff.entries[0].fields, ["payload"]);
  }
  assert.deepEqual(R.compareSnapshots(initial(), R.importJSON(JSON.stringify([...records].reverse()))).entries, []);
});

test("comparison distinguishes missing, empty and special keys without coercing IDs", () => {
  const ids = ["__proto__", "constructor", "toString", "hasOwnProperty", "A", " a", "a "];
  const current = freeze(R.importJSON(JSON.stringify(ids.map(id => ({ id, title: id, removed: null })))));
  const compared = freeze(R.importJSON(JSON.stringify([...ids.slice(0, 4).map(id =>
    Object.fromEntries([["id", id], ["title", id], ["__proto__", {}], ["empty", ""]])), { id: "a", title: "Added" }])));
  const diff = R.compareSnapshots(current, compared);
  assert.equal(diff.counts.changed, 4);
  assert.equal(diff.counts.removed, 3);
  assert.equal(diff.counts.added, 1);
  assert.deepEqual(diff.entries.map(entry => entry.id), [...ids, "a"]);
  assert.deepEqual(diff.entries[0].fields, ["removed", "__proto__", "empty"]);
  assert.equal(Object.hasOwn(diff.entries[0].after.record, "removed"), false);
  assert.equal(diff.entries[0].after.record.empty, "");
  assert.equal({}.empty, undefined);
});

test("comparison handles empty snapshots and complete additions or removals", () => {
  const empty = freeze(R.emptyState());
  assert.deepEqual(R.compareSnapshots(empty, empty), { counts: { current: 0, compared: 0,
    added: 0, removed: 0, shared: 0, changed: 0, unchanged: 0, recordChanged: 0,
    reviewChanged: 0, decisionChanged: 0, notesChanged: 0 }, entries: [] });
  assert.equal(R.compareSnapshots(empty, reviewed()).counts.added, 2);
  assert.equal(R.compareSnapshots(reviewed(), empty).counts.removed, 2);
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


test("bulk decisions change only explicit exact IDs and clone the review map once", () => {
  const ids = ["a", "A", " a ", "__proto__", "constructor", "untouched"];
  let state = R.importJSON(JSON.stringify(ids.map(id => ({ id, title: id, notes: "source", decision: "source", nested: [null, { x: 2 }] }))));
  for (const id of ids) state = R.updateReview(state, id, { notes: "keep " + id });
  state = R.updateReview(state, "a", { decision: "approved" });
  freeze(state);
  for (const decision of R.DECISIONS) {
    const selected = freeze(["a", "__proto__", "constructor"]);
    const result = R.bulkDecision(state, selected, decision);
    assert.equal(result.state.records, state.records);
    assert.equal(result.state.reviews.untouched, state.reviews.untouched);
    assert.equal(result.state.reviews.A, state.reviews.A);
    assert.equal(result.state.reviews[" a "], state.reviews[" a "]);
    assert.deepEqual(result.changes.map(change => change.id), selected.filter(id => state.reviews[id].decision !== decision));
    for (const id of ids) {
      assert.equal(result.state.reviews[id].notes, state.reviews[id].notes);
      assert.equal(result.state.reviews[id].decision, selected.includes(id) ? decision : state.reviews[id].decision);
    }
    assert.deepEqual(R.importJSON(R.exportJSON(result.state)), result.state);
  }
  // Count own-key enumerations: one map spread, not one per selected record.
  let enumerations = 0;
  const proxied = { ...state, reviews: new Proxy(state.reviews, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } }) };
  R.bulkDecision(proxied, ids, "rejected");
  assert.equal(enumerations, 1);
});

test("bulk validation is atomic, empty/no-op work keeps state identity", () => {
  const state = freeze(reviewed());
  const before = R.exportJSON(state);
  for (const [ids, decision] of [[null, "approved"], ["a", "approved"], [["a", "missing"], "rejected"],
    [["a", 1], "rejected"], [["a", "a"], "rejected"], [["a"], "bad"], [[], "bad"]]) {
    assert.throws(() => R.bulkDecision(state, ids, decision));
    assert.equal(R.exportJSON(state), before);
  }
  for (const ids of [[], ["a"]]) {
    const result = R.bulkDecision(state, ids, "approved");
    assert.equal(result.state, state);
    assert.deepEqual(result.changes, []);
  }
});

test("bulk undo restores only changed decisions, keeping later notes and unrelated data", () => {
  const state = freeze(reviewed());
  const applied = R.bulkDecision(state, ["a", "b"], "approved");
  assert.deepEqual(applied.changes, [{ id: "b", before: "unreviewed", after: "approved" }]);
  let later = R.updateReview(applied.state, "b", { notes: "Later note ✓" });
  later = R.updateReview(later, "a", { notes: "Other later note" });
  freeze(later); freeze(applied.changes);
  const undone = R.undoBulkDecision(later, applied.changes);
  assert.equal(undone.state.records, state.records);
  assert.equal(undone.state.reviews.a, later.reviews.a);
  assert.deepEqual(undone.state.reviews.b, { decision: "unreviewed", notes: "Later note ✓" });
  assert.equal(R.undoBulkDecision(later, []).state, later);
  assert.throws(() => R.undoBulkDecision(undone.state, applied.changes));
  for (const invalid of [null, [null], [{ id: "b", before: "bad", after: "approved" }],
    [{ id: "b", before: "approved", after: "approved" }], [...applied.changes, ...applied.changes],
    [...applied.changes, { id: "missing", before: "unreviewed", after: "approved" }]]) {
    assert.throws(() => R.undoBulkDecision(later, invalid));
  }
  const newerIntent = R.updateReview(later, "b", { decision: "rejected" });
  assert.throws(() => R.undoBulkDecision(newerIntent, applied.changes));
  assert.deepEqual(later.reviews.b, { decision: "approved", notes: "Later note ✓" });
});


test("returned review classifies exact records, unchanged reviews, unknown IDs and conflicts without mutation", () => {
  const current = freeze(R.importJSON(JSON.stringify([
    { id: "a", title: "Alpha", nested: { list: [1, "1", null, false], keys: { x: 1, y: 2 } } },
    { id: "b", title: "Beta" }, { id: "c", title: "Conflict", amount: "003" },
    { id: "outside", title: "Not returned" },
  ])));
  const incoming = freeze(R.importJSON(JSON.stringify({ format: R.FORMAT, version: 1, records: [
    { title: "Beta", id: "b" },
    { id: "new", title: "Unknown" },
    { title: "Alpha", nested: { keys: { y: 2, x: 1 }, list: [1, "1", null, false] }, id: "a" },
    { id: "c", title: "Conflict", amount: 3 },
  ], reviews: { b: current.reviews.b, new: { decision: "approved", notes: "new" },
    a: { decision: "follow-up", notes: "<img onerror=evil()>\r\n雪" }, c: { decision: "rejected", notes: "must not apply" } } })));
  const before = R.exportJSON(current);
  const preview = R.previewReviewUpdates(current, incoming);
  assert.deepEqual(preview.counts, { total: 4, eligible: 1, unchanged: 1, unknown: 1, conflict: 1 });
  assert.deepEqual(preview.entries.map(({ id, kind }) => [id, kind]),
    [["b", "unchanged"], ["new", "unknown"], ["a", "eligible"], ["c", "conflict"]]);
  assert.equal(preview.entries[1].before, null);
  assert.equal(preview.entries[2].before.record, current.records[0]);
  const applied = R.applyReviewUpdates(current, incoming, current);
  assert.equal(applied.changed, 1);
  assert.equal(applied.stale, false);
  assert.equal(applied.state.records, current.records);
  assert.notEqual(applied.state.reviews, current.reviews);
  assert.deepEqual(applied.state.reviews.a, incoming.reviews.a);
  assert.notEqual(applied.state.reviews.a, incoming.reviews.a);
  for (const id of ["b", "c", "outside"]) assert.equal(applied.state.reviews[id], current.reviews[id]);
  assert.equal(Object.hasOwn(applied.state.reviews, "new"), false);
  assert.equal(R.exportJSON(current), before);
  assert.deepEqual(R.importJSON(R.exportJSON(applied.state)), applied.state);
});

test("returned eligibility compares every field, nested type, membership and array order without coercion", () => {
  const pairs = [
    [3, "3"], [false, 0], [null, ""], [{ x: null }, {}], [{ x: "" }, {}],
    [[1, 2], [2, 1]], [[1], { 0: 1 }], [{ x: [true, { y: 2 }] }, { x: [true, { y: "2" }] }],
    [0, -0], ["x", " x"], [{ a: 1 }, { a: 1, b: false }],
  ];
  for (const [left, right] of pairs) {
    const current = { ...R.emptyState(), records: [{ id: "a", title: "Alpha", payload: left }],
      reviews: { a: { decision: "approved", notes: "keep" } } };
    const incoming = { ...current, records: [{ ...current.records[0], payload: right }],
      reviews: { a: { decision: "rejected", notes: "do not apply" } } };
    assert.equal(R.previewReviewUpdates(current, incoming).entries[0].kind, "conflict");
    assert.equal(R.applyReviewUpdates(current, incoming, current).state, current);
  }
  const current = reviewed();
  const renamed = { ...current, records: [{ ...current.records[0], title: "renamed" }, current.records[1]] };
  assert.equal(R.previewReviewUpdates(current, renamed).entries[0].kind, "conflict");
  for (const id of ["A", " a "]) {
    const incoming = R.importJSON(JSON.stringify([{ ...current.records[0], id }]));
    assert.equal(R.previewReviewUpdates(current, incoming).entries[0].kind, "unknown");
  }
});

test("returned batches preserve special IDs/fields, record identity/order, empty notes and Unreviewed intent", () => {
  const current = freeze(R.importJSON('[{"id":"__proto__","title":"P","__proto__":{"safe":true}},{"id":"constructor","title":"C"},{"id":"toString","title":"T"}]'));
  const incoming = R.importJSON(R.exportJSON(current));
  incoming.records.reverse();
  incoming.reviews.__proto__ = { decision: "rejected", notes: "literal" };
  incoming.reviews.constructor = { decision: "approved", notes: "" };
  incoming.reviews.toString = { decision: "unreviewed", notes: "note only" };
  const result = R.applyReviewUpdates(current, freeze(incoming), current);
  assert.equal(result.changed, 3);
  assert.equal(result.state.records, current.records);
  assert.equal(Object.getPrototypeOf(result.state.reviews), Object.prototype);
  assert.deepEqual(result.state.reviews, incoming.reviews);
  assert.equal({}.safe, undefined);
  const reset = R.applyReviewUpdates(result.state, current, result.state);
  assert.equal(reset.changed, 3);
  assert.deepEqual(reset.state.reviews, current.reviews);
});

test("returned apply validates the complete snapshot again before any write, even excluded entries", () => {
  const current = freeze(reviewed());
  const valid = R.updateReview(R.importJSON(R.exportJSON(current)), "a", { notes: "returned" });
  R.previewReviewUpdates(current, valid);
  const invalids = [
    { ...valid, version: 2 }, { ...valid, format: "other" },
    { ...valid, records: [...valid.records, valid.records[0]] },
    { ...valid, reviews: { a: valid.reviews.a } },
    { ...valid, reviews: { ...valid.reviews, extra: { decision: "approved", notes: "" } } },
    { ...valid, reviews: { ...valid.reviews, b: { decision: "approved", notes: false } } },
    { ...valid, records: [valid.records[0], { id: "unknown", title: "U" }],
      reviews: { a: valid.reviews.a, unknown: { decision: "invalid", notes: "" } } },
    { ...valid, records: [valid.records[0], { id: "b", title: "Changed" }],
      reviews: { a: valid.reviews.a, b: { decision: "approved", notes: null } } },
  ];
  const before = R.exportJSON(current);
  for (const incoming of invalids) {
    assert.throws(() => R.previewReviewUpdates(current, incoming));
    assert.throws(() => R.applyReviewUpdates(current, incoming, current));
    assert.throws(() => R.applyReviewUpdates(current, incoming, R.emptyState()));
    assert.equal(R.exportJSON(current), before);
  }
  valid.reviews.b.notes = 1; // Changed after the earlier valid preview.
  assert.throws(() => R.applyReviewUpdates(current, valid, current));
  assert.throws(() => R.parseSnapshotJSON("[]", "Returned review"), /Returned review needs/);
});

test("returned stale apply rederives current eligibility and requires an explicit current base", () => {
  const base = freeze(reviewed());
  const incoming = freeze(R.updateReview(base, "a", { notes: "returned" }));
  for (const current of [R.updateReview(base, "b", { notes: "unrelated edit" }),
    R.updateReview(base, "a", { decision: "rejected" }),
    R.importJSON('[{"id":"a","title":"Changed"}]', base), R.emptyState()]) {
    const result = R.applyReviewUpdates(current, incoming, base);
    assert.equal(result.state, current);
    assert.equal(result.stale, true);
    assert.equal(result.changed, 0);
    assert.deepEqual(result.preview, R.previewReviewUpdates(current, incoming));
    const accepted = R.applyReviewUpdates(current, incoming, current);
    assert.equal(accepted.stale, false);
    assert.equal(accepted.changed, result.preview.counts.eligible);
    assert.equal(accepted.state.records, current.records);
    if (Object.hasOwn(current.reviews, "b") && current.reviews.b.notes === "unrelated edit") {
      // An incoming b with matching data is now visibly eligible in the refresh.
      assert.equal(result.preview.counts.eligible, 2);
    }
  }
  const reverted = R.updateReview(R.updateReview(base, "a", { notes: "temporary" }), "a", { notes: base.reviews.a.notes });
  assert.equal(R.applyReviewUpdates(reverted, incoming, base).stale, true);
});

test("empty, unchanged and excluded-only returned snapshots are true no-ops", () => {
  const current = freeze(reviewed());
  for (const incoming of [R.emptyState(), current, R.importJSON('[{"id":"other","title":"Other"}]'),
    R.importJSON('[{"id":"a","title":"Conflict"}]')]) {
    const result = R.applyReviewUpdates(current, incoming, current);
    assert.equal(result.state, current);
    assert.equal(result.changed, 0);
    assert.equal(result.preview.counts.eligible, 0);
  }
});
