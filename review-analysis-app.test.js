"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { build } = require("./build-review.js");
const { analyzeReturns, parseReportJSON } = require("./review-analysis.js");
const source = name => fs.readFileSync(path.join(__dirname, name), "utf8");

// Like the existing app harness: actual production scripts and event handlers,
// with controlled reads and a small DOM. Not native browser/layout proof.
function app({ built = false, savedOnly = false, downloadError = "" } = {}) {
  let document, analysisCalls = 0;
  const downloads = [], urls = new Map(), timers = [];
  let nextURL = 0;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.listeners = new Map();
      this.attributes = {}; this.hidden = false; this.disabled = false;
      this.value = ""; this.files = []; this._text = "";
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set textContent(value) { this._text = String(value); this.children = []; }
    set innerHTML(value) { throw new Error("HTML injection: " + value); }
    append(...children) {
      for (const child of children) { child.remove(); child.parent = this; this.children.push(child); }
    }
    replaceChildren(...children) {
      this._text = "";
      for (const child of [...this.children]) child.remove();
      this.append(...children);
    }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    click() {
      assert.equal(this.tag, "a");
      assert.equal(this.parent, document.body);
      if (downloadError === "click") throw new Error("Click blocked");
      downloads.push({ filename: this.download, url: this.href, blob: urls.get(this.href) });
    }
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
  const nodes = new Map([...template.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)]
    .map(([, tag, attrs, id]) => {
      const element = new Element(tag);
      element.hidden = /\bhidden\b/.test(attrs);
      element.disabled = /\bdisabled\b/.test(attrs);
      return [id, element];
    }));
  const $ = id => { assert.ok(nodes.has(id), "Unknown template ID: " + id); return nodes.get(id); };
  $("overlap-filter").value = "all";
  $("workflow").value = "analyze";
  document = { getElementById: $, createElement: tag => new Element(tag), body: new Element("body") };
  const forbidden = name => () => { throw new Error("Forbidden side effect: " + name); };
  const context = { document, console, Blob, URL: {
    createObjectURL(blob) {
      if (downloadError === "url") throw new Error("Download blocked");
      const url = "blob:analysis-test-" + nextURL++; urls.set(url, blob); return url;
    },
    revokeObjectURL(url) { assert.ok(urls.has(url)); urls.delete(url); },
  }, setTimeout(callback, delay) { timers.push({ callback, delay }); } };
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "Worker", "open"]) context[name] = forbidden(name);
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "navigator", "caches"]) {
    Object.defineProperty(context, name, { get: forbidden(name) });
  }
  context.window = context;
  vm.createContext(context);
  const scripts = built ? [...build("analysis").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]) :
    ["review-state.js", "review-analysis.js", "review-analysis-app.js"].map(source);
  for (const script of scripts) vm.runInContext(script, context);
  const owner = context.RecordReturnAnalysis;
  context.RecordReturnAnalysis = { ...owner, analyzeReturns(...inputs) {
    analysisCalls++;
    if (savedOnly) forbidden("fresh analysis in saved workflow")();
    return owner.analyzeReturns(...inputs);
  } };
  const choose = async (id, files) => { $(id).files = files; await $(id).emit("change"); };
  const working = file => choose("working-file", file ? [file] : []);
  const saved = file => choose("saved-file", file ? [file] : []);
  const workflow = async value => { $("workflow").value = value; await $("workflow").emit("change"); };
  const add = (...files) => choose("returned-input", files);
  const fire = (id, event) => $(id).emit(event);
  const control = (index, label) => $("returned-files").children[index].querySelectorAll("button")
    .find(button => button.textContent === label);
  return { $, fire, working, saved, workflow, add, control, document, downloads, urls, timers,
    get analysisCalls() { return analysisCalls; } };
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
const visibleState = ui => ["analysis-error", "analysis-status", "results-heading", "result-context", "working-summary", "source-results", "overlap-results", "page-status", "download-status"]
  .map(id => ui.$(id).textContent);
function downloadUnavailable(ui) {
  assert.equal(ui.$("download-analysis").hidden, true);
  assert.equal(ui.$("download-analysis").disabled, true);
  const count = ui.downloads.length, urls = ui.urls.size, timers = ui.timers.length;
  // Invoke the real handler even when native hidden/disabled UI prevents clicks.
  ui.$("download-analysis").listeners.get("click")();
  assert.equal(ui.downloads.length, count);
  assert.equal(ui.urls.size, urls);
  assert.equal(ui.timers.length, timers);
}
function downloadReady(ui) {
  assert.equal(ui.$("download-analysis").hidden, false);
  assert.equal(ui.$("download-analysis").disabled, false);
}
function invalidated(ui) {
  downloadUnavailable(ui);
  assert.equal(ui.$("results").hidden, true);
  for (const id of ["result-context", "working-summary", "source-results", "overlap-results", "analysis-error"]) assert.equal(ui.$(id).textContent, "");
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
  for (const built of [false, true]) for (const mutate of mutations) {
    const ui = app({ built }); await ready(ui, snapshot(11)); await ui.fire("analyze");
    downloadReady(ui);
    await ui.fire("next-page");
    const changed = mutate(ui); invalidated(ui); // synchronous, before awaiting a read/event
    await changed; invalidated(ui);
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
  for (const built of [false, true]) for (const mutate of [ui => ui.working(file("replacement.json")),
    ui => ui.working(null), ui => ui.add(file("added.json")), ui => ui.control(0, "Move down").emit(),
    ui => ui.control(1, "Move up").emit(), ui => ui.control(0, "Remove").emit(),
    ui => ui.fire("clear-working"), ui => ui.fire("clear-returns"), ui => ui.workflow("saved")]) {
    const ui = app({ built }); const old = deferred("working.json");
    await ui.working(old.file); await ui.add(file("a.json"), file("b.json"));
    const pending = ui.fire("analyze"); await mutate(ui);
    old.resolve(JSON.stringify(snapshot())); await pending; invalidated(ui);
  }
  for (const built of [false, true]) for (const oldFails of [false, true]) {
    const ui = app({ built }); await ui.working(file("working.json"));
    const old = deferred("old.json"), fresh = deferred("new.json");
    await ui.add(old.file); const oldRun = ui.fire("analyze");
    await ui.fire("clear-returns"); await ui.add(fresh.file); const freshRun = ui.fire("analyze");
    if (oldFails) old.reject(new Error("late failure")); else old.resolve(JSON.stringify(snapshot()));
    await oldRun;
    assert.equal(ui.$("analyze").disabled, true);
    downloadUnavailable(ui);
    assert.equal(ui.$("analysis-error").textContent, "");
    fresh.resolve(JSON.stringify(snapshot())); await freshRun;
    assert.equal(ui.$("results").hidden, false); downloadReady(ui);
  }
});

test("current read errors and every canonical invalid snapshot position remain visible and retryable", async () => {
  for (const position of [0, 1, 2]) {
    for (const bad of ["{", "[]", "id,title", JSON.stringify({ ...snapshot(), version: 2 }),
      JSON.stringify({ ...snapshot(), reviews: {} }), JSON.stringify({ ...snapshot(), reviews: { "id-0": { decision: "bad", notes: "" } } })]) {
      const ui = app(); const files = [file("w.json"), file("a.json"), file("b.json")];
      files[position] = file("invalid.json", bad);
      await ui.working(files[0]); await ui.add(...files.slice(1)); await ui.fire("analyze");
      assert.ok(ui.$("analysis-error").textContent); assert.equal(ui.$("results").hidden, true);
      downloadUnavailable(ui);
      assert.equal(ui.$("analyze").disabled, false);
      assert.equal(ui.$("overlap-results").textContent, "");
    }
    const ui = app(); const broken = deferred("<bad file>.json");
    const files = [file("w.json"), file("a.json"), file("b.json")]; files[position] = broken.file;
    await ui.working(files[0]); await ui.add(...files.slice(1)); const pending = ui.fire("analyze");
    broken.reject(new Error("denied <literal>")); await pending;
    assert.match(ui.$("analysis-error").textContent, /Could not read.*<bad file>.*denied <literal>/);
    downloadUnavailable(ui);
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
  for (const id of ["workflow", "saved-file", "working-file", "returned-input", "overlap-filter"]) assert.ok(html.includes('for="' + id + '"'));
  assert.match(html, /id="analysis-error"[^>]+role="alert"/);
  assert.match(html, /id="download-analysis"[^>]+aria-describedby="download-status"[^>]+hidden disabled>Download analysis report<\/button>/);
  assert.match(html, /id="download-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /white-space: break-spaces/);
  assert.match(html, /@media \(max-width: 720px\)/);
  assert.doesNotMatch(source("review-analysis-app.js"), /innerHTML|localStorage|sessionStorage|indexedDB|clipboard|fetch\(|XMLHttpRequest|applyReviewUpdates|exportJSON|\.persist\(/);
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


function savedReport(count = 23) {
  const current = snapshot(count), second = structuredClone(current);
  if (count) {
    current.records[0].id = "__proto__"; second.records[0].id = "__proto__";
    current.reviews = Object.fromEntries(current.records.map(({ id }) => [id, { decision: "unreviewed", notes: "" }]));
    second.reviews = structuredClone(current.reviews);
  }
  for (let i = 1; i < count; i += 2) second.reviews[current.records[i].id].notes = "different";
  return analyzeReturns({ filename: "not-opened-working.json", text: JSON.stringify(current) },
    [current, second].map(value => ({ filename: "not-opened-return.json", text: JSON.stringify(value) })));
}
async function openSaved(ui, value = savedReport()) {
  await ui.workflow("saved"); await ui.saved(file("saved-report.json", value)); await ui.fire("view-saved");
  downloadUnavailable(ui);
}

test("saved and generated-page paths render every literal field without reading originals or analyzing", async () => {
  const value = savedReport(3);
  value.working.filename = " <working>\r\n雪 ";
  value.overlaps[1].id = "constructor";
  value.overlaps[2].id = " <img src=x>\r\n雪 ";
  for (const source of value.sources) {
    source.filename = " <b>same\r\n雪.json</b> ";
    source.counts.conflict = 1; source.counts.unknown = 1; source.counts.total += 2;
    source.issues = [{ id: "<conflict>\r\n雪", kind: "conflict" }, { id: "unknown constructor", kind: "unknown" }];
  }
  value.working.recordCount++;
  const exact = ["", "\r", "\r\n", "  <script>literal</script>\r\n雪 e\u0301\t  ", " ", "end\n"];
  value.overlaps.forEach((row, i) => row.proposals.forEach((p, j) => {
    p.filename = value.sources[j].filename; p.notes = exact[i * 2 + j];
    p.decision = ["unreviewed", "approved", "rejected", "follow-up"][(i * 2 + j) % 4];
  }));
  for (const built of [false, true]) {
    const ui = app({ built, savedOnly: true });
    const original = { name: value.working.filename, text() { throw new Error("Original must not be read"); } };
    await ui.working(original); await ui.add(original);
    await ui.workflow("saved");
    const saved = file(" <saved>\r\n雪.json ", value); await ui.saved(saved);
    assert.equal(saved.reads, 0); assert.equal(ui.$("view-saved").disabled, false);
    assert.equal(ui.$("analyze").disabled, true);
    await ui.fire("view-saved"); assert.equal(saved.reads, 1);
    downloadUnavailable(ui);
    assert.equal(ui.$("results").hidden, false);
    assert.match(ui.$("results-heading").textContent, /SAVED/);
    assert.ok(ui.$("result-context").textContent.includes(saved.name));
    assert.match(ui.$("result-context").textContent, /recorded claims.*not a fresh comparison/);
    assert.match(ui.$("result-context").textContent, /no named working or returned file was opened/);
    assert.equal(ui.$("working-summary").textContent, "Working: " + value.working.filename +
      " · 4 records · 2 returned source(s).");
    assert.deepEqual(ui.$("source-results").querySelectorAll("h3").map(n => n.textContent),
      value.sources.map(s => "Source " + s.ordinal + ": " + s.filename));
    for (const [i, item] of ui.$("source-results").children.entries()) {
      const c = value.sources[i].counts;
      assert.equal(item.querySelectorAll("p")[0].textContent, "SAVED recorded counts · Total: " + c.total +
        " · Eligible: " + c.eligible + " · Unchanged: " + c.unchanged + " · Changed-record conflicts: " + c.conflict + " · Unknown IDs: " + c.unknown);
      assert.deepEqual(item.querySelectorAll("li").map(n => n.textContent),
        ["Changed-record conflict: <conflict>\r\n雪", "Unknown ID: unknown constructor"]);
    }
    assert.deepEqual(ui.$("overlap-results").querySelectorAll("h3").map(n => n.textContent), value.overlaps.map(r => "Record ID: " + r.id));
    assert.deepEqual(notes(ui), exact);
    assert.deepEqual(proposals(ui).map(s => s.querySelectorAll("p")[0].textContent),
      value.overlaps.flatMap(r => r.proposals.map(p => "Decision: " + p.decision)));
    assert.deepEqual(proposals(ui).map(s => s.querySelectorAll("h4")[0].textContent),
      value.overlaps.flatMap(r => r.proposals.map(p => "Source " + p.sourceOrdinal + ": " + p.filename)));
    assert.deepEqual(proposals(ui).map(s => JSON.parse(s.querySelectorAll("pre")[1].textContent)), exact);
    assert.match(ui.$("overlap-results").textContent, /SAVED recorded classification: Identical/);
    assert.match(ui.$("overlap-results").textContent, /SAVED recorded classification: Disagreement/);
    assert.match(ui.$("overlap-results").textContent, /Notes: empty \(0 characters\)/);
    assert.equal(ui.$("overlap-results").querySelectorAll("script").length, 0);
  }
});

test("saved reports reuse bounded ordered paging, all filters, and honest empty states", async () => {
  for (const built of [false, true]) {
    const ui = app({ built }); await openSaved(ui);
    const ids = () => ui.$("overlap-results").querySelectorAll("h3").map(n => n.textContent);
    assert.equal(ids().length, 10); assert.equal(ui.$("previous-page").disabled, true);
    await ui.fire("next-page"); await ui.fire("next-page");
    assert.deepEqual(ids(), [20, 21, 22].map(i => "Record ID: id-" + i));
    assert.equal(ui.$("next-page").disabled, true);
    for (const [filter, count, last] of [["disagreement", 11, [21]], ["identical", 12, [20, 22]]]) {
      ui.$("overlap-filter").value = filter; await ui.fire("overlap-filter", "change");
      assert.match(ui.$("page-status").textContent, new RegExp("SAVED report.*of " + count + " matching overlaps.*Page 1 of 2"));
      assert.equal(ids().length, 10);
      await ui.fire("next-page"); assert.deepEqual(ids(), last.map(i => "Record ID: id-" + i));
      assert.match(ui.$("result-context").textContent, /^SAVED/);
    }
    ui.$("overlap-filter").value = "all"; await ui.fire("overlap-filter", "change");
    assert.equal(ids()[0], "Record ID: __proto__");
    await openSaved(ui, savedReport(0));
    assert.match(ui.$("overlap-empty").textContent, /No overlapping proposals recorded/);
    assert.match(ui.$("page-status").textContent, /SAVED report.*Showing 0.*Page 0 of 0/);
    assert.equal(ui.$("next-page").disabled, true); assert.equal(ui.$("previous-page").disabled, true);
    await openSaved(ui, savedReport(1));
    ui.$("overlap-filter").value = "disagreement"; await ui.fire("overlap-filter", "change");
    assert.match(ui.$("overlap-empty").textContent, /No overlaps match this filter/);
  }
});

test("saved replacement, clearing, workflow switch and failed reread invalidate all previous values", async () => {
  for (const built of [false, true]) {
    for (const mutate of [ui => ui.saved(file("new.json", savedReport())), ui => ui.saved(null),
      ui => ui.fire("clear-saved"), ui => ui.workflow("analyze")]) {
      const ui = app({ built }); await openSaved(ui); await ui.fire("next-page");
      await mutate(ui); invalidated(ui); assert.equal(ui.$("overlap-filter").value, "all");
    }
    const ui = app({ built }); await ready(ui); await ui.fire("analyze");
    assert.match(ui.$("result-context").textContent, /^FRESH/);
    await ui.workflow("saved"); invalidated(ui);
    assert.equal(ui.$("analyze-inputs").hidden, true); assert.equal(ui.$("saved-inputs").hidden, false);
    let text = JSON.stringify(savedReport());
    await ui.saved({ name: "reread.json", text: async () => text }); await ui.fire("view-saved");
    text = "{"; await ui.fire("view-saved");
    assert.equal(ui.$("results").hidden, true); assert.equal(ui.$("result-context").textContent, "");
    assert.equal(ui.$("source-results").textContent, ""); assert.equal(ui.$("overlap-results").textContent, "");
    assert.match(ui.$("analysis-error").textContent, /invalid JSON/);
    assert.match(ui.$("analysis-status").textContent, /No results retained/);
    downloadUnavailable(ui);
    assert.equal(ui.$("view-saved").disabled, false);
    await ui.fire("clear-saved"); invalidated(ui);
    assert.equal(ui.document.activeElement, ui.$("saved-file"));
    assert.equal(ui.$("view-saved").disabled, true);
    await ui.workflow("analyze"); await ui.fire("analyze");
    assert.match(ui.$("results-heading").textContent, /Fresh analysis/);
    assert.doesNotMatch(ui.$("source-results").textContent + ui.$("page-status").textContent, /SAVED/);
    const fresh = app({ built }); assert.equal(fresh.$("saved-name").textContent, "None chosen");
    assert.equal(fresh.$("results").hidden, true);
  }
});

test("current saved input failures retain no partial report, remain literal and retryable", async () => {
  for (const value of ["{", snapshot(), { ...savedReport(), kind: "wrong" },
    { ...savedReport(), overlaps: [{ id: "late invalid", status: "identical", proposals: [] }] }]) {
    const ui = app(); await openSaved(ui); await ui.saved(file("bad.json", value)); await ui.fire("view-saved");
    assert.equal(ui.$("results").hidden, true); assert.equal(ui.$("source-results").textContent, "");
    assert.equal(ui.$("result-context").textContent, "");
    assert.match(ui.$("analysis-error").textContent, /Saved report/);
    downloadUnavailable(ui);
    assert.equal(ui.$("view-saved").disabled, false);
  }
  const ui = app(); await ui.workflow("saved"); const bad = deferred("<bad>.json");
  await ui.saved(bad.file); const pending = ui.fire("view-saved"); bad.reject(new Error("denied <literal>")); await pending;
  assert.match(ui.$("analysis-error").textContent, /Could not read.*<bad>.*denied <literal>/);
  assert.equal(ui.$("results").hidden, true); assert.equal(ui.$("view-saved").disabled, false);
  downloadUnavailable(ui);
});

test("saved and fresh late successes/failures never replace newer choices, results or errors", async () => {
  for (const built of [false, true]) for (const oldMode of ["saved", "analyze"]) for (const newMode of ["saved", "analyze"]) {
    for (const oldFails of [false, true]) for (const newFails of [false, true]) {
      const ui = app({ built }); const old = deferred("old.json");
      await ready(ui); await ui.workflow(oldMode);
      if (oldMode === "saved") await ui.saved(old.file); else await ui.working(old.file);
      const pending = ui.fire(oldMode === "saved" ? "view-saved" : "analyze");
      await ui.workflow(newMode); invalidated(ui);
      if (newMode === "saved") await ui.saved(file("new.json", newFails ? "[]" : savedReport()));
      else await ui.working(file("new.json", newFails ? "[]" : snapshot()));
      await ui.fire(newMode === "saved" ? "view-saved" : "analyze");
      const expected = visibleState(ui);
      if (oldFails) old.reject(new Error("stale <error>"));
      else old.resolve(JSON.stringify(oldMode === "saved" ? savedReport() : snapshot()));
      await pending;
      assert.deepEqual(visibleState(ui), expected); assert.equal(ui.$("results").hidden, newFails);
      assert.equal(ui.$(newMode === "saved" ? "view-saved" : "analyze").disabled, false);
      if (newMode === "analyze" && !newFails) {
        downloadReady(ui); await ui.fire("download-analysis");
        const text = await ui.downloads[0].blob.text();
        const expectedReport = analyzeReturns({ filename: "new.json", text: JSON.stringify(snapshot()) },
          [0, 1].map(i => ({ filename: "return-" + i + ".json", text: JSON.stringify(snapshot()) })));
        assert.equal(text, JSON.stringify(expectedReport, null, 2) + "\n");
      } else downloadUnavailable(ui);
    }
  }
});

test("saved clearing discards pending reads and old completion cannot unlock a newer saved read", async () => {
  for (const fails of [false, true]) {
    const ui = app(); await ui.workflow("saved"); const old = deferred("old.json"), fresh = deferred("fresh.json");
    await ui.saved(old.file); const older = ui.fire("view-saved");
    await ui.fire("clear-saved"); invalidated(ui);
    await ui.saved(fresh.file); const newer = ui.fire("view-saved");
    if (fails) old.reject(new Error("old")); else old.resolve(JSON.stringify(savedReport()));
    await older; assert.equal(ui.$("view-saved").disabled, true); invalidated(ui);
    fresh.resolve(JSON.stringify(savedReport())); await newer;
    assert.equal(ui.$("results").hidden, false); assert.equal(ui.$("view-saved").disabled, false);
    const pending = deferred("cleared.json"); await ui.saved(pending.file); const run = ui.fire("view-saved");
    await ui.saved(null); pending.resolve(JSON.stringify(savedReport())); await run; invalidated(ui);
    assert.equal(ui.$("view-saved").disabled, true);
  }
});


test("explicit FRESH download preserves the whole real report, CLI bytes and literal values beyond filters/pages", async () => {
  const current = snapshot(24);
  for (const [i, id] of ["__proto__", "constructor", "  <id>雪\r\n  ", "0007"].entries()) current.records[i].id = id;
  current.reviews = Object.fromEntries(current.records.map(({ id }) => [id, { decision: "unreviewed", notes: "" }]));
  const first = structuredClone(current), second = structuredClone(current);
  const literals = ["", "\r", "\r\n", "  <script>literal</script>\r\n雪 e\u0301\t  ", " ", "end\n"];
  first.records.reverse();
  for (const [i, { id }] of current.records.entries()) {
    first.reviews[id].notes = literals[i % literals.length];
    second.reviews[id].notes = i % 2 ? "different\n" : literals[i % literals.length];
    first.reviews[id].decision = second.reviews[id].decision = ["unreviewed", "approved", "rejected", "follow-up"][i % 4];
  }
  first.records[0].title = "Changed record";
  first.records.push({ id: "unknown", title: "Unknown" });
  first.reviews.unknown = { decision: "approved", notes: "not a proposal" };
  const values = [current, first, second], before = JSON.stringify(values);
  const inputs = values.map((v, i) => ({ filename: i ? "  same\r\n<return>雪.json  " : "<working>雪.json", text: JSON.stringify(v) }));
  const expected = analyzeReturns(inputs[0], inputs.slice(1));
  const expectedText = JSON.stringify(expected, null, 2) + "\n";
  // Pin the existing CLI expression by source inspection; do not execute it.
  assert.ok(source("review-return-analysis.js").includes('const json = JSON.stringify(report, null, 2) + "\\n";'));
  for (const built of [false, true]) {
    const ui = app({ built }); downloadUnavailable(ui);
    const files = inputs.map(input => file(input.filename, input.text));
    await ui.working(files[0]); await ui.add(...files.slice(1)); downloadUnavailable(ui);
    const pending = ui.fire("analyze"); downloadUnavailable(ui); await pending;
    downloadReady(ui); assert.equal(ui.downloads.length, 0); assert.equal(ui.urls.size, 0);
    assert.match(ui.$("download-status").textContent, /FRESH report ready/);
    await ui.fire("next-page");
    for (const filter of ["all", "identical", "disagreement"]) {
      ui.$("overlap-filter").value = filter; await ui.fire("overlap-filter", "change");
      await ui.fire("next-page");
      await ui.fire("download-analysis");
      const download = ui.downloads.at(-1);
      assert.equal(download.filename, "record-review-return-analysis.json");
      assert.equal(download.blob.type, "application/json");
      assert.deepEqual(Buffer.from(await download.blob.arrayBuffer()), Buffer.from(expectedText, "utf8"));
      assert.deepEqual(JSON.parse(await download.blob.text()), expected);
      assert.deepEqual(parseReportJSON(await download.blob.text()), expected);
      assert.equal(ui.document.body.children.length, 0);
      assert.match(ui.$("download-status").textContent, /requested, not confirmed/);
      assert.equal(ui.analysisCalls, 1); assert.deepEqual(files.map(f => f.reads), [1, 1, 1]);
      downloadReady(ui);
    }
    assert.equal(ui.downloads.length, 3);
    assert.equal(new Set(ui.downloads.map(d => d.url)).size, 3);
    assert.equal(ui.urls.size, 3); assert.equal(ui.timers.length, 3);
    for (const timer of ui.timers) { assert.equal(timer.delay, 60000); timer.callback(); }
    assert.equal(ui.urls.size, 0);
    const savedUI = app({ built, savedOnly: true });
    await openSaved(savedUI, await ui.downloads[0].blob.text());
    assert.equal(savedUI.analysisCalls, 0); assert.equal(savedUI.downloads.length, 0);
    assert.match(savedUI.$("result-context").textContent, /^SAVED/);
    assert.equal(savedUI.$("source-results").children.length, expected.sources.length);
    // Switching away drops the fresh report; returning cannot revive it.
    await ui.workflow("saved"); downloadUnavailable(ui);
    await ui.saved(file("downloaded.json", expectedText)); await ui.fire("view-saved"); downloadUnavailable(ui);
    await ui.workflow("analyze"); downloadUnavailable(ui);
    await ui.fire("analyze"); downloadReady(ui);
    assert.equal(ui.analysisCalls, 2);
  }
  assert.equal(JSON.stringify(values), before);
});

test("a new analysis immediately removes download readiness; current failure and pending retry never expose the old report", async () => {
  for (const built of [false, true]) for (const failure of ["read", "validation"]) {
    const ui = app({ built }); const current = snapshot();
    let read = async () => JSON.stringify(current);
    await ui.working({ name: "working.json", text: () => read() });
    await ui.add(file("a.json"), file("b.json")); await ui.fire("analyze"); downloadReady(ui);
    await ui.fire("download-analysis");
    // A cancelled append did not alter the choices or invalidate their report.
    await ui.add(); downloadReady(ui);
    const next = deferred("reread"); read = next.file.text;
    const pending = ui.fire("analyze"); invalidated(ui);
    if (failure === "read") next.reject(new Error("read failed")); else next.resolve("{");
    await pending; downloadUnavailable(ui);
    assert.match(ui.$("analysis-status").textContent, /Analysis failed.*No results retained/);
    assert.match(ui.$("download-status").textContent, /No current FRESH report/);
    assert.equal(ui.downloads.length, 1);
    const retry = deferred("retry"); read = retry.file.text;
    const retrying = ui.fire("analyze"); invalidated(ui);
    retry.resolve(JSON.stringify(current)); await retrying; downloadReady(ui);
    await ui.fire("download-analysis");
    assert.equal(await ui.downloads[1].blob.text(), await ui.downloads[0].blob.text());
    // A valid empty analysis, including zero overlaps, is also a ready report.
    await ui.working(file("empty-working.json", snapshot(0))); downloadUnavailable(ui);
    await ui.fire("clear-returns"); await ui.add(file("empty-return.json", snapshot(0)));
    await ui.fire("analyze"); downloadReady(ui); await ui.fire("download-analysis");
    assert.deepEqual(JSON.parse(await ui.downloads[2].blob.text()).overlaps, []);
  }
});

test("download failures give honest retry guidance and clean links/URLs without invalidating valid analysis", async () => {
  for (const built of [false, true]) for (const downloadError of ["url", "click"]) {
    const ui = app({ built, downloadError }); await ready(ui); await ui.fire("analyze");
    const before = visibleState(ui).slice(0, -1);
    for (let attempt = 0; attempt < 2; attempt++) {
      await ui.fire("download-analysis");
      assert.match(ui.$("download-status").textContent, /could not be requested.*Try again/);
      assert.doesNotMatch(ui.$("download-status").textContent, /saved successfully|overwrit|clipboard/i);
      assert.equal(ui.downloads.length, 0); assert.equal(ui.document.body.children.length, 0);
      assert.equal(ui.urls.size, downloadError === "click" ? attempt + 1 : 0);
      downloadReady(ui); assert.equal(ui.analysisCalls, 1);
      assert.deepEqual(visibleState(ui).slice(0, -1), before);
    }
    for (const timer of ui.timers) { assert.equal(timer.delay, 60000); timer.callback(); }
    assert.equal(ui.urls.size, 0);
    await ui.control(0, "Remove").emit(); invalidated(ui);
    assert.match(ui.$("download-status").textContent, /No current FRESH report/);
  }
});
