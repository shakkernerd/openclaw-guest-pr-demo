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
    this.disabled = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = "none";
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
  insertBefore(child, reference) {
    assert.ok(reference === null || this.children.includes(reference));
    if (child === reference) return child;
    if (child.parent) child.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
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
  emit(type, event) {
    for (const listener of this.listeners[type] || []) listener(event);
    if (this.parent) this.parent.emit(type, event);
  }
  click() { if (!this.disabled) this.emit("click"); }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end, direction) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
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
    button: (index, text) => get("address-lines").children[index]
      .querySelectorAll("button").find((button) => button.textContent === text),
    remove(index) { this.button(index, "Remove").click(); },
    move(index, direction) { this.button(index, "Move " + direction).click(); },
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
    assert.equal(page.button(index, "Remove").attributes["aria-label"], "Remove line " + (index + 1));
    for (const direction of ["up", "down"]) {
      const button = page.button(index, "Move " + direction);
      assert.equal(button.type, "button");
      assert.equal(button.attributes["aria-label"], "Move line " + (index + 1) + " " + direction);
      assert.equal(button.disabled, direction === "up" ? index === 0 : index === page.rows().length - 1);
    }
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
  assertLabels(page);
  page.remove(0);
  assert.equal(page.document.activeElement, last);
  assertLabels(page);
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

// Selection/focus assertions below describe this test double, not native-browser proof.
function draftSnapshot(page) {
  return page.inputs().map((input) => ({
    input, id: input.id, value: input.value,
    start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
  }));
}

function assertNodeOrder(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((node, index) => assert.equal(node, expected[index]));
}

function assertSnapshot(page, expected) {
  assertNodeOrder(page.inputs(), expected.map(({ input }) => input));
  assert.deepEqual(draftSnapshot(page), expected);
}

function assertDraft(page) {
  assertCleared(page);
  assert.equal(page.get("address-status").textContent, "Draft not formatted.");
  assert.equal(page.get("address-status").dataset.state, "draft");
}

test("moves relocate only existing rows, preserve raw drafts/selections, and format only on request", () => {
  const page = loadPage();
  const values = ["  Zoe\u0308 李 📦  ", "\tشارع النيل\u00a0", "<recipient> & Co.", "duplicate", "duplicate"];
  values.forEach((value, index) => { if (index) page.add(); page.edit(index, value); });
  const rows = [...page.rows()];
  const inputs = page.inputs();
  inputs.forEach((input, index) => input.setSelectionRange(index, index + 2, index % 2 ? "backward" : "forward"));
  const before = draftSnapshot(page);
  page.format();
  page.move(0, "down");
  assertNodeOrder([...page.rows()], [rows[1], rows[0], rows[2], rows[3], rows[4]]);
  assertSnapshot(page, [before[1], before[0], before[2], before[3], before[4]]);
  assert.equal(page.document.activeElement, inputs[0]);
  assertDraft(page);
  assertLabels(page);
  page.format();
  assert.equal(page.get("formatted-address").value, "\tشارع النيل\u00a0\n  Zoe\u0308 李 📦  \n<recipient> & Co.\nduplicate\nduplicate");
  page.move(4, "up");
  assertDraft(page);
  assertSnapshot(page, [before[1], before[0], before[2], before[4], before[3]]);
  assert.equal(page.document.activeElement, inputs[4]);
  page.move(2, "down");
  page.move(3, "down");
  assertNodeOrder([...page.rows()], [rows[1], rows[0], rows[4], rows[3], rows[2]]);
  assertSnapshot(page, [before[1], before[0], before[4], before[3], before[2]]);
  assert.equal(page.document.activeElement, inputs[2]);
  assertLabels(page);
  page.format();
  assert.equal(page.get("formatted-address").value, "\tشارع النيل\u00a0\n  Zoe\u0308 李 📦  \nduplicate\nduplicate\n<recipient> & Co.");
  assert.equal(page.get("formatted-address").children.length, 0);
  assert.equal(page.get("formatted-address").hidden, false);
  page.add();
  assertLabels(page);
  assertDraft(page);
  const added = page.inputs()[5];
  page.remove(1);
  assertLabels(page);
  assertNodeOrder(page.inputs(), [inputs[1], inputs[4], inputs[3], inputs[2], added]);
  assert.equal(page.document.activeElement, inputs[4]);
});

test("boundary moves are complete no-ops for one or multiple rows with a result or error", () => {
  for (const count of [1, 3]) {
    for (const invalid of [false, true]) {
      const page = loadPage();
      for (let index = 0; index < count; index++) {
        if (index) page.add();
        page.edit(index, invalid && index === 0 ? "Before\nAfter" : "Line " + index);
        page.inputs()[index].setSelectionRange(1, 3, "backward");
      }
      page.format();
      assert.equal(page.get("address-status").dataset.state, invalid ? "error" : "success");
      page.get("format-address").focus();
      const rows = [...page.rows()];
      const before = draftSnapshot(page);
      const output = page.get("formatted-address");
      const status = page.get("address-status");
      const result = [output.value, output.hidden, status.textContent, status.dataset.state];
      for (const [index, direction] of [[0, "up"], [count - 1, "down"]]) {
        const button = page.button(index, "Move " + direction);
        assert.equal(button.disabled, true);
        button.click();
        // Dispatch directly as well: the handler must guard its own boundary.
        button.emit("click");
        assertNodeOrder([...page.rows()], rows);
        assertSnapshot(page, before);
        assert.equal(page.document.activeElement, page.get("format-address"));
        assert.deepEqual([output.value, output.hidden, status.textContent, status.dataset.state], result);
        assertLabels(page);
      }
    }
  }
});

test("moving invalid raw drafts clears errors without validating; explicit format uses the new error index", () => {
  const cases = [
    { value: " \t\u3000", reason: "must not be blank" },
    { value: "Before\nAfter", reason: "must not contain line breaks" },
  ];
  for (const { value, reason } of cases) {
    const page = loadPage();
    page.edit(0, "Untouched");
    page.add();
    page.edit(1, value);
    page.inputs()[1].setSelectionRange(0, 0, "none");
    const before = draftSnapshot(page);
    page.format();
    assert.equal(page.get("address-status").textContent, "Could not format: lines[1] " + reason);
    page.move(1, "up");
    assertDraft(page);
    assertSnapshot(page, [before[1], before[0]]);
    assert.equal(page.document.activeElement, before[1].input);
    assertLabels(page);
    page.format();
    assertCleared(page);
    assert.equal(page.get("address-status").textContent, "Could not format: lines[0] " + reason);
    assert.equal(page.get("address-status").dataset.state, "error");
    page.move(0, "down");
    assertDraft(page);
    assertSnapshot(page, before);
    assertLabels(page);
  }
});

// Dispatch-only coverage: cancellation is observable here, native pointer focus
// defaults are not simulated. Actual pointer/caret proof needs the retained client.
function pointerDown(button) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  button.emit("pointerdown", event);
  return event;
}

test("disabled Move pointerdown requests cancellation without touching focus or draft state", () => {
  for (const count of [1, 2]) {
    for (const invalid of [false, true]) {
      const page = loadPage();
      page.edit(0, invalid ? "Before\nAfter" : "First line");
      if (count === 2) { page.add(); page.edit(1, "Second line"); }
      page.format();
      const focused = page.inputs()[count - 1];
      focused.focus();
      focused.setSelectionRange(2, 5, "backward");
      const before = draftSnapshot(page);
      const rows = [...page.rows()];
      const output = page.get("formatted-address");
      const status = page.get("address-status");
      const result = [output.value, output.hidden, status.textContent, status.dataset.state];
      for (const [index, direction] of [[0, "up"], [count - 1, "down"]]) {
        const button = page.button(index, "Move " + direction);
        assert.equal(button.disabled, true);
        assert.equal(pointerDown(button).defaultPrevented, true);
        button.click();
        assertNodeOrder([...page.rows()], rows);
        assertSnapshot(page, before);
        assert.equal(page.document.activeElement, focused);
        assert.deepEqual([output.value, output.hidden, status.textContent, status.dataset.state], result);
        assertLabels(page);
      }
      // Unrelated controls must retain their own pointer defaults.
      for (const button of [page.button(0, "Remove"), page.get("add-line"), page.get("format-address")]) {
        assert.equal(pointerDown(button).defaultPrevented, false);
      }
      if (count === 2) {
        const down = page.button(0, "Move down");
        assert.equal(pointerDown(down).defaultPrevented, false);
        assertSnapshot(page, before);
        assert.equal(page.document.activeElement, focused);
        down.click();
        assertSnapshot(page, [before[1], before[0]]);
        assert.equal(page.document.activeElement, before[0].input);
        assertDraft(page);
        assertLabels(page);
        // The same control follows its current boundary after a real move.
        assert.equal(down.disabled, true);
        assert.equal(pointerDown(down).defaultPrevented, true);
        const up = page.button(1, "Move up");
        assert.equal(pointerDown(up).defaultPrevented, false);
        up.click();
        assertSnapshot(page, before);
        assert.equal(page.document.activeElement, before[0].input);
        assertDraft(page);
        assertLabels(page);
      }
    }
  }
});
