"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { build } = require("./build-review.js");
const { analyzeReturns } = require("./review-analysis.js");
const source = name => fs.readFileSync(path.join(__dirname, name), "utf8");

// Like the existing app harness: actual production scripts and event handlers,
// with controlled reads and a small DOM. Not native browser/layout proof.
function app({ built = false } = {}) {
  let document;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.listeners = new Map();
      this.attributes = {}; this.hidden = false; this.disabled = false;
      this.value = ""; this.files = []; this._text = "";
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set textContent(value) { this._text = String(value); this.children = []; }
    set innerHTML(value) { throw new Error("HTML injection: " + value); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ""; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelectorAll(tag) {
      return this.children.flatMap(child => [child, ...child.querySelectorAll("*")])
        .filter(child => tag === "*" || child.tag === tag);
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    emit(type = "click") {
      if (type === "click" && this.disabled) return Promise.resolve();
      return Promise.resolve(this.listeners.get(type)?.({ target: this }));
    }
    focus() { document.activeElement = this; }
  }
  const template = source("review-analysis-template.html");
  const nodes = new Map([...template.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)]
    .map(([, tag, attrs, id]) => {
      const element = new Element(tag);
      element.hidden = /\bhidden\b/.test(attrs);
      element.disabled = /\bdisabled\b/.test(attrs);
      return [id, element];
    }));
  const $ = id => { assert.ok(nodes.has(id), "Unknown template ID: " + id); return nodes.get(id); };
  $("overlap-filter").value = "all";
  document = { getElementById: $, createElement: tag => new Element(tag) };
  const forbidden = name => () => { throw new Error("Forbidden side effect: " + name); };
  const context = { document, console };
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "Blob", "Worker", "open", "setTimeout"]) context[name] = forbidden(name);
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "navigator", "URL", "caches"]) {
    Object.defineProperty(context, name, { get: forbidden(name) });
  }
  context.window = context;
  vm.createContext(context);
  const scripts = built ? [...build("analysis").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]) :
    ["review-state.js", "review-analysis.js", "review-analysis-app.js"].map(source);
  for (const script of scripts) vm.runInContext(script, context);
  const choose = async (id, files) => { $(id).files = files; await $(id).emit("change"); };
  const working = file => choose("working-file", file ? [file] : []);
  const add = (...files) => choose("returned-input", files);
  const fire = (id, event) => $(id).emit(event);
  const control = (index, label) => $("returned-files").children[index].querySelectorAll("button")
    .find(button => button.textContent === label);
  return { $, fire, working, add, control, document };
}

function snapshot(count = 1) {
  const records = Array.from({ length: count }, (_, index) => ({ id: "id-" + index, title: "Record " + index }));
  return { format: "record-review", version: 1, records,
    reviews: Object.fromEntries(records.map(({ id }) => [id, { decision: "unreviewed", notes: "" }])) };
}
function file(name, value = snapshot()) {
  let reads = 0;
  return { name, text: async () => { reads++; return typeof value === "string" ? value : JSON.stringify(value); },
    get reads() { return reads; } };
}
function deferred(name) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { file: { name, text: () => promise }, resolve, reject };
}
async function ready(ui, current = snapshot(), returns = [current, current]) {
  await ui.working(file("working.json", current));
  await ui.add(...returns.map((value, index) => file("return-" + index + ".json", value)));
}
const proposals = ui => ui.$("overlap-results").querySelectorAll("section");
const notes = ui => proposals(ui).map(section => section.querySelectorAll("pre")[0].textContent);
const visibleState = ui => ["analysis-error", "analysis-status", "working-summary", "source-results", "overlap-results", "page-status"]
  .map(id => ui.$(id).textContent);
function invalidated(ui) {
  assert.equal(ui.$("results").hidden, true);
  for (const id of ["working-summary", "source-results", "overlap-results", "analysis-error"]) assert.equal(ui.$(id).textContent, "");
  for (const id of ["overlap-filter", "previous-page", "next-page"]) assert.equal(ui.$(id).disabled, true);
}

test("explicit Analyze, ordered additions, duplicate names, reorder bounds and keyboard focus", async () => {
  const ui = app();
  assert.equal(ui.$("analyze").disabled, true);
  assert.equal(ui.$("results").hidden, true);
  const current = file("  <b>working</b> 雪.json  ");
  const first = file("same.json"), second = file("same.json"), third = file("last.json");
  await ui.working(current); await ui.add(first, second); await ui.add(third);
  assert.equal(ui.$("working-name").textContent, current.name);
  assert.equal(ui.$("returned-files").children.length, 3);
  assert.deepEqual([current, first, second, third].map(f => f.reads), [0, 0, 0, 0]);
  assert.equal(ui.control(0, "Move up").disabled, true);
  assert.equal(ui.control(2, "Move down").disabled, true);
  assert.equal(ui.control(1, "Remove").attributes["aria-label"], "Remove returned source 2");
  await ui.control(2, "Move up").emit();
  assert.match(ui.$("returned-files").children[1].textContent, /^Source 2: last.json/);
  assert.equal(ui.document.activeElement, ui.control(1, "Move up"));
  await ui.fire("analyze");
  assert.equal(ui.$("results").hidden, false);
  assert.deepEqual([current, first, second, third].map(f => f.reads), [1, 1, 1, 1]);
  assert.deepEqual(proposals(ui).map(section => section.querySelectorAll("h4")[0].textContent),
    ["Source 1: same.json", "Source 2: last.json", "Source 3: same.json"]);
  await ui.control(1, "Move down").emit(); invalidated(ui);
  await ui.fire("analyze");
  assert.deepEqual(proposals(ui).map(section => section.querySelectorAll("h4")[0].textContent),
    ["Source 1: same.json", "Source 2: same.json", "Source 3: last.json"]);
  await ui.control(2, "Remove").emit(); invalidated(ui);
  assert.equal(ui.document.activeElement, ui.control(1, "Remove"));
});

test("every choice replacement, addition and removal clears results, errors, filters and pages", async () => {
  const mutations = [ui => ui.working(file("new.json")), ui => ui.working(null),
    ui => ui.add(file("added.json")), ui => ui.control(0, "Remove").emit(),
    ui => ui.control(0, "Move down").emit(), ui => ui.control(1, "Move up").emit(),
    ui => ui.fire("clear-working"), ui => ui.fire("clear-returns")];
  for (const mutate of mutations) {
    const ui = app(); await ready(ui, snapshot(11)); await ui.fire("analyze");
    await ui.fire("next-page");
    await mutate(ui); invalidated(ui);
    assert.equal(ui.$("overlap-filter").value, "all");
  }
  const ui = app(); await ready(ui, snapshot(), ["{"]);
  await ui.fire("analyze"); assert.match(ui.$("analysis-error").textContent, /Invalid JSON/);
  await ui.fire("clear-returns"); invalidated(ui);
  assert.equal(ui.$("analyze").disabled, true);
  assert.equal(ui.document.activeElement, ui.$("returned-input"));
});

test("late success or read failure cannot replace newer success or validation error", async () => {
  for (const olderFails of [false, true]) for (const newerFails of [false, true]) {
    const ui = app(); await ui.working(file("working.json"));
    const old = deferred("old.json"); await ui.add(old.file);
    const pending = ui.fire("analyze");
    assert.equal(ui.$("analyze").disabled, true);
    await ui.fire("clear-returns");
    await ui.add(file("new.json", newerFails ? "[]" : snapshot()), file("new-2.json"));
    await ui.fire("analyze");
    const expected = visibleState(ui);
    if (olderFails) old.reject(new Error("old read error")); else old.resolve(JSON.stringify(snapshot()));
    await pending;
    assert.deepEqual(visibleState(ui), expected);
    assert.equal(ui.$("results").hidden, newerFails);
    assert.equal(ui.$("analyze").disabled, false);
  }
});

test("pending working reads, reorder and removal cannot resurrect results or unlock a newer read", async () => {
  for (const mutate of [ui => ui.working(file("replacement.json")), ui => ui.control(0, "Move down").emit(),
    ui => ui.control(0, "Remove").emit(), ui => ui.fire("clear-working"), ui => ui.fire("clear-returns")]) {
    const ui = app(); const old = deferred("working.json");
    await ui.working(old.file); await ui.add(file("a.json"), file("b.json"));
    const pending = ui.fire("analyze"); await mutate(ui);
    old.resolve(JSON.stringify(snapshot())); await pending; invalidated(ui);
  }
  const ui = app(); await ui.working(file("working.json"));
  const old = deferred("old.json"), fresh = deferred("new.json");
  await ui.add(old.file); const oldRun = ui.fire("analyze");
  await ui.fire("clear-returns"); await ui.add(fresh.file); const freshRun = ui.fire("analyze");
  old.reject(new Error("late failure")); await oldRun;
  assert.equal(ui.$("analyze").disabled, true);
  assert.equal(ui.$("analysis-error").textContent, "");
  fresh.resolve(JSON.stringify(snapshot())); await freshRun;
  assert.equal(ui.$("results").hidden, false);
});

test("current read errors and every canonical invalid snapshot position remain visible and retryable", async () => {
  for (const position of [0, 1, 2]) {
    for (const bad of ["{", "[]", "id,title", JSON.stringify({ ...snapshot(), version: 2 }),
      JSON.stringify({ ...snapshot(), reviews: {} }), JSON.stringify({ ...snapshot(), reviews: { "id-0": { decision: "bad", notes: "" } } })]) {
      const ui = app(); const files = [file("w.json"), file("a.json"), file("b.json")];
      files[position] = file("invalid.json", bad);
      await ui.working(files[0]); await ui.add(...files.slice(1)); await ui.fire("analyze");
      assert.ok(ui.$("analysis-error").textContent); assert.equal(ui.$("results").hidden, true);
      assert.equal(ui.$("analyze").disabled, false);
      assert.equal(ui.$("overlap-results").textContent, "");
    }
    const ui = app(); const broken = deferred("<bad file>.json");
    const files = [file("w.json"), file("a.json"), file("b.json")]; files[position] = broken.file;
    await ui.working(files[0]); await ui.add(...files.slice(1)); const pending = ui.fire("analyze");
    broken.reject(new Error("denied <literal>")); await pending;
    assert.match(ui.$("analysis-error").textContent, /Could not read.*<bad file>.*denied <literal>/);
    assert.equal(ui.$("analyze").disabled, false);
  }
});

test("real owner renders full exact literal proposals, IDs, whitespace and empty notes without side effects", async () => {
  const current = snapshot(3);
  current.records[0].id = "  <img src=x onerror=alert(1)> 雪  ";
  current.records[1].id = "__proto__";
  current.records[2].id = "0007";
  current.reviews = Object.fromEntries(current.records.map(({ id }) => [id, { decision: "unreviewed", notes: "" }]));
  const first = structuredClone(current), second = structuredClone(current);
  const exact = '  <script>not markup</script>\r\n\t雪 e\u0301\n tail  ';
  first.reviews[current.records[0].id].notes = exact;
  second.reviews[current.records[0].id].notes = exact.replace("\r\n", "\n");
  second.reviews["0007"].notes = " ";
  first.records.reverse();
  const names = ["<b>first</b>.json", "  second\n雪.json  "];
  for (const built of [false, true]) {
    const ui = app({ built }); await ui.working(file("w.json", current));
    await ui.add(file(names[0], first), file(names[1], second)); await ui.fire("analyze");
    const expected = analyzeReturns({ filename: "w.json", text: JSON.stringify(current) },
      [first, second].map((value, index) => ({ filename: names[index], text: JSON.stringify(value) })));
    assert.deepEqual(notes(ui), expected.overlaps.flatMap(row => row.proposals.map(p => p.notes)));
    assert.deepEqual(ui.$("overlap-results").querySelectorAll("h3").map(h => h.textContent),
      expected.overlaps.map(row => "Record ID: " + row.id));
    assert.deepEqual(proposals(ui).map(section => section.querySelectorAll("h4")[0].textContent),
      expected.overlaps.flatMap(row => row.proposals.map(p => "Source " + p.sourceOrdinal + ": " + p.filename)));
    assert.deepEqual(proposals(ui).map(section => JSON.parse(section.querySelectorAll("pre")[1].textContent)), notes(ui));
    assert.match(ui.$("overlap-results").textContent, /Notes: empty \(0 characters\)/);
    assert.equal(ui.$("overlap-results").querySelectorAll("img").length, 0);
    assert.equal(ui.$("overlap-results").querySelectorAll("script").length, 0);
  }
});

test("source counts and complete issues retain canonical order, conflicts never become proposals", async () => {
  const current = snapshot(4); const first = structuredClone(current);
  first.records.reverse(); first.records[0].title = "changed"; first.records[2].title = "changed";
  first.records.unshift({ id: "<unknown-z>", title: "Unknown" });
  first.records.push({ id: "unknown-a", title: "Unknown" });
  first.reviews = Object.fromEntries(first.records.map(({ id }) => [id, { decision: "approved", notes: "exact" }]));
  const ui = app(); await ready(ui, current, [first, first]); await ui.fire("analyze");
  for (const item of ui.$("source-results").children) {
    assert.match(item.textContent, /Total: 6 · Eligible: 2 · Unchanged: 0 · Changed-record conflicts: 2 · Unknown IDs: 2/);
    assert.deepEqual(item.querySelectorAll("li").map(row => row.textContent),
      ["Changed-record conflict: id-1", "Changed-record conflict: id-3", "Unknown ID: <unknown-z>", "Unknown ID: unknown-a"]);
  }
  assert.deepEqual(ui.$("overlap-results").querySelectorAll("h3").map(h => h.textContent), ["Record ID: id-0", "Record ID: id-2"]);
  const bad = structuredClone(first); bad.reviews["<unknown-z>"].notes = null;
  await ui.add(file("bad-excluded.json", bad)); await ui.fire("analyze");
  assert.match(ui.$("analysis-error").textContent, /Invalid decision or notes/);
  assert.equal(ui.$("results").hidden, true);
});

test("All, Disagreements and Identical keep owner order with bounded pages, reset and empty counts", async () => {
  const current = snapshot(23), second = structuredClone(current);
  second.records.reverse();
  for (let index = 1; index < 23; index += 2) second.reviews["id-" + index].notes = "diff";
  const ui = app(); await ready(ui, current, [current, second]); await ui.fire("analyze");
  const ids = () => ui.$("overlap-results").querySelectorAll("h3").map(h => h.textContent);
  assert.equal(ids().length, 10); assert.equal(ui.$("previous-page").disabled, true);
  await ui.fire("previous-page"); assert.equal(ids()[0], "Record ID: id-0");
  await ui.fire("next-page"); assert.equal(ids()[0], "Record ID: id-10");
  await ui.fire("next-page"); assert.deepEqual(ids(), [20, 21, 22].map(i => "Record ID: id-" + i));
  assert.match(ui.$("page-status").textContent, /Showing 21–23 of 23 matching overlaps · 23 total · Page 3 of 3/);
  assert.equal(ui.$("next-page").disabled, true); await ui.fire("next-page"); assert.equal(ids().length, 3);
  await ui.fire("previous-page"); assert.equal(ids()[0], "Record ID: id-10");
  ui.$("overlap-filter").value = "disagreement"; await ui.fire("overlap-filter", "change");
  assert.deepEqual(ids(), Array.from({ length: 10 }, (_, i) => "Record ID: id-" + (i * 2 + 1)));
  assert.match(ui.$("page-status").textContent, /of 11 matching overlaps · 23 total · Page 1 of 2/);
  await ui.fire("next-page"); assert.deepEqual(ids(), ["Record ID: id-21"]);
  ui.$("overlap-filter").value = "identical"; await ui.fire("overlap-filter", "change");
  assert.deepEqual(ids(), Array.from({ length: 10 }, (_, i) => "Record ID: id-" + (i * 2)));
  await ui.fire("next-page"); assert.deepEqual(ids(), ["Record ID: id-20", "Record ID: id-22"]);
  ui.$("overlap-filter").value = "all"; await ui.fire("overlap-filter", "change");
  assert.equal(ids()[0], "Record ID: id-0");
  await ui.fire("clear-returns"); await ui.add(file("one.json", current)); await ui.fire("analyze");
  assert.match(ui.$("page-status").textContent, /Showing 0 of 0 matching overlaps · 0 total · Page 0 of 0/);
  assert.equal(ui.$("next-page").disabled, true); assert.equal(ui.$("previous-page").disabled, true);
  assert.match(ui.$("overlap-empty").textContent, /No overlapping proposals/);
  await ui.add(file("two.json", current)); await ui.fire("analyze");
  ui.$("overlap-filter").value = "disagreement"; await ui.fire("overlap-filter", "change");
  assert.match(ui.$("overlap-empty").textContent, /No overlaps match this filter/);
  assert.match(ui.$("page-status").textContent, /0 matching overlaps · 23 total · Page 0 of 0/);
});

test("empty valid snapshots succeed; a fresh page never restores earlier analysis", async () => {
  const ui = app(); await ready(ui, snapshot(0)); await ui.fire("analyze");
  assert.equal(ui.$("results").hidden, false);
  assert.match(ui.$("source-results").textContent, /Total: 0/);
  const fresh = app(); assert.equal(fresh.$("results").hidden, true);
  assert.equal(fresh.$("working-name").textContent, "None chosen");
  assert.equal(fresh.$("returned-files").children.length, 0);
});

test("standard build stays self-contained, preserves desk output and accessible static contracts", () => {
  assert.equal(build(), source("index.html"));
  assert.equal(build("analysis"), source("review-analysis.html"));
  const html = build("analysis");
  assert.equal([...html.matchAll(/<script>/g)].length, 3);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)[^>]+(?:src|href)=|<form\b|\bon(?:click|change)=/i);
  assert.match(html, /connect-src 'none'; form-action 'none'; base-uri 'none'/);
  for (const id of ["working-file", "returned-input", "overlap-filter"]) assert.ok(html.includes('for="' + id + '"'));
  assert.match(html, /id="analysis-error"[^>]+role="alert"/);
  assert.match(html, /white-space: break-spaces/);
  assert.match(html, /@media \(max-width: 720px\)/);
  assert.doesNotMatch(source("review-analysis-app.js"), /innerHTML|localStorage|sessionStorage|indexedDB|clipboard|fetch\(|XMLHttpRequest|createObjectURL|\.download|applyReviewUpdates|exportJSON|\.persist\(/);
});


test("reorder boundaries focus a neutral source label, never the opposite action", async () => {
  for (const built of [false, true]) for (const [index, action, destination] of [[1, "Move up", 0], [0, "Move down", 1]]) {
    const ui = app({ built });
    await ready(ui); await ui.fire("analyze");
    await ui.control(index, action).emit(); invalidated(ui);
    const label = ui.$("returned-files").children[destination].children[0];
    assert.equal(ui.document.activeElement, label);
    assert.equal(label.tag, "span");
    assert.equal(label.tabIndex, -1);
    assert.equal(label.textContent, "Source " + (destination + 1) + ": return-" + index + ".json");
    assert.equal(ui.control(destination, action).disabled, true);
    const order = ui.$("returned-files").textContent;
    // A neutral label has no button activation behavior. Actual native keyboard
    // dispatch/layout stays in the user's approved-browser proof, not this DOM.
    for (const event of ["keydown", "keyup", "click"]) await label.emit(event);
    assert.equal(ui.$("returned-files").textContent, order);
    invalidated(ui);
    await ui.fire("analyze");
    assert.deepEqual(proposals(ui).map(section => section.querySelectorAll("h4")[0].textContent),
      ["Source 1: return-1.json", "Source 2: return-0.json"]);
  }
});
