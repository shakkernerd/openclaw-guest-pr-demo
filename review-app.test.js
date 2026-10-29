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
  let saved = R.exportJSON(initial);
  let writes = 0;
  const storage = { getItem: () => saved, setItem: (key, value) => { assert.equal(key, R.STORAGE_KEY); writes++; saved = value; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "review-app.js"), "utf8"), {
    RecordReview: R, document, window: { localStorage: storage },
  });
  const fire = (id, type = "click") => $(id).emit(type);
  const compare = async text => { $("compare-json").value = text; await fire("compare-paste"); };
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
  return { $, fire, compare, pendingFile, working, document, buttons };
}

const fixture = () => R.importJSON(JSON.stringify({ format: R.FORMAT, version: R.VERSION,
  records: [{ id: "a", title: "Alpha", extra: { a: 1, b: 2 } }, { id: "b", title: "Beta" }],
  reviews: { a: { decision: "approved", notes: "keep Alpha" }, b: { decision: "approved", notes: "keep Beta" } },
}));

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
  $("paste-json").value = "[]"; await fire("import-paste");
  currentRead.resolve(original); await currentRead.done;
  assert.match($("compare-status").textContent, /Current: 0 records · Compared: 2 · Added: 2/);
  $("paste-json").value = original; await fire("import-paste");
  assert.equal($("compare-empty").hidden, false);
});
