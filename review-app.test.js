"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const R = require("./review-state.js");

// Small adapter harness, not a browser substitute. It runs the actual app and
// records editor writes/storage effects while controlling asynchronous reads.
function app(initial) {
  let document;
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
  }
  const template = fs.readFileSync(path.join(__dirname, "review-template.html"), "utf8");
  const nodes = new Map([...template.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, new Element(tag)]));
  const $ = id => { assert.ok(nodes.has(id), "Unknown template ID: " + id); return nodes.get(id); };
  const buttons = R.DECISIONS.map(decision => { const node = new Element("button"); node.dataset.decision = decision; return node; });
  document = { getElementById: $, createElement: tag => new Element(tag),
    querySelectorAll: selector => { assert.equal(selector, "[data-decision]"); return buttons; }, addEventListener() {} };
  $("empty").append(new Element("h2"), new Element("p"));
  $("filter").value = "all";
  $("paste-format").value = "json";
  let saved = R.exportJSON(initial);
  let writes = 0;
  const storage = { getItem: () => saved, setItem: (key, value) => { assert.equal(key, R.STORAGE_KEY); writes++; saved = value; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "review-app.js"), "utf8"), {
    RecordReview: R, document, window: { localStorage: storage },
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
  return { $, fire, compare, paste, pendingFile, working, document, buttons };
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
