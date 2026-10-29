"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const R = require("./review-state.js");

// Small adapter harness, not a browser substitute. It runs the actual app and
// records editor writes/storage effects while controlling asynchronous reads.
function app(initial, { downloadError = false } = {}) {
  let document;
  const downloads = [], urls = new Map(), timers = [], documentListeners = new Map();
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.listeners = new Map();
      this.dataset = {}; this.attributes = {}; this.hidden = false; this.open = false;
      this.valueWrites = 0; this._value = ""; this._text = "";
      this.classList = { toggle() {} };
    }
    get value() { return this._value; }
    set value(value) { this._value = value; this.valueWrites++; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(""); }
    set textContent(value) { this._text = String(value); this.children = []; }
    set innerHTML(value) { throw new Error("Unexpected HTML rendering: " + value); }
    get firstElementChild() { return this.children[0]; }
    get isConnected() { let node = this; while (node.parent) node = node.parent; return [...nodes.values()].includes(node); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    insertBefore(node, before) {
      node.remove(); node.parent = this;
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll(selector) {
      const nodes = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return nodes;
      return nodes.filter(node => selector === "details[open]" ? node.tag === "details" && node.open : node.tag === selector);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    emit(type) { return Promise.all((this.listeners.get(type) || []).map(handler => handler({ target: this }))); }
    focus() {
      const old = document.activeElement;
      document.activeElement = this;
      if (old && old !== this) old.emit("blur");
    }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    closest(selector) {
      assert.equal(selector, "button:not(:disabled), summary");
      return (this.tag === "button" && !this.disabled) || this.tag === "summary" ? this : this.parent?.closest(selector);
    }
    click() {
      assert.equal(this.tag, "a");
      assert.equal(this.parent, document.body);
      downloads.push({ filename: this.download, blob: urls.get(this.href) });
    }
  }
  const template = fs.readFileSync(path.join(__dirname, "review-template.html"), "utf8");
  const nodes = new Map([...template.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, new Element(tag)]));
  const $ = id => { assert.ok(nodes.has(id), "Unknown template ID: " + id); return nodes.get(id); };
  const buttons = R.DECISIONS.map(decision => { const node = new Element("button"); node.dataset.decision = decision; return node; });
  document = { getElementById: $, createElement: tag => new Element(tag),
    querySelectorAll: selector => { assert.equal(selector, "[data-decision]"); return buttons; },
    body: new Element("body"),
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    } };
  $("empty").append(new Element("h2"), new Element("p"));
  $("filter").value = "all";
  $("paste-format").value = "json";
  $("bulk-decision").value = "unreviewed";
  let saved = R.exportJSON(initial);
  let writes = 0;
  const storage = { getItem: () => saved, setItem: (key, value) => { assert.equal(key, R.STORAGE_KEY); writes++; saved = value; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "review-app.js"), "utf8"), {
    RecordReview: R, document, window: { localStorage: storage },
    Blob, URL: {
      createObjectURL(blob) {
        if (downloadError) throw new Error("Download blocked");
        const url = "blob:test-" + urls.size; urls.set(url, blob); return url;
      },
      revokeObjectURL(url) { urls.delete(url); },
    },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
  });
  const fire = (id, type = "click") => $(id).emit(type);
  const compare = async text => { $("compare-json").value = text; await fire("compare-paste"); };
  const paste = async (text, format = "json") => {
    $("paste-format").value = format; $("paste-json").value = text; await fire("import-paste");
  };
  const pendingFile = (id = "compare-file", name = "pending.json") => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    $(id).files = [{ name, text: () => promise }];
    $(id).value = name;
    const done = fire(id, "change");
    return { resolve, reject, done };
  };
  const working = () => ({ saved, writes, id: $("record-id").textContent, notes: $("notes").value,
    noteWrites: $("notes").valueWrites, search: $("search").value, filter: $("filter").value,
    count: $("list-count").textContent, storageStatus: $("storage-status").textContent,
    activity: $("activity").textContent, exported: $("export-json").value });
  const activate = async id => {
    const target = $(id);
    for (const handler of documentListeners.get("click") || []) handler({ target });
    await target.emit("click");
  };
  return { $, fire, activate, compare, paste, pendingFile, working, document, buttons, downloads, urls, timers };
}

const fixture = () => R.importJSON(JSON.stringify({ format: R.FORMAT, version: R.VERSION,
  records: [{ id: "a", title: "Alpha", extra: { a: 1, b: 2 } }, { id: "b", title: "Beta" }],
  reviews: { a: { decision: "approved", notes: "keep Alpha" }, b: { decision: "approved", notes: "keep Beta" } },
}));

test("CSV and JSON paste use the same acceptance transition and update a fixed comparison", async () => {
  const csv = "id,title,notes,decision\nb,Renamed,source note,rejected\na,Alpha,,approved\nc,New,not review notes,follow-up";
  const records = R.importCSV(csv).records;
  for (const format of ["csv", "json"]) {
    const ui = app(fixture());
    const { $, fire, paste } = ui;
    await fire("compare-open"); await ui.compare(R.exportJSON(fixture()));
    await fire("export-open");
    $("search").value = "keep"; await fire("search", "input");
    $("filter").value = "approved"; await fire("filter", "change");
    const writes = ui.working().writes;
    await paste(format === "csv" ? csv : JSON.stringify(records), format);
    assert.deepEqual(JSON.parse(ui.working().saved), R.importJSON(JSON.stringify(records), fixture()));
    assert.equal(ui.working().writes, writes + 1);
    assert.equal($("export-json").value, ui.working().saved);
    assert.equal($("record-id").textContent, "b");
    assert.equal($("notes").value, "keep Beta");
    assert.equal($("search").value, "");
    assert.equal($("filter").value, "all");
    assert.equal($("import-panel").open, false);
    assert.equal($("import-error").textContent, "");
    assert.match($("activity").textContent, new RegExp("Accepted 3 records from pasted " + format.toUpperCase()));
    assert.match($("compare-status").textContent, /Current: 3 records · Compared: 2/);
    assert.match($("compare-breakdown").textContent, /Decision[/]note changes: 0/);
    const values = $("compare-list").querySelectorAll("details")[0].querySelectorAll("pre").map(node => JSON.parse(node.textContent));
    assert.deepEqual(values[0], records[0]);
    assert.deepEqual(values[2], fixture().records[1]); // compared side did not change
    await paste("id,title", "csv");
    assert.equal($("record-editor").hidden, true);
    assert.deepEqual(JSON.parse(ui.working().saved), R.emptyState());
    await paste(R.exportJSON(fixture())); // JSON snapshot restore remains exact
    assert.deepEqual(JSON.parse(ui.working().saved), fixture());
    assert.equal($("compare-empty").hidden, false);
  }
});

test("rejected CSV/JSON paste and files preserve data, selection, filters, storage and comparison", async () => {
  const ui = app(fixture());
  const { $, fire, paste, pendingFile } = ui;
  $("search").value = "keep"; await fire("search", "input");
  $("filter").value = "approved"; await fire("filter", "change");
  await $("record-list").children[1].firstElementChild.emit("click");
  await fire("export-open");
  await fire("compare-open"); await ui.compare(R.exportJSON(R.emptyState()));
  const stable = () => { const { activity, ...working } = ui.working(); return working; };
  const before = stable();
  const row = $("record-list").children[1];
  const comparison = $("compare-list").firstElementChild;
  for (const [format, invalid] of [["csv", 'id,title\na,Valid\nb,"Unclosed'],
    ["csv", "id,title\na,Valid\na,Duplicate"], ["json", "{bad"],
    ["json", '[{"id":"a","title":"Valid"},{"id":"a","title":"Duplicate"}]']]) {
    await paste(invalid, format);
    assert.deepEqual(stable(), before);
    assert.match($("import-error").textContent, /unchanged/);
    const file = pendingFile(format === "csv" ? "csv-file-input" : "file-input");
    file.resolve(invalid); await file.done;
    assert.deepEqual(stable(), before);
    assert.equal($("record-list").children[1], row);
    assert.equal($("compare-list").firstElementChild, comparison);
  }
  for (const id of ["file-input", "csv-file-input"]) {
    const file = pendingFile(id); file.reject(new Error("Unreadable")); await file.done;
    assert.match($("import-error").textContent, /Could not read/);
    assert.deepEqual(stable(), before);
  }
});

test("JSON and CSV files/paste/sample share latest-started-wins, including rejected attempts", async () => {
  const ui = app(fixture());
  const { $, paste, pendingFile } = ui;
  const json = '[{"id":"json","title":"JSON"}]';
  const csv = "id,title\ncsv,CSV";
  const oldJSON = pendingFile("file-input");
  // The explicit file control, not extension or the paste selector, owns parsing.
  const newCSV = pendingFile("csv-file-input", "records.json");
  assert.equal($("csv-file-input").value, "");
  $("paste-format").value = "json";
  newCSV.resolve(csv); await newCSV.done;
  oldJSON.resolve(json); await oldJSON.done;
  assert.equal($("record-id").textContent, "csv");
  const oldCSV = pendingFile("csv-file-input");
  const newJSON = pendingFile("file-input", "records.csv");
  $("paste-format").value = "csv";
  newJSON.resolve(json); await newJSON.done;
  oldCSV.reject(new Error("Late failure")); await oldCSV.done;
  assert.equal($("record-id").textContent, "json");
  assert.equal($("import-error").textContent, "");

  for (const [id, content, format, pasted] of [["file-input", json, "csv", csv], ["csv-file-input", csv, "json", json]]) {
    const pending = pendingFile(id);
    await paste(pasted, format);
    const accepted = ui.working();
    pending.resolve(content); await pending.done;
    assert.deepEqual(ui.working(), accepted);
    const stale = pendingFile(id);
    // Valid content in the *wrong* explicit format is rejected, not guessed.
    await paste(content, format);
    const rejected = ui.working();
    assert.match($("import-error").textContent, /unchanged/);
    stale.resolve(content); await stale.done;
    assert.deepEqual(ui.working(), rejected);
  }
  const superseded = pendingFile("csv-file-input");
  const failed = pendingFile("file-input");
  failed.reject(new Error("Unreadable")); await failed.done;
  const failure = ui.working();
  superseded.resolve(csv); await superseded.done;
  assert.deepEqual(ui.working(), failure);
  assert.match($("import-error").textContent, /Could not read/);
  const csvBeforeSample = pendingFile("csv-file-input");
  const jsonBeforeSample = pendingFile("file-input");
  $("paste-format").value = "csv"; // sample is still JSON, independent of paste choice
  await ui.fire("sample");
  const sample = ui.working();
  csvBeforeSample.resolve(csv); jsonBeforeSample.reject(new Error("Late"));
  await Promise.all([csvBeforeSample.done, jsonBeforeSample.done]);
  assert.deepEqual(ui.working(), sample);
  assert.equal($("record-id").textContent, "R-101");
});

test("comparison UI renders complete text while leaving working/editor/storage state untouched", async () => {
  const ui = app(fixture());
  const { $, fire, compare } = ui;
  $("search").value = "keep"; await fire("search", "input");
  $("filter").value = "approved"; await fire("filter", "change");
  await $("record-list").children[1].firstElementChild.emit("click");
  $("notes").focus(); $("notes").value = "Now outside results"; await fire("notes", "input");
  $("notes").selectionStart = 5; $("notes").selectionEnd = 5;
  await fire("compare-open"); // blur keeps the out-of-results selection
  assert.equal($("record-id").textContent, "b");
  assert.equal($("list-count").textContent, "1 of 2 records");
  const before = ui.working();
  const row = $("record-list").firstElementChild;
  const hostile = '<img src=x onerror="bad()"> 雪 </textarea>';
  let incoming = R.importJSON(JSON.stringify([
    { id: "__proto__", title: hostile }, { id: "a", title: "Alpha", extra: { b: 2, a: 1 } },
    { id: "b", title: hostile, empty: "", payload: [null, false, "雪"] },
  ]));
  incoming = R.updateReview(incoming, "b", { decision: "rejected", notes: hostile + "\n" });
  await compare(R.exportJSON(incoming));
  assert.equal($("compare-results").hidden, false);
  assert.match($("compare-status").textContent, /Added: 1 · Removed: 0 · Shared: 2 \(changed: 2, unchanged: 0\)/);
  assert.match($("compare-breakdown").textContent, /record-field changes: 1/);
  const details = $("compare-list").querySelectorAll("details");
  assert.deepEqual(details.map(node => node.dataset.id), ["a", "b", "__proto__"]);
  assert.match(details[0].firstElementChild.textContent, /Decision changed · Notes changed/);
  assert.doesNotMatch(details[0].firstElementChild.textContent, /Record fields/);
  const values = details[1].querySelectorAll("pre").map(node => JSON.parse(node.textContent));
  assert.deepEqual(values, [fixture().records[1], { decision: "approved", notes: "Now outside results" }, incoming.records[2], incoming.reviews.b]);
  assert.match(details[2].textContent, /Not present in this review/);
  assert.deepEqual(ui.working(), before);
  assert.equal($("record-list").firstElementChild, row);
  assert.equal($("notes").selectionStart, 5);
  assert.equal($("notes").selectionEnd, 5);
  await fire("compare-close");
  assert.equal($("compare-panel").open, false);
  assert.equal($("compare-results").hidden, true);
  assert.equal($("compare-list").children.length, 0);
  assert.equal($("compare-json").value, "");
  assert.equal(ui.document.activeElement, $("compare-open"));
  assert.deepEqual(ui.working(), before);
});

test("comparison reads are latest-started-wins, including rejection, failure, and closing", async () => {
  const ui = app(fixture());
  const { $, fire, compare, pendingFile } = ui;
  const accepted = R.exportJSON(fixture());
  const other = R.exportJSON(R.emptyState());
  await fire("compare-open");
  const before = ui.working();
  await compare(accepted);
  assert.equal($("compare-empty").hidden, false);
  const slow = pendingFile();
  assert.equal($("compare-results").hidden, true); // no stale accepted comparison while reading
  assert.equal($("compare-file").value, "");
  await compare(other);
  const latest = $("compare-status").textContent;
  slow.resolve(accepted); await slow.done;
  assert.equal($("compare-status").textContent, latest);
  const old = pendingFile();
  const newer = pendingFile("compare-file", "newer.json");
  newer.resolve(accepted); await newer.done;
  old.reject(new Error("Late failure")); await old.done;
  assert.equal($("compare-error").textContent, "");
  assert.equal($("compare-empty").hidden, false);
  assert.match($("compare-source").textContent, /newer.json/);
  for (const invalid of ["bad JSON", "[]", '{"format":"record-review","version":2}']) {
    const pending = pendingFile();
    await compare(invalid);
    const error = $("compare-error").textContent;
    pending.resolve(accepted); await pending.done;
    assert.equal($("compare-results").hidden, true);
    assert.equal($("compare-list").children.length, 0);
    assert.match(error, /working review is unchanged/);
    assert.equal($("compare-error").textContent, error);
  }
  const superseded = pendingFile();
  const failed = pendingFile();
  failed.reject(new Error("Unreadable")); await failed.done;
  superseded.resolve(accepted); await superseded.done;
  assert.match($("compare-error").textContent, /Could not read/);
  assert.equal($("compare-results").hidden, true);
  const closed = pendingFile();
  await fire("compare-close"); await fire("compare-open");
  closed.resolve(accepted); await closed.done;
  assert.equal($("compare-results").hidden, true);
  assert.equal($("compare-status").textContent, "");
  const collapsed = pendingFile();
  $("compare-panel").open = false; await fire("compare-panel", "toggle");
  $("compare-panel").open = true;
  collapsed.reject(new Error("Closed")); await collapsed.done;
  assert.equal($("compare-error").textContent, "");
  assert.deepEqual(ui.working(), before);
  const summaryClosed = pendingFile();
  await fire("compare-toggle"); // even a close/reopen before the queued toggle
  summaryClosed.resolve(accepted); await summaryClosed.done;
  assert.equal($("compare-results").hidden, true);
});

test("comparison follows live working edits/imports without taking ownership of import ordering", async () => {
  const ui = app(fixture());
  const { $, fire, compare, pendingFile } = ui;
  const original = R.exportJSON(fixture());
  await fire("compare-open");
  await compare(original);
  $("notes").value = "Changed while comparing"; await fire("notes", "input");
  let details = $("compare-list").querySelectorAll("details");
  details[0].open = true;
  assert.match(details[0].firstElementChild.textContent, /Notes changed/);
  $("notes").value = "Changed again"; await fire("notes", "input");
  details = $("compare-list").querySelectorAll("details");
  assert.equal(details[0].open, true);
  assert.equal(JSON.parse(details[0].querySelectorAll("pre")[1].textContent).notes, "Changed again");
  const comparison = pendingFile();
  const importing = pendingFile("file-input");
  await compare("invalid JSON"); // cannot invalidate an unrelated import
  importing.resolve('[{"id":"new","title":"New working review"}]'); await importing.done;
  comparison.resolve(original); await comparison.done;
  assert.equal($("record-id").textContent, "new");
  assert.equal($("compare-results").hidden, true);
  const currentRead = pendingFile();
  const csvRead = pendingFile("csv-file-input");
  csvRead.resolve("id,title"); await csvRead.done;
  currentRead.resolve(original); await currentRead.done;
  assert.match($("compare-status").textContent, /Current: 0 records · Compared: 2 · Added: 2/);
  $("paste-json").value = original; await fire("import-paste");
  assert.equal($("compare-empty").hidden, false);
});


const selectRow = (ui, index) => ui.$("record-list").children[index].children[1].emit("click");
const applyBulk = async (ui, decision) => { ui.$("bulk-decision").value = decision; await ui.fire("bulk-apply"); };

test("selected download contains exact working records in original order and imports via the normal JSON file control", async () => {
  const ids = ["a", "__proto__", "constructor", " A ", "leave"];
  let initial = R.importJSON(JSON.stringify(ids.map(id => Object.fromEntries([
    ["id", id], ["title", "Record " + id], ["__proto__", { own: true }],
    ["payload", [false, null, "003", { html: "</textarea> 雪", lines: "a\rb\r\nc\n" }]],
    ["notes", "source notes"], ["decision", "source decision"],
  ]))));
  ids.forEach((id, index) => { initial = R.updateReview(initial, id, {
    decision: index === 0 ? "approved" : R.DECISIONS[index % 4], notes: '  "雪"\r\n' + id,
  }); });
  const ui = app(initial);
  const { $, fire } = ui;
  await fire("compare-open"); await ui.compare(R.exportJSON(initial));
  await selectRow(ui, 0); await applyBulk(ui, "unreviewed");
  await fire("clear-selection");
  for (const index of [3, 2, 1, 0]) await selectRow(ui, index);
  $("search").value = "leave"; await fire("search", "input");
  $("filter").value = "unreviewed"; await fire("filter", "change");
  const before = ui.working();
  const selection = $("bulk-count").textContent;
  const comparison = $("compare-list").firstElementChild;
  const compareStatus = $("compare-status").textContent;
  await fire("export-selected");
  assert.match($("export-scope").textContent, /Selected records: 4 records, including 4 hidden/);
  assert.match($("export-scope").textContent, /when prepared.*All decision statuses included/);
  assert.match($("export-summary").textContent, /Selected records/);
  assert.match($("download").textContent, /selected/);
  await fire("select-export");
  assert.equal($("export-json").selectionEnd, $("export-json").value.length);
  await fire("download");
  assert.equal(ui.downloads.length, 1);
  const { blob, filename } = ui.downloads[0];
  assert.equal(filename, "record-review-selected.json");
  assert.equal(blob.type, "application/json");
  const json = await blob.text();
  const current = JSON.parse(before.saved);
  const expected = { ...current, records: current.records.slice(0, 4),
    reviews: Object.fromEntries(ids.slice(0, 4).map(id => [id, current.reviews[id]])) };
  assert.deepEqual(JSON.parse(json), expected);
  assert.equal(json, $("export-json").value);
  assert.match($("download-status").textContent, /Selected records — Download requested, not confirmed/);
  assert.match($("download-status").textContent, /Clipboard fidelity is not verified/);
  const { exported: beforeJSON, ...beforeWorking } = before;
  const { exported: afterJSON, ...afterWorking } = ui.working();
  assert.deepEqual(afterWorking, beforeWorking);
  assert.equal($("bulk-count").textContent, selection);
  assert.equal($("bulk-undo").disabled, false);
  assert.equal($("compare-list").firstElementChild, comparison);
  assert.equal($("compare-status").textContent, compareStatus);
  assert.equal(ui.document.body.children.length, 0);
  assert.equal(ui.timers[0].delay, 60000);
  ui.timers[0].callback(); assert.equal(ui.urls.size, 0);

  // Node Blob/request proof, not a claim that a browser saved a file.
  const recipient = app(R.importJSON('[{"id":"recipient-only","title":"Replace me"}]'));
  recipient.$("file-input").files = [{ name: filename, text: () => blob.text() }];
  await recipient.fire("file-input", "change");
  assert.deepEqual(JSON.parse(recipient.working().saved), expected);
  assert.equal(recipient.working().writes, 1);
  assert.match(recipient.$("activity").textContent, /Accepted 4 records from record-review-selected.json/);
  assert.equal(recipient.$("import-error").textContent, "");
  assert.match(recipient.$("bulk-count").textContent, /0 selected/);
  await fire("bulk-undo");
  assert.deepEqual(JSON.parse(ui.working().saved), initial); // export did not consume undo
  assert.equal($("compare-empty").hidden, false);
});

test("empty selected export cannot download or silently fall back to an already open full export", async () => {
  for (const initial of [fixture(), R.emptyState()]) {
    const ui = app(initial);
    const { $, fire } = ui;
    await fire("export-open");
    assert.equal($("export-selected").disabled, true);
    await fire("export-selected"); // defense even if invoked despite disabled UI
    assert.equal($("export-json").value, "");
    assert.match($("export-scope").textContent, /Select at least one record/);
    assert.equal($("download").disabled, true);
    assert.equal($("select-export").disabled, true);
    await fire("download"); await fire("select-export");
    assert.equal(ui.downloads.length, 0);
    assert.equal(ui.urls.size, 0);
    assert.equal(ui.working().writes, 0);
    await fire("export-open"); await fire("download");
    assert.equal(ui.downloads[0].filename, "record-review.json");
    assert.deepEqual(JSON.parse(await ui.downloads[0].blob.text()), initial);
  }
});

test("reload restores working data but not selection, bulk undo or prepared selected export", async () => {
  const ui = app(fixture());
  await selectRow(ui, 1); await applyBulk(ui, "rejected");
  await ui.fire("export-selected");
  assert.deepEqual(JSON.parse(ui.$("export-json").value).records.map(record => record.id), ["b"]);
  assert.equal(ui.$("bulk-undo").disabled, false);
  const saved = ui.working().saved;
  const reloaded = app(JSON.parse(saved));
  assert.equal(reloaded.working().saved, saved);
  assert.equal(reloaded.working().writes, 0);
  assert.match(reloaded.$("bulk-count").textContent, /0 selected · 0 hidden/);
  assert.equal(reloaded.$("export-selected").disabled, true);
  assert.equal(reloaded.$("bulk-undo").disabled, true);
  assert.match(reloaded.$("export-summary").textContent, /Full review/);
  assert.match(reloaded.$("export-scope").textContent, /Full review: all 2/);
  assert.equal(reloaded.$("export-json").value, saved);
  await reloaded.fire("download");
  assert.equal(reloaded.downloads[0].filename, "record-review.json");
  assert.equal(await reloaded.downloads[0].blob.text(), saved);
  assert.equal(reloaded.working().writes, 0);
});

test("filtering and panel reopening preserve selected scope; only explicit full export switches it", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await selectRow(ui, 1); await fire("export-selected");
  const json = $("export-json").value;
  $("search").value = "Alpha"; await fire("search", "input");
  $("filter").value = "rejected"; await fire("filter", "change");
  assert.match($("bulk-count").textContent, /1 selected · 1 hidden/);
  $("export-panel").open = false; await fire("export-panel", "toggle");
  $("export-panel").open = true; await fire("export-panel", "toggle");
  await fire("select-export"); await fire("download");
  assert.equal($("export-json").value, json);
  assert.equal(await ui.downloads[0].blob.text(), json);
  assert.match($("export-scope").textContent, /including 0 hidden.*when prepared/);
  await fire("export-open");
  assert.equal($("export-json").value, R.exportJSON(fixture()));
  assert.match($("export-scope").textContent, /Full review: all 2/);
  await fire("clear-selection"); // never switches all to selected
  await ui.paste(JSON.stringify([...fixture().records, { id: "new", title: "New" }]));
  await fire("download");
  assert.equal(ui.downloads[1].filename, "record-review.json");
  assert.equal(await ui.downloads[1].blob.text(), ui.working().saved);
  assert.match($("download-status").textContent, /Full review — Download requested, not confirmed/);
});

test("selection and data changes explicitly invalidate prepared selected output, never retarget it", async () => {
  const changes = [
    ui => selectRow(ui, 1), ui => selectRow(ui, 0), ui => ui.fire("select-visible"), ui => ui.fire("clear-selection"),
    async ui => { ui.$("notes").value = "New selected note"; await ui.fire("notes", "input"); },
    async ui => { await ui.$("record-list").children[1].firstElementChild.emit("click");
      ui.$("notes").value = "New unselected note"; await ui.fire("notes", "input"); },
    ui => ui.buttons.find(button => button.dataset.decision === "follow-up").emit("click"),
    ui => applyBulk(ui, "approved"), ui => ui.fire("bulk-undo"),
    ui => ui.paste(R.exportJSON(fixture())), ui => ui.paste("id,title\nx,Replacement", "csv"),
    ui => ui.fire("sample"), ui => ui.paste("[]"),
    async ui => { const file = ui.pendingFile("file-input"); file.resolve(R.exportJSON(fixture())); await file.done; },
  ];
  for (const change of changes) {
    const ui = app(fixture());
    const { $, fire } = ui;
    await selectRow(ui, 0); await applyBulk(ui, "rejected"); await fire("export-selected");
    assert.equal($("download").disabled, false);
    await change(ui);
    assert.equal($("export-json").value, "");
    assert.equal($("download").disabled, true);
    assert.equal($("select-export").disabled, true);
    assert.match($("export-scope").textContent, /Selected export unavailable.*Selection|Selected export unavailable.*Working data/);
    $("export-panel").open = false; await fire("export-panel", "toggle");
    $("export-panel").open = true; await fire("export-panel", "toggle");
    await fire("download"); await fire("select-export");
    assert.equal(ui.downloads.length, 0);
    assert.equal($("export-json").value, "");
    await fire("select-visible");
    if ($("export-selected").disabled) continue; // accepted empty data
    await fire("export-selected"); await fire("download");
    assert.equal(ui.downloads[0].filename, "record-review-selected.json");
    assert.deepEqual(JSON.parse(await ui.downloads[0].blob.text()), JSON.parse(ui.working().saved));
  }
});

test("rejected, unreadable and superseded imports and comparison never invalidate selected output", async () => {
  const ui = app(fixture());
  const { $, fire, paste, pendingFile } = ui;
  await selectRow(ui, 1); await fire("export-selected");
  const json = $("export-json").value;
  const stale = pendingFile("file-input");
  await paste("{bad"); stale.resolve("[]"); await stale.done;
  await paste("id,title\na,A\na,Duplicate", "csv");
  const failure = pendingFile("file-input"); failure.reject(new Error("Denied")); await failure.done;
  await fire("compare-open"); await ui.compare(R.exportJSON(fixture()));
  await ui.compare("invalid"); await fire("compare-close");
  assert.equal($("download").disabled, false);
  await fire("download");
  assert.equal(await ui.downloads[0].blob.text(), json);
  assert.equal(ui.working().writes, 0);
  assert.match($("bulk-count").textContent, /1 selected/);
});

test("selected preparation uses shared note-exit capture before resolving hidden IDs", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await selectRow(ui, 0); await applyBulk(ui, "rejected");
  $("search").value = "keep"; await fire("search", "input");
  $("notes").focus(); $("notes").value = "No longer matches 雪"; await fire("notes", "input");
  const before = ui.working();
  await ui.activate("export-selected"); // actual registered click-capture handler
  assert.match($("export-scope").textContent, /1 records, including 1 hidden/);
  assert.match($("bulk-count").textContent, /1 selected · 1 hidden/);
  assert.equal($("record-id").textContent, "a");
  assert.equal($("notes").valueWrites, before.noteWrites);
  assert.equal(ui.working().writes, before.writes);
  assert.deepEqual(JSON.parse($("export-json").value).reviews.a, { decision: "rejected", notes: "No longer matches 雪" });
  assert.equal($("bulk-undo").disabled, false);
  await fire("bulk-undo");
  assert.equal(JSON.parse(ui.working().saved).reviews.a.notes, "No longer matches 雪");
});

test("download failure keeps the same selected JSON and reports no confirmation or clipboard fidelity", async () => {
  const ui = app(fixture(), { downloadError: true });
  await selectRow(ui, 1); await ui.fire("export-selected");
  const before = ui.working();
  await ui.fire("download");
  assert.deepEqual(ui.working(), before);
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.$("download-status").textContent, /Selected records — Download is unavailable/);
  assert.match(ui.$("download-status").textContent, /Clipboard fidelity is not verified/);
  assert.equal(ui.$("download").disabled, false);
});

test("explicit selection is independent of editor, additive across filters, and never saved", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  const original = ui.working();
  assert.equal($("bulk-apply").disabled, true);
  assert.equal($("clear-selection").disabled, true);
  assert.equal($("bulk-undo").disabled, true);
  await selectRow(ui, 1);
  assert.equal($("record-id").textContent, "a");
  assert.match($("bulk-count").textContent, /1 selected · 0 hidden/);
  assert.equal($("record-list").children[1].children[1].attributes["aria-pressed"], "true");
  $("search").value = "Alpha"; await fire("search", "input");
  assert.match($("bulk-count").textContent, /1 selected · 1 hidden/);
  await fire("select-visible");
  assert.match($("bulk-count").textContent, /2 selected · 1 hidden/);
  assert.equal($("select-visible").disabled, true);
  $("filter").value = "rejected"; await fire("filter", "change");
  assert.match($("bulk-count").textContent, /2 selected · 2 hidden/);
  assert.equal($("select-visible").disabled, true);
  assert.equal($("bulk-apply").disabled, false);
  assert.equal(ui.working().writes, original.writes);
  assert.equal(ui.working().saved, original.saved);
  await fire("clear-selection");
  assert.match($("bulk-count").textContent, /0 selected · 0 hidden/);
  assert.equal($("bulk-apply").disabled, true);
  await fire("bulk-apply");
  assert.equal(ui.working().writes, original.writes);
  const empty = app(R.emptyState());
  assert.equal(empty.$("select-visible").disabled, true);
  assert.equal(empty.$("bulk-apply").disabled, true);
});

test("bulk applies exactly selected IDs once; undo keeps later notes, comparison and full export", async () => {
  let initial = R.importJSON(JSON.stringify([...fixture().records, { id: "c", title: "Gamma", decision: "source", notes: "source" }]), fixture());
  initial = R.updateReview(initial, "b", { decision: "rejected" });
  const ui = app(initial);
  const { $, fire } = ui;
  await fire("compare-open"); await ui.compare(R.exportJSON(initial));
  await fire("export-open");
  await selectRow(ui, 0); await selectRow(ui, 1);
  $("search").value = "Gamma"; await fire("search", "input");
  const writes = ui.working().writes;
  await applyBulk(ui, "approved");
  assert.equal(ui.working().writes, writes + 1);
  const expected = R.updateReview(initial, "b", { decision: "approved" });
  assert.deepEqual(JSON.parse(ui.working().saved), expected);
  assert.equal($("export-json").value, R.exportJSON(expected));
  assert.match($("bulk-result").textContent, /Changed 1 of 2/);
  assert.match($("bulk-count").textContent, /2 selected · 2 hidden/);
  assert.match($("bulk-undo").textContent, /\(1\)/);
  assert.match($("compare-breakdown").textContent, /decisions: 1, notes: 0/);
  const comparedValues = $("compare-list").querySelectorAll("pre").map(node => JSON.parse(node.textContent));
  assert.deepEqual(comparedValues[3], initial.reviews.b);
  await fire("clear-selection");
  $("search").value = "Beta"; await fire("search", "input");
  $("notes").value = "Later b note"; await fire("notes", "input");
  await ui.compare(R.exportJSON(initial));
  const beforeUndo = ui.working().writes;
  await fire("bulk-undo");
  assert.equal(ui.working().writes, beforeUndo + 1);
  assert.deepEqual(JSON.parse(ui.working().saved), R.updateReview(initial, "b", { notes: "Later b note" }));
  assert.match($("compare-breakdown").textContent, /decisions: 0, notes: 1/);
  assert.equal($("bulk-undo").disabled, true);
  await fire("bulk-undo");
  assert.equal(ui.working().writes, beforeUndo + 1);
  const reloaded = app(JSON.parse(ui.working().saved));
  assert.match(reloaded.$("bulk-count").textContent, /0 selected/);
  assert.equal(reloaded.$("bulk-undo").disabled, true);
});

test("only the last changed bulk action is undoable; later decision intent invalidates even on no-op", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await selectRow(ui, 0);
  await applyBulk(ui, "rejected");
  await applyBulk(ui, "follow-up");
  await fire("bulk-undo");
  assert.equal(JSON.parse(ui.working().saved).reviews.a.decision, "rejected");
  await applyBulk(ui, "unreviewed");
  const writes = ui.working().writes;
  await applyBulk(ui, "unreviewed");
  assert.equal(ui.working().writes, writes);
  assert.equal($("bulk-undo").disabled, true);
  assert.match($("bulk-result").textContent, /Changed 0 of 1.*no undo available/);
  await applyBulk(ui, "approved");
  await ui.buttons.find(button => button.dataset.decision === "approved").emit("click");
  assert.equal($("bulk-undo").disabled, true);
  await fire("bulk-undo");
  assert.equal(JSON.parse(ui.working().saved).reviews.a.decision, "approved");
  await applyBulk(ui, "rejected");
  await $("record-list").children[1].firstElementChild.emit("click");
  await ui.buttons.find(button => button.dataset.decision === "follow-up").emit("click");
  assert.equal($("bulk-undo").disabled, true);
});

test("accepted replacements clear transient work; rejected and superseded imports keep it", async () => {
  const ui = app(fixture());
  const { $, fire, paste, pendingFile } = ui;
  await selectRow(ui, 0); await applyBulk(ui, "rejected");
  const transient = () => [$("bulk-count").textContent, $("bulk-undo").disabled, $("bulk-undo").textContent, $("bulk-result").textContent];
  const before = transient();
  for (const [text, format] of [["{bad", "json"], ["id,title\na,A\na,Duplicate", "csv"]]) {
    const stale = pendingFile("file-input");
    await paste(text, format);
    stale.resolve("[]"); await stale.done;
    assert.deepEqual(transient(), before);
  }
  const failure = pendingFile("csv-file-input");
  failure.reject(new Error("read failed")); await failure.done;
  assert.deepEqual(transient(), before);
  await fire("bulk-undo");
  assert.deepEqual(JSON.parse(ui.working().saved), fixture());
  const replacements = [
    () => paste(JSON.stringify(fixture().records)),
    () => paste("id,title\na,Alpha\nb,Beta", "csv"),
    () => paste(R.exportJSON(fixture())),
    () => fire("sample"),
    () => paste("[]"),
    () => paste("id,title", "csv"),
    async () => { const file = pendingFile("csv-file-input"); file.resolve("id,title\na,Alpha"); await file.done; },
  ];
  for (const replace of replacements) {
    await paste(R.exportJSON(fixture()));
    await selectRow(ui, 0); await applyBulk(ui, "rejected");
    assert.equal($("bulk-undo").disabled, false);
    await replace();
    assert.match($("bulk-count").textContent, /0 selected · 0 hidden/);
    assert.equal($("bulk-undo").disabled, true);
    assert.equal($("bulk-result").textContent, "");
    const saved = ui.working().saved;
    await fire("bulk-undo");
    assert.equal(ui.working().saved, saved);
  }
});


async function previewReturned(ui, text) {
  await ui.fire("returned-open");
  ui.$("returned-json").value = text;
  await ui.fire("returned-paste");
}
const returnedSubset = (state = fixture(), patch = { decision: "follow-up", notes: "Returned 雪\n<em>literal</em>" }) =>
  R.exportSelectedJSON(R.updateReview(state, "a", patch), ["a"]);

test("returned preview is distinct, read-only, complete text and preserves hidden selection, export, comparison and undo", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await fire("select-visible"); await applyBulk(ui, "rejected");
  $("search").value = "Beta"; await fire("search", "input");
  await fire("export-selected");
  await fire("compare-open"); await ui.compare(R.exportJSON(fixture()));
  const before = ui.working();
  const comparison = $("compare-list").firstElementChild;
  const undo = $("bulk-undo-status").textContent;
  const incoming = JSON.parse(returnedSubset());
  incoming.records.push({ id: "b", title: "Changed Beta" }, { id: "unknown", title: "<img src=x>" });
  incoming.reviews.b = { decision: "approved", notes: "skip conflict" };
  incoming.reviews.unknown = { decision: "rejected", notes: "skip unknown" };
  await previewReturned(ui, JSON.stringify(incoming));
  assert.deepEqual(ui.working(), before);
  assert.equal($("compare-list").firstElementChild, comparison);
  assert.equal($("bulk-undo-status").textContent, undo);
  assert.equal($("bulk-undo").disabled, false);
  assert.match($("bulk-count").textContent, /2 selected · 1 hidden/);
  assert.match($("returned-counts").textContent, /Eligible updates: 1.*Unchanged reviews: 0.*Unknown IDs \(unapplied\): 1.*Changed-record conflicts \(unapplied\): 1/);
  const rows = $("returned-list").querySelectorAll("details");
  assert.match(rows[0].textContent, /Eligible update/);
  assert.match(rows[1].textContent, /Changed-record conflict/);
  assert.match(rows[2].textContent, /Unknown ID/);
  assert.deepEqual(rows[0].querySelectorAll("pre").map(node => JSON.parse(node.textContent)),
    [fixture().records[0], { decision: "rejected", notes: "keep Alpha" }, incoming.records[0], incoming.reviews.a]);
  assert.match(rows[2].textContent, /<img src=x>/);
  await fire("returned-close");
  assert.deepEqual(ui.working(), before);
  assert.equal($("returned-list").children.length, 0);
  assert.equal($("returned-apply").disabled, true);
  assert.equal($("compare-list").firstElementChild, comparison);
  await fire("bulk-undo");
  assert.deepEqual(JSON.parse(ui.working().saved), fixture());
});

test("returned file applies one eligible batch only, preserves all records and hidden IDs, updates full export and fixed comparison", async () => {
  const initial = R.importJSON(JSON.stringify([...fixture().records,
    { id: "c", title: "Gamma", value: "003" }, { id: "outside", title: "Outside" }]), fixture());
  const ui = app(initial);
  const { $, fire } = ui;
  await fire("select-visible"); await applyBulk(ui, "rejected");
  const current = JSON.parse(ui.working().saved);
  $("search").value = "Outside"; await fire("search", "input");
  await fire("export-selected");
  await fire("compare-open"); await ui.compare(R.exportJSON(current));
  const incoming = R.importJSON(R.exportSelectedJSON(current, ["a", "b", "c"]));
  incoming.reviews.a = { decision: "unreviewed", notes: "" };
  incoming.records[2].value = 3;
  incoming.reviews.c = { decision: "approved", notes: "do not take" };
  incoming.records.push({ id: "unknown", title: "Unknown" });
  incoming.reviews.unknown = { decision: "approved", notes: "do not create" };
  await fire("returned-open");
  const file = ui.pendingFile("returned-file", "teammate-selected.json");
  file.resolve(R.exportJSON(incoming)); await file.done;
  assert.match($("returned-source").textContent, /teammate-selected.json/);
  assert.match($("returned-counts").textContent, /Eligible updates: 1.*Unchanged reviews: 1/);
  assert.match($("returned-list").children[1].textContent, /Unchanged review/);
  const writes = ui.working().writes;
  await fire("returned-apply");
  const expected = R.updateReview(current, "a", incoming.reviews.a);
  assert.equal(ui.working().writes, writes + 1);
  assert.deepEqual(JSON.parse(ui.working().saved), expected);
  assert.deepEqual(JSON.parse(ui.working().saved).records, initial.records);
  assert.match($("bulk-count").textContent, /4 selected · 3 hidden/);
  assert.equal($("search").value, "Outside");
  assert.equal($("record-id").textContent, "outside");
  assert.equal($("export-json").value, "");
  assert.equal($("download").disabled, true);
  assert.match($("export-scope").textContent, /Working data changed/);
  assert.equal($("bulk-undo").disabled, true);
  assert.match($("bulk-undo-status").textContent, /Previous bulk undo cleared.*cannot reverse newer returned-review intent/);
  assert.match($("returned-status").textContent, /Applied 1 review updates in one batch/);
  assert.match($("returned-counts").textContent, /Eligible updates: 0.*Unchanged reviews: 2.*Unknown IDs \(unapplied\): 1.*conflicts \(unapplied\): 1/);
  assert.equal($("returned-apply").disabled, true);
  assert.match($("compare-breakdown").textContent, /decisions: 1, notes: 1/);
  assert.deepEqual(JSON.parse($("compare-list").querySelectorAll("pre")[3].textContent), current.reviews.a);
  await fire("bulk-undo"); await fire("returned-apply");
  assert.equal(ui.working().writes, writes + 1);
  await fire("export-open");
  assert.equal($("export-json").value, R.exportJSON(expected));
  const recipient = app(R.emptyState());
  await recipient.paste($("export-json").value);
  assert.deepEqual(JSON.parse(recipient.working().saved), expected);
  // Reload restores only the existing snapshot format, not returned UI state.
  const reloaded = app(expected);
  await reloaded.fire("returned-apply");
  assert.equal(reloaded.working().writes, 0);
  assert.match(reloaded.$("bulk-count").textContent, /0 selected/);
});

test("notes-only returned intent clears older bulk undo but preview, rejection and no-op do not", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await selectRow(ui, 0); await applyBulk(ui, "rejected");
  const current = JSON.parse(ui.working().saved);
  for (const text of [R.exportJSON(current), R.exportJSON(R.emptyState()),
    R.exportJSON(R.importJSON('[{"id":"x","title":"Unknown"}]')), "[]", "bad JSON"]) {
    const before = ui.working();
    await previewReturned(ui, text);
    assert.equal($("returned-apply").disabled, true);
    await fire("returned-apply");
    assert.deepEqual(ui.working(), before);
    assert.equal($("bulk-undo").disabled, false);
  }
  await previewReturned(ui, returnedSubset(current, { notes: "Only notes changed" }));
  assert.equal($("bulk-undo").disabled, false);
  await fire("returned-apply");
  assert.equal($("bulk-undo").disabled, true);
  const applied = ui.working();
  assert.equal(JSON.parse(applied.saved).reviews.a.decision, "rejected");
  await fire("bulk-undo");
  assert.deepEqual(ui.working(), applied);
  assert.match($("bulk-undo-status").textContent, /cannot reverse newer returned-review intent/);
  // A later ordinary bulk action owns its own decision-only undo as before.
  await applyBulk(ui, "approved"); await fire("bulk-undo");
  assert.deepEqual(JSON.parse(ui.working().saved).reviews.a, { decision: "rejected", notes: "Only notes changed" });
});

test("any later review edit requires refresh then deliberate current Apply, even after repeated edits or revert", async () => {
  for (const change of [
    async ui => { ui.$("notes").value = "Local note"; await ui.fire("notes", "input"); },
    ui => ui.buttons.find(button => button.dataset.decision === "rejected").emit("click"),
    async ui => { await selectRow(ui, 1); await applyBulk(ui, "rejected"); },
    async ui => { await selectRow(ui, 1); await applyBulk(ui, "rejected"); await ui.fire("bulk-undo"); },
    async ui => { ui.$("notes").value = "temporary"; await ui.fire("notes", "input");
      ui.$("notes").value = "keep Alpha"; await ui.fire("notes", "input"); },
  ]) {
    const ui = app(fixture());
    const { $, fire } = ui;
    await previewReturned(ui, returnedSubset());
    await change(ui);
    assert.match($("returned-status").textContent, /changed since preview/);
    const current = ui.working();
    const undo = $("bulk-undo").disabled;
    await fire("export-open");
    await fire("returned-apply");
    assert.equal(ui.working().writes, current.writes);
    assert.equal(ui.working().saved, current.saved);
    assert.equal($("bulk-undo").disabled, undo);
    assert.match($("returned-status").textContent, /Proposal refreshed; nothing applied/);
    const refreshedBefore = JSON.parse($("returned-list").querySelectorAll("pre")[1].textContent);
    assert.deepEqual(refreshedBefore, JSON.parse(current.saved).reviews.a);
    // Another edit invalidates even this refreshed proposal.
    $("notes").value = "Another local note"; await fire("notes", "input");
    const afterEdit = ui.working();
    await fire("returned-apply");
    assert.equal(ui.working().writes, afterEdit.writes);
    await fire("returned-apply");
    assert.equal(ui.working().writes, afterEdit.writes + 1);
    assert.deepEqual(JSON.parse(ui.working().saved).reviews.a, JSON.parse(returnedSubset()).reviews.a);
    assert.deepEqual(JSON.parse(ui.working().saved).reviews.b, JSON.parse(afterEdit.saved).reviews.b);
    assert.equal($("export-json").value, ui.working().saved);
  }
});

test("accepted replacements reclassify returned IDs on Apply; stale conflicts can become eligible without silent writes", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await previewReturned(ui, returnedSubset());
  await ui.paste('[{"id":"a","title":"Changed Alpha"},{"id":"b","title":"Beta"}]');
  const replaced = ui.working();
  await fire("returned-apply");
  assert.deepEqual(ui.working(), replaced);
  assert.match($("returned-counts").textContent, /Eligible updates: 0.*conflicts \(unapplied\): 1/);
  assert.equal($("returned-apply").disabled, true);
  await ui.paste("[]");
  await fire("returned-apply");
  assert.match($("returned-counts").textContent, /Unknown IDs \(unapplied\): 1/);
  await ui.paste(R.exportJSON(fixture()));
  assert.equal($("returned-apply").disabled, false); // Refresh an old zero-eligible proposal.
  const restored = ui.working();
  await fire("returned-apply");
  assert.deepEqual(ui.working(), restored);
  assert.match($("returned-counts").textContent, /Eligible updates: 1/);
  await fire("returned-apply");
  assert.equal(ui.working().writes, restored.writes + 1);
});

test("returned reads are latest-started-wins, isolated from import/comparison and canceled by input edits or close", async () => {
  const ui = app(fixture());
  const { $, fire, pendingFile } = ui;
  await fire("returned-open");
  const older = pendingFile("returned-file", "old.json");
  const newer = pendingFile("returned-file", "new.json");
  newer.resolve(returnedSubset()); await newer.done;
  older.reject(new Error("late error")); await older.done;
  assert.match($("returned-source").textContent, /new.json/);
  assert.equal($("returned-error").textContent, "");
  assert.equal($("returned-file").value, "");
  const stable = ui.working();
  const pending = pendingFile("returned-file");
  await previewReturned(ui, "bad");
  const rejected = $("returned-error").textContent;
  pending.resolve(returnedSubset()); await pending.done;
  assert.equal($("returned-error").textContent, rejected);
  assert.equal($("returned-apply").disabled, true);
  const unreadable = pendingFile("returned-file");
  unreadable.reject(new Error("denied")); await unreadable.done;
  assert.match($("returned-error").textContent, /Could not read/);
  assert.deepEqual(ui.working(), stable);
  for (const close of ["returned-close", "returned-toggle", "returned-panel", "returned-json"]) {
    await fire("returned-open");
    const late = pendingFile("returned-file");
    if (close === "returned-panel") { $(close).open = false; await fire(close, "toggle"); }
    else if (close === "returned-json") { $(close).value = "changed input"; await fire(close, "input"); }
    else await fire(close);
    late.resolve(returnedSubset()); await late.done;
    assert.equal($("returned-apply").disabled, true);
    assert.equal($("returned-results").hidden, true);
    assert.deepEqual(ui.working(), stable);
  }
  await fire("returned-open"); await fire("compare-open");
  const returned = pendingFile("returned-file");
  const compared = pendingFile("compare-file");
  await ui.paste(R.exportJSON(fixture()));
  compared.resolve(R.exportJSON(R.emptyState())); await compared.done;
  returned.resolve(returnedSubset()); await returned.done;
  assert.match($("compare-status").textContent, /Compared: 0/);
  const writes = ui.working().writes;
  await fire("returned-apply"); // Preview was built from state at file completion, not start.
  assert.equal(ui.working().writes, writes + 1);
});

test("filters, selection, failed imports and comparison do not stale returned preview; note-exit edits do", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await previewReturned(ui, returnedSubset());
  await selectRow(ui, 0);
  $("search").value = "Beta"; await fire("search", "input");
  await ui.paste("bad");
  await fire("compare-open"); await ui.compare(R.exportJSON(fixture()));
  await fire("returned-apply");
  assert.match($("returned-status").textContent, /Applied 1/);
  assert.match($("bulk-count").textContent, /1 selected · 1 hidden/);
  $("search").value = "keep"; await fire("search", "input"); // b editor
  await previewReturned(ui, R.exportSelectedJSON(R.updateReview(fixture(), "b", { notes: "Returned Beta" }), ["b"]));
  $("notes").focus(); $("notes").value = "No longer matching"; await fire("notes", "input");
  const writes = ui.working().writes;
  await ui.activate("returned-apply"); // Shared note-exit capture, not replayed clicks.
  assert.equal(ui.working().writes, writes);
  assert.match($("returned-status").textContent, /Proposal refreshed/);
  assert.equal(JSON.parse(ui.working().saved).reviews.b.notes, "No longer matching");
  await ui.activate("returned-apply");
  assert.equal(ui.working().writes, writes + 1);
  assert.equal(JSON.parse(ui.working().saved).reviews.b.notes, "Returned Beta");
});


test("returned Undo restores actual batch once, preserves hidden selection/comparison and invalidates prepared export", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  assert.equal($("returned-undo").disabled, true);
  await fire("select-visible"); await applyBulk(ui, "rejected");
  const before = ui.working().saved; // Actual pre-apply state includes prior bulk intent.
  await fire("compare-open"); await ui.compare(before);
  $("search").value = "Beta"; await fire("search", "input");
  $("filter").value = "rejected"; await fire("filter", "change");
  await previewReturned(ui, returnedSubset(JSON.parse(before), { decision: "unreviewed", notes: "" }));
  await fire("returned-apply");
  assert.equal($("returned-undo").disabled, false);
  assert.equal($("bulk-undo").disabled, true);
  assert.match($("compare-breakdown").textContent, /decisions: 1, notes: 1/);
  await fire("export-selected");
  assert.equal($("download").disabled, false);
  const writes = ui.working().writes;
  $("notes").focus();
  await ui.activate("returned-undo"); // Uses the existing note-exit path.
  assert.equal(ui.working().writes, writes + 1);
  assert.equal(ui.working().saved, before);
  assert.equal($("notes").value, "keep Beta");
  assert.equal($("record-id").textContent, "b");
  assert.equal($("search").value, "Beta");
  assert.equal($("filter").value, "rejected");
  assert.match($("bulk-count").textContent, /2 selected · 1 hidden/);
  assert.equal($("compare-empty").hidden, false);
  assert.match($("compare-breakdown").textContent, /decisions: 0, notes: 0/);
  assert.equal($("export-json").value, "");
  assert.equal($("download").disabled, true);
  assert.equal($("returned-undo").disabled, true);
  assert.match($("returned-undo-status").textContent, /Restored the exact prior decisions and notes/);
  assert.equal($("bulk-undo").disabled, true); // Never resurrect an older bulk entry.
  await fire("bulk-undo"); await fire("returned-undo");
  assert.equal(ui.working().writes, writes + 1);
  await fire("export-open"); assert.equal($("export-json").value, before);
  await fire("export-selected"); assert.equal($("export-json").value, before);
  // The retained returned proposal needs refresh, not silent reapply/redo.
  await fire("returned-apply");
  assert.equal(ui.working().writes, writes + 1);
  assert.match($("returned-status").textContent, /Proposal refreshed; nothing applied/);
  await fire("returned-apply");
  assert.equal($("returned-undo").disabled, false);
});

test("returned recovery is only the newest actual batch, including notes-only batches", async () => {
  const ui = app(fixture());
  await previewReturned(ui, returnedSubset()); await ui.fire("returned-apply");
  const first = ui.working().saved;
  await previewReturned(ui, returnedSubset(JSON.parse(first), { notes: "Second notes only\r\n雪" }));
  await ui.fire("returned-apply");
  assert.equal(JSON.parse(ui.working().saved).reviews.a.decision, "follow-up");
  await ui.fire("returned-undo");
  assert.equal(ui.working().saved, first);
  const writes = ui.working().writes;
  await ui.fire("returned-undo");
  assert.equal(ui.working().writes, writes);
  assert.notEqual(ui.working().saved, R.exportJSON(fixture()));
  const reloaded = app(JSON.parse(first));
  assert.equal(reloaded.$("returned-undo").disabled, true);
  await reloaded.fire("returned-undo"); assert.equal(reloaded.working().writes, 0);
});

test("newer edits or accepted replacements invalidate returned recovery even when later reverted", async () => {
  const mutations = [
    async ui => { ui.$("notes").value = "Newer notes"; await ui.fire("notes", "input"); },
    async ui => { await ui.$("record-list").children[1].firstElementChild.emit("click");
      ui.$("notes").value = "Unrelated newer notes"; await ui.fire("notes", "input"); },
    ui => ui.buttons.find(button => button.dataset.decision === "approved").emit("click"),
    async ui => { await selectRow(ui, 1); await applyBulk(ui, "rejected"); },
    async ui => { await selectRow(ui, 1); await applyBulk(ui, "rejected"); await ui.fire("bulk-undo"); },
    async ui => { const old = ui.$("notes").value; ui.$("notes").value = "temporary";
      await ui.fire("notes", "input"); ui.$("notes").value = old; await ui.fire("notes", "input"); },
    ui => ui.paste(ui.working().saved), // Equal saved-snapshot replacement still invalidates.
    ui => ui.paste(JSON.stringify(JSON.parse(ui.working().saved).records)),
    ui => ui.paste("id,title\na,Alpha\nb,Beta", "csv"),
    ui => ui.paste("[]"), ui => ui.paste("id,title", "csv"), ui => ui.fire("sample"),
    async ui => { const file = ui.pendingFile("file-input"); file.resolve(ui.working().saved); await file.done; },
    async ui => { const file = ui.pendingFile("csv-file-input"); file.resolve("id,title\na,Alpha"); await file.done; },
  ];
  for (const mutate of mutations) {
    const ui = app(fixture());
    await previewReturned(ui, returnedSubset()); await ui.fire("returned-apply");
    await mutate(ui);
    assert.equal(ui.$("returned-undo").disabled, true);
    assert.match(ui.$("returned-undo-status").textContent, /cleared because working data or reviews changed/);
    const stable = ui.working();
    await ui.fire("returned-undo");
    assert.deepEqual(ui.working(), stable);
  }
});

test("rejected/no-effect operations and stale refresh preserve returned recovery without changing scalar contracts", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await previewReturned(ui, returnedSubset()); await fire("returned-apply");
  const after = ui.working().saved;
  for (const text of [after, R.exportJSON(R.emptyState()),
    R.exportJSON(R.importJSON('[{"id":"unknown","title":"Unknown"}]')),
    R.exportJSON(R.importJSON('[{"id":"a","title":"Conflict"}]')), "[]", "bad JSON"]) {
    await previewReturned(ui, text); await fire("returned-apply");
    assert.equal(ui.working().saved, after);
    assert.equal($("returned-undo").disabled, false);
  }
  for (const [text, format] of [["{bad", "json"], ["id,title\na,One\na,Duplicate", "csv"]]) {
    const stale = ui.pendingFile("file-input");
    await ui.paste(text, format); stale.resolve("[]"); await stale.done;
    assert.equal($("returned-undo").disabled, false);
  }
  for (const id of ["file-input", "csv-file-input", "returned-file"]) {
    const failed = ui.pendingFile(id); failed.reject(new Error("unreadable")); await failed.done;
    assert.equal($("returned-undo").disabled, false);
  }
  await previewReturned(ui, returnedSubset());
  await ui.buttons.find(button => button.dataset.decision === "follow-up").emit("click");
  await fire("notes", "input"); // Exact same note: keep recovery, retain scalar saves/freshness.
  assert.equal($("returned-undo").disabled, false);
  assert.match($("returned-status").textContent, /changed since preview/);
  const writes = ui.working().writes;
  await fire("returned-apply");
  assert.equal(ui.working().writes, writes);
  assert.match($("returned-status").textContent, /Proposal refreshed; nothing applied/);
  await fire("bulk-apply"); // Empty selection.
  await selectRow(ui, 0); await applyBulk(ui, "follow-up"); // Same decision.
  assert.equal(ui.working().writes, writes);
  assert.equal($("returned-undo").disabled, false);
  assert.equal($("bulk-undo").disabled, true);
  await fire("returned-undo");
  assert.equal(ui.working().saved, R.exportJSON(fixture()));
});

test("view-only changes, preview closure and comparison/export actions preserve returned recovery", async () => {
  const ui = app(fixture());
  const { $, fire } = ui;
  await previewReturned(ui, returnedSubset()); await fire("returned-apply");
  const after = ui.working().saved, writes = ui.working().writes;
  await fire("select-visible");
  $("search").value = "Beta"; await fire("search", "input");
  $("filter").value = "approved"; await fire("filter", "change");
  await fire("export-selected"); await fire("export-open");
  await fire("compare-open"); await ui.compare(R.exportJSON(fixture()));
  await ui.compare("invalid"); await fire("compare-close");
  await fire("compare-open"); await ui.compare(after);
  await fire("returned-close"); await fire("returned-open");
  $("returned-json").value = "edited"; await fire("returned-json", "input");
  const pending = ui.pendingFile("returned-file");
  await fire("returned-close"); pending.resolve(returnedSubset()); await pending.done;
  await fire("clear-selection"); await fire("select-visible");
  assert.equal(ui.working().saved, after);
  assert.equal(ui.working().writes, writes);
  assert.equal($("returned-undo").disabled, false);
  await fire("returned-open"); await fire("returned-undo");
  assert.equal(ui.working().saved, R.exportJSON(fixture()));
  assert.match($("bulk-count").textContent, /1 selected/);
  assert.equal($("search").value, "Beta");
  assert.equal($("filter").value, "approved");
  assert.match($("compare-breakdown").textContent, /decisions: 1, notes: 1/);
  const comparedReview = JSON.parse($("compare-list").querySelectorAll("pre")[3].textContent);
  assert.deepEqual(comparedReview, JSON.parse(after).reviews.a);
});

test("returned recovery never revives after later bulk undo and bulk undo still keeps newer notes", async () => {
  const ui = app(fixture());
  await selectRow(ui, 0); await applyBulk(ui, "rejected");
  const before = ui.working().saved;
  await previewReturned(ui, returnedSubset(JSON.parse(before), { notes: "Returned notes only" }));
  await ui.fire("returned-apply"); await ui.fire("returned-undo");
  assert.equal(ui.working().saved, before);
  assert.equal(ui.$("bulk-undo").disabled, true);
  await previewReturned(ui, returnedSubset()); await ui.fire("returned-apply");
  await applyBulk(ui, "approved");
  ui.$("notes").value = "Later note retained by bulk undo"; await ui.fire("notes", "input");
  assert.equal(ui.$("returned-undo").disabled, true);
  assert.equal(ui.$("bulk-undo").disabled, false);
  await ui.fire("bulk-undo");
  assert.deepEqual(JSON.parse(ui.working().saved).reviews.a,
    { decision: "follow-up", notes: "Later note retained by bulk undo" });
  const stable = ui.working(); await ui.fire("returned-undo");
  assert.deepEqual(ui.working(), stable);
});
