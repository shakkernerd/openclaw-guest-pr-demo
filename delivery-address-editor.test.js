"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const owner = require("./delivery-address.js");
const source = (file) => readFileSync(join(__dirname, file), "utf8");

// Only the DOM operations used by the entry script. No browser/layout claims:
// values here represent strings already exposed by a browser's textarea API.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.textContent = "";
    this.value = "";
    this.hidden = false;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === "id") this.id = value;
    if (name === "hidden") this.hidden = true;
    if (name === "readonly") this.readOnly = true;
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [
      ...(child.tagName === tag.toUpperCase() ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  emit(type) {
    for (const listener of this.listeners[type] || []) listener();
    if (this.parent) this.parent.emit(type);
  }
  click() { this.emit("click"); }
  focus() { this.document.activeElement = this; }
}

function loadPage() {
  const html = source("delivery-address.html");
  const nodes = new Map();
  const document = {
    createElement: (tag) => new Element(tag, document),
    getElementById: (id) => nodes.get(id) || null,
  };
  // Discover static entry nodes/attributes, rather than inventing a test entry.
  // This deliberately small scanner is not an HTML parser or a browser.
  for (const [, tag, attributes] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const node = document.createElement(tag);
    for (const [, name, value] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      node.setAttribute(name, value ?? "");
    }
    if (node.id) {
      assert.equal(nodes.has(node.id), false, "unique entry IDs");
      nodes.set(node.id, node);
    }
  }
  const context = vm.createContext({ document });
  const scripts = [...html.matchAll(/<script\b([^>]*)><\/script>/g)];
  for (const [, attrs] of scripts) {
    const file = /src="([^"]+)"/.exec(attrs)[1];
    vm.runInContext(source(file), context, { filename: file });
  }
  const get = document.getElementById;
  return { document, get,
    rows: () => get("address-lines").children,
    inputs: () => get("address-lines").querySelectorAll("textarea"),
    values: () => get("address-lines").querySelectorAll("textarea").map((node) => node.value),
    add: () => get("add-line").click(),
    format: () => get("format-address").click(),
    remove: (index) => get("address-lines").children[index].querySelector("button").click(),
    edit(index, value) {
      const input = this.inputs()[index];
      input.value = value;
      input.emit("input");
    },
  };
}

function assertCleared(page) {
  assert.equal(page.get("formatted-address").value, "");
  assert.equal(page.get("formatted-address").hidden, true);
}

function assertLabels(page) {
  page.rows().forEach((row, index) => {
    const input = row.querySelector("textarea");
    assert.equal(row.querySelector("label").htmlFor, input.id);
    assert.equal(row.querySelector("label").textContent, "Line " + (index + 1));
    assert.equal(row.querySelector("button").attributes["aria-label"], "Remove line " + (index + 1));
  });
  assert.equal(new Set(page.inputs().map((input) => input.id)).size, page.inputs().length);
}

const separators = ["\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029", "\r\n"];

test("browser exposure uses the unchanged CommonJS owner contract", () => {
  assert.deepEqual(Object.keys(owner), ["formatDeliveryAddress"]);
  assert.equal(Object.hasOwn(globalThis, "formatDeliveryAddress"), false);
  const context = vm.createContext({});
  vm.runInContext(source("delivery-address.js"), context);
  const browser = context.formatDeliveryAddress;
  const outcome = (formatter, value) => {
    try { return { value: formatter(value) }; }
    catch (error) { return { name: error.name, message: error.message }; }
  };
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: "Synthetic" }));
  const cases = [
    Object.freeze(["  Zoe\u0308 李 📦  ", "\tشارع النيل\u00a0", "Straße 5", "Straße 5"]),
    ["<synthetic> & Co."], ["One incomplete line"], [], undefined, null, "text",
    {}, [1], [null], new Array(1), inherited, [""], [" \t\u3000"],
    ...separators.map((separator) => ["Synthetic" + separator + "line"]),
  ];
  for (const value of cases) {
    assert.deepEqual(outcome(browser, value), outcome(owner.formatDeliveryAddress, value));
  }
});

test("real entry boots one labelled empty textarea without formatting", () => {
  const page = loadPage();
  assert.deepEqual(page.values(), [""]);
  assertCleared(page);
  assertLabels(page);
  assert.equal(page.get("address-lines").tagName, "OL");
  assert.equal(page.get("formatted-address").tagName, "TEXTAREA");
  assert.equal(page.get("formatted-address").readOnly, true);
  assert.equal(page.get("address-status").attributes.role, "status");
  assert.equal(page.get("address-status").attributes["aria-live"], "polite");
});

test("explicit format preserves exact strings, Unicode, whitespace, duplicates and order as text", () => {
  const page = loadPage();
  const values = ["  Zoe\u0308 李 📦  ", "\tشارع النيل\u00a0", "<img src=x onerror=bad()> & Co.", "duplicate", "duplicate"];
  values.forEach((value, index) => { if (index) page.add(); page.edit(index, value); });
  const inputs = page.inputs();
  assertCleared(page);
  page.format();
  assert.deepEqual(page.inputs(), inputs);
  assert.deepEqual(page.values(), values);
  const expected = "  Zoe\u0308 李 📦  \n\tشارع النيل\u00a0\n<img src=x onerror=bad()> & Co.\nduplicate\nduplicate";
  const output = page.get("formatted-address");
  assert.equal(output.value, expected);
  assert.deepEqual(Buffer.from(output.value), Buffer.from(expected));
  assert.equal(output.children.length, 0);
  assert.equal(output.hidden, false);
  assert.equal(page.get("address-status").dataset.state, "success");
});

test("one line is accepted; editing clears stale output without validation or control replacement", () => {
  const page = loadPage();
  page.edit(0, "One incomplete line");
  page.format();
  assert.equal(page.get("formatted-address").value, "One incomplete line");
  const input = page.inputs()[0];
  input.focus();
  for (const value of ["Changed", "Still\nmultiline", ""]) {
    page.edit(0, value);
    assertCleared(page);
    assert.equal(page.get("address-status").textContent, "Draft not formatted.");
    assert.equal(page.inputs()[0], input);
    assert.equal(page.document.activeElement, input);
    assert.equal(input.value, value);
  }
});

test("add/remove invalidate stale output and preserve other controls, values, order and useful focus", () => {
  const page = loadPage();
  for (const [index, value] of ["First", "Middle", "Last"].entries()) {
    if (index) page.add();
    page.edit(index, value);
  }
  const [first, middle, last] = page.inputs();
  page.format();
  page.add();
  assertCleared(page);
  assert.deepEqual(page.inputs().slice(0, 3), [first, middle, last]);
  assert.deepEqual(page.values(), ["First", "Middle", "Last", ""]);
  assert.equal(page.document.activeElement, page.inputs()[3]);
  page.edit(3, "Added");
  const added = page.inputs()[3];
  page.format();
  page.remove(1);
  assertCleared(page);
  assert.deepEqual(page.inputs(), [first, last, added]);
  assert.deepEqual(page.values(), ["First", "Last", "Added"]);
  assert.equal(page.document.activeElement, last);
  assertLabels(page);
  page.format();
  assert.equal(page.get("formatted-address").value, "First\nLast\nAdded");
  page.remove(2);
  assertCleared(page);
  assert.equal(page.document.activeElement, last);
  page.remove(0);
  assert.equal(page.document.activeElement, last);
  page.remove(0);
  assert.equal(page.document.activeElement, page.get("add-line"));
  assert.deepEqual(page.values(), []);
  page.format();
  assert.equal(page.get("address-status").textContent, "Could not format: lines must not be empty");
  assertCleared(page);
  page.add();
  assertLabels(page);
  assert.deepEqual(page.values(), [""]);
});

test("canonical blank/multiline errors preserve every draft and clear obsolete errors on every mutation", () => {
  const page = loadPage();
  page.edit(0, "Untouched synthetic line");
  page.add();
  const inputs = page.inputs();
  const invalid = [
    { value: " \t\u3000", message: "Could not format: lines[1] must not be blank" },
    { value: "Before\nAfter", message: "Could not format: lines[1] must not contain line breaks" },
  ];
  for (const { value, message } of invalid) {
    page.edit(1, value);
    const before = page.values();
    page.format();
    assert.equal(page.get("address-status").textContent, message);
    assert.equal(page.get("address-status").dataset.state, "error");
    assert.deepEqual(page.values(), before);
    assert.deepEqual(page.inputs(), inputs);
    assertCleared(page);
    page.edit(1, value + " edited");
    assert.equal(page.get("address-status").textContent, "Draft not formatted.");
  }
  page.format();
  page.add();
  assert.equal(page.get("address-status").textContent, "Draft not formatted.");
  page.format();
  page.remove(1);
  assert.equal(page.get("address-status").textContent, "Draft not formatted.");
  assert.deepEqual(page.values(), ["Untouched synthetic line", ""]);
  assertCleared(page);
});
