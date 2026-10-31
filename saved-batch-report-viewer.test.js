"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { resolveObjectURL } = require("node:buffer");
const vm = require("node:vm");
const source = (file) => readFileSync(join(__dirname, file), "utf8");
const settle = () => new Promise(setImmediate);

// A bounded DOM double, following the existing editor-test approach. It runs
// the real HTML entry's scripts, not a second controller or exported UI seam.
// It does not prove browser layout, native keyboard activation or downloads.
class Element {
  constructor(tag, document) {
    Object.assign(this, { tagName: tag.toUpperCase(), document, children: [],
      attributes: {}, dataset: {}, listeners: {}, value: "", textContent: "",
      hidden: false, disabled: false, clicks: 0 });
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === "id") this.id = value;
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
  }
  removeAttribute(name) { delete this.attributes[name]; if (name === "href") this.href = ""; }
  append(...children) {
    for (const child of children) {
      if (child.tagName === "FRAGMENT") { this.append(...child.children); continue; }
      const last = this.children.at(-1);
      if (last) last.nextElementSibling = child;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  get selectedIndex() { return this.options.findIndex((option) => option.value === this.value); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  emit(type) { for (const listener of this.listeners[type] || []) listener(); }
  click() { if (!this.disabled) { this.clicks += 1; this.emit("click"); } }
  focus() { this.document.activeElement = this; }
}

function loadPage(t) {
  const html = source("saved-batch-report.html");
  const nodes = new Map();
  const document = {
    createElement: (tag) => new Element(tag, document),
    createDocumentFragment: () => new Element("fragment", document),
    getElementById: (id) => nodes.get(id) || null,
  };
  // Scan only the static attributes/options and adjacent empty-value annotations
  // this entry uses. This is deliberately not a general HTML parser.
  let previous;
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const node = document.createElement(match[1]);
    for (const [, name, value] of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      node.setAttribute(name, value ?? "");
    }
    if (node.id) { assert.equal(nodes.has(node.id), false); nodes.set(node.id, node); }
    if (previous?.tagName === "PRE") previous.nextElementSibling = node;
    previous = node;
  }
  const get = document.getElementById;
  get("report-filter").options = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .map(([, value, textContent]) => ({ value, textContent }));
  const window = new Element("window", document);
  const urls = { created: [], revoked: [], fail: false };
  const urlApi = {
    createObjectURL(blob) {
      if (urls.fail) throw new Error("controlled download failure");
      const url = URL.createObjectURL(blob); urls.created.push(url); return url;
    },
    revokeObjectURL(url) { urls.revoked.push(url); URL.revokeObjectURL(url); },
  };
  const context = vm.createContext({ document, window, TextDecoder, Blob, URL: urlApi });
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)];
  assert.deepEqual(scripts.map((match) => match[1]), ["saved-batch-report.js", "saved-batch-report-viewer.js"]);
  for (const [, file] of scripts) vm.runInContext(source(file), context, { filename: file });
  t.after(() => window.emit("pagehide"));
  return { html, document, window, get, urls,
    select(file) {
      get("report-file").files = file ? [file] : [];
      get("report-file").emit("change");
      assert.equal(get("report-file").value, "", "same file can be selected again");
      return settle();
    },
    query(value) { get("report-query").value = value; get("report-query").emit("input"); },
    filter(value) { get("report-filter").value = value; get("report-filter").emit("change"); },
    rows: () => get("report-rows").children,
    positions: () => get("report-rows").children.map((row) => row.value),
  };
}

const report = { total: 3, succeeded: 1, failed: 2, results: [
  { position: 1, file: "Parcel[1].JSON", ok: true, formatted: "<TAG> saved A+B." },
  { position: 2, file: "other.json", ok: false, error: { stage: "read", name: "Error", message: "DENIED" } },
  { position: 3, file: "Parcel[1].JSON", ok: false, error: { stage: "format", name: "RangeError", message: "line[1] is empty" } },
] };
const zero = { total: 0, succeeded: 0, failed: 0, results: [] };
const file = (value = report, name = "report.json") => new File([JSON.stringify(value)], name);
const csvHeader = '"position","file","status","formatted","error_stage","error_name","error_message"\r\n';
const expectedCsv = csvHeader +
  '"1","Parcel[1].JSON","success","<TAG> saved A+B.","","",""\r\n' +
  '"2","other.json","failure","","read","Error","DENIED"\r\n' +
  '"3","Parcel[1].JSON","failure","","format","RangeError","line[1] is empty"\r\n';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { file: { name: "pending.json", arrayBuffer: () => promise }, resolve, reject };
}

test("entry search, outcome intersection, count, empty states and native clear-button wiring", async (t) => {
  const page = loadPage(t);
  const query = page.get("report-query");
  const clear = page.get("clear-query");
  assert.match(page.html, /<label for="report-query">Search occurrences<\/label>/);
  assert.equal(query.attributes.type, "search");
  assert.equal(query.attributes["aria-describedby"], "search-help");
  assert.equal(clear.tagName, "BUTTON");
  assert.equal(clear.attributes.type, "button");
  assert.equal(clear.disabled, true);
  assert.equal(page.get("visible-count").attributes["aria-live"], "polite");
  page.query("pArCeL[1]");
  assert.match(page.get("empty-state").textContent, /No accepted report/);
  await page.select(file());
  assert.deepEqual(page.positions(), [1, 3]);
  assert.equal(page.get("visible-count").textContent, 'Visible occurrences: 2 of 3 (All; search: "pArCeL[1]").');
  page.filter("failure");
  assert.deepEqual(page.positions(), [3]);
  page.query("denied");
  assert.deepEqual(page.positions(), [2]);
  page.query("rangeERROR");
  assert.deepEqual(page.positions(), [3]);
  page.filter("success");
  page.query("<tag>");
  assert.deepEqual(page.positions(), [1]);
  const output = page.rows()[0].children[1].children[3].children[0];
  assert.equal(output.textContent, "<TAG> saved A+B.");
  assert.equal(output.children.length, 0, "saved markup stays text");
  page.query(".*");
  assert.deepEqual(page.positions(), []);
  assert.equal(page.get("empty-state").hidden, false);
  assert.match(page.get("empty-state").textContent, /search and outcome filter.*Clear the search or choose All/);
  clear.click();
  assert.equal(query.value, "");
  assert.equal(page.document.activeElement, query);
  assert.equal(clear.disabled, true);
  assert.equal(page.get("report-filter").value, "success");
  assert.deepEqual(page.positions(), [1]);
  page.filter("decode");
  assert.match(page.get("empty-state").textContent, /No occurrences match this outcome filter/);
  page.query("kept");
  await page.select(file(zero));
  assert.equal(query.value, "kept");
  assert.equal(page.get("report-filter").value, "decode");
  assert.match(page.get("empty-state").textContent, /Accepted report is empty/);
  assert.match(page.get("visible-count").textContent, /0 of 0/);
});

test("search preserves full CSV retry and row nodes through read lifecycle; acceptance clears only export", async (t) => {
  const page = loadPage(t);
  let reads = 0;
  const input = file();
  await page.select({ name: input.name, arrayBuffer() { reads += 1; return input.arrayBuffer(); } });
  page.query("pArCeL[1]");
  page.filter("format");
  assert.deepEqual(page.positions(), [3]);
  page.get("export-report").click();
  const download = page.get("download-report");
  const url = download.href;
  assert.deepEqual(Buffer.from(await resolveObjectURL(url).arrayBuffer()), Buffer.from(expectedCsv));
  assert.equal(download.clicks, 1);
  page.query("no matches");
  assert.deepEqual(page.positions(), []);
  download.click();
  assert.equal(download.clicks, 2);
  assert.equal(download.href, url);
  assert.equal(page.get("export-status").textContent.startsWith("CSV snapshot ready: 3 occurrences."), true);
  page.query("pArCeL[1]");
  const row = page.rows()[0];
  const pending = deferred();
  await page.select(pending.file);
  assert.equal(page.get("read-status").dataset.state, "reading");
  assert.equal(page.rows()[0], row);
  pending.reject(new Error("controlled read failure"));
  await settle();
  assert.equal(page.get("read-status").dataset.state, "read-error");
  await page.select(new File(["invalid"], "invalid.json"));
  assert.equal(page.get("read-status").dataset.state, "invalid");
  page.get("report-file").emit("cancel");
  assert.equal(page.get("read-status").dataset.state, "empty");
  await page.select(null);
  assert.equal(page.rows()[0], row);
  assert.equal(page.get("report-query").value, "pArCeL[1]");
  assert.equal(page.get("report-filter").value, "format");
  assert.equal(download.href, url);
  assert.deepEqual(page.urls.revoked, []);
  assert.equal(reads, 1, "search/export/retry never rereads accepted input");
  assert.equal(await resolveObjectURL(url).text(), expectedCsv);
  const old = deferred();
  await page.select(old.file);
  page.query("line[1]");
  assert.deepEqual(page.positions(), [3], "search remains usable during a read");
  assert.equal(download.href, url);
  await page.select(file(report, "replacement.json"));
  assert.equal(page.get("accepted-name").textContent, "replacement.json");
  assert.equal(page.get("report-query").value, "line[1]");
  assert.equal(page.get("report-filter").value, "format");
  assert.deepEqual(page.positions(), [3]);
  assert.deepEqual(page.urls.revoked, [url]);
  assert.equal(download.hidden, true);
  assert.equal(resolveObjectURL(url), undefined);
  old.resolve(Buffer.from(JSON.stringify(zero)));
  await settle();
  assert.deepEqual(page.positions(), [3]);
  assert.equal(page.get("read-status").dataset.state, "accepted");
  page.get("export-report").click();
  const replacementUrl = download.href;
  page.get("export-report").click();
  assert.equal(resolveObjectURL(replacementUrl), undefined, "re-export releases its predecessor");
  const lastUrl = download.href;
  const late = deferred();
  await page.select(late.file);
  page.window.emit("pagehide");
  assert.equal(resolveObjectURL(lastUrl), undefined);
  assert.equal(download.hidden, true);
  late.resolve(Buffer.from(JSON.stringify(zero)));
  await settle();
  assert.equal(page.get("read-status").dataset.state, "empty");
  assert.deepEqual(page.positions(), [3]);
});

test("download failure can retry under search; zero export and lossless refusal remain unchanged", async (t) => {
  const page = loadPage(t);
  await page.select(file());
  page.query("no matches");
  page.urls.fail = true;
  page.get("export-report").click();
  assert.equal(page.get("export-status").dataset.state, "error");
  assert.equal(page.get("download-report").hidden, true);
  page.urls.fail = false;
  page.get("export-report").click();
  assert.equal(await resolveObjectURL(page.get("download-report").href).text(), expectedCsv);
  await page.select(file(zero));
  page.get("export-report").click();
  assert.equal(await resolveObjectURL(page.get("download-report").href).text(), csvHeader);
  const unpaired = { total: 1, succeeded: 1, failed: 0,
    results: [{ position: 1, file: "hidden.json", ok: true, formatted: "\ud800" }] };
  await page.select(file(unpaired));
  page.get("export-report").click();
  assert.match(page.get("export-status").textContent, /unpaired UTF-16 surrogate/);
  assert.equal(page.get("download-report").hidden, true);
  assert.equal(page.get("read-status").dataset.state, "accepted");
  assert.equal(page.get("report-query").value, "no matches");
});
