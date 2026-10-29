"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { resolveObjectURL } = require("node:buffer");
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
    if (name === "disabled") this.disabled = true;
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "href") this.href = "";
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
    const results = (this.listeners[type] || []).map((listener) => listener(event));
    if (this.parent) results.push(this.parent.emit(type, event));
    return Promise.all(results);
  }
  click() { if (!this.disabled) this.emit("click"); }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end, direction) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

function loadPage(urlApi = URL) {
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
  const window = new Element("window", document);
  const context = vm.createContext({ document, window, TextDecoder, Blob, URL: urlApi });
  const scripts = [...html.matchAll(/<script\b([^>]*)><\/script>/g)];
  for (const [, attrs] of scripts) {
    const file = /src="([^"]+)"/.exec(attrs)[1];
    vm.runInContext(source(file), context, { filename: file });
  }
  const get = document.getElementById;
  return { document, window, get,
    select(file) {
      const input = get("import-draft");
      input.files = file ? [file] : [];
      return input.emit("change");
    },
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


// Native Node Files exercise bytes/decoding, not a native browser file picker.
const jsonFile = (text) => new File([text], "draft.json", { type: "application/json" });

function existingResult(page) {
  page.edit(0, "Keep this result");
  page.format();
  return draftSnapshot(page);
}

function assertKept(page, before) {
  assertSnapshot(page, before);
  assert.equal(page.get("formatted-address").value, "Keep this result");
  assert.equal(page.get("formatted-address").hidden, false);
  assert.equal(page.get("address-status").dataset.state, "success");
}

test("interchange entry starts inert with labelled file input and read-only previews", () => {
  const page = loadPage();
  assert.equal(page.get("import-draft").attributes.type, "file");
  assert.equal(page.get("replace-draft").disabled, true);
  assert.equal(page.get("cancel-import").disabled, true);
  assert.equal(page.get("import-decision").hidden, true);
  for (const id of ["import-preview", "export-preview"]) {
    assert.equal(page.get(id).readOnly, true);
    assert.equal(page.get(id).value, "");
  }
  assert.equal(page.get("export-preview").hidden, true);
  assert.equal(page.get("download-draft").hidden, true);
  for (const id of ["import-status", "export-status"]) {
    assert.equal(page.get(id).attributes.role, "status");
    assert.equal(page.get(id).attributes["aria-live"], "polite");
  }
});

test("file staging preserves independently specified parsed values; only Replace applies the snapshot", async () => {
  const page = loadPage();
  const before = existingResult(page);
  // Spell the JSON independently from the expected values (no codec roundtrip oracle).
  const literal = '["", " \\t ", "Before\\nAfter", "  Zoe\\u0308 李 📦  ", "duplicate", "duplicate", "<tag>&", "\\\\r", "\\ud800", "\\u0000"]';
  await page.select(jsonFile(literal));
  const expected = ["", " \t ", "Before\nAfter", "  Zoe\u0308 李 📦  ", "duplicate", "duplicate", "<tag>&", "\\r", "\ud800", "\u0000"];
  assertKept(page, before);
  assert.equal(page.get("replace-draft").disabled, false);
  assert.equal(page.get("import-decision").hidden, false);
  assert.deepEqual(JSON.parse(page.get("import-preview").value), expected);
  // A DOM text field is not the authoritative staged snapshot.
  page.get("import-preview").value = '["not the snapshot"]';
  page.get("replace-draft").click();
  assert.deepEqual(page.values(), expected);
  assertDraft(page);
  assertLabels(page);
  assert.equal(page.document.activeElement, page.inputs()[0]);
  assert.equal(page.get("import-preview").value, "");
  assert.equal(page.get("import-decision").hidden, true);
  assert.equal(page.get("replace-draft").disabled, true);
  page.get("replace-draft").emit("click");
  assert.deepEqual(page.values(), expected);
  page.format();
  assert.equal(page.get("address-status").textContent, "Could not format: lines[0] must not be blank");
  page.remove(0);
  page.remove(0);
  page.format();
  assert.equal(page.get("address-status").textContent, "Could not format: lines[0] must not contain line breaks");
});

test("empty array Replace focuses Add; JSON whitespace and escape spelling are not value changes", async () => {
  const page = loadPage();
  const before = existingResult(page);
  await page.select(jsonFile("[]"));
  assertKept(page, before);
  assert.equal(page.get("import-preview").value, "[]");
  page.get("replace-draft").click();
  assert.deepEqual(page.values(), []);
  assertDraft(page);
  assert.equal(page.document.activeElement, page.get("add-line"));
  page.get("export-draft").click();
  assert.equal(page.get("export-preview").value, "[]");
  await page.select(jsonFile('[\r\n "\\u0041", "A", "\\uFEFFinside"\r\n]'));
  page.get("replace-draft").click();
  assert.deepEqual(page.values(), ["A", "A", "\uFEFFinside"]);
  page.format();
  assert.equal(page.get("formatted-address").value, "A\nA\n\uFEFFinside");
  page.add();
  assertLabels(page);
  assert.deepEqual(page.values(), ["A", "A", "\uFEFFinside", ""]);
});

test("a leading UTF-8 encoding BOM accepts JSON whitespace without changing literal FEFF values", async () => {
  for (const { json, expected } of [
    { json: '[\r\n "\uFEFFinside", "  Ω  ", "tail\uFEFF", "\uFEFF"\r\n]',
      expected: ["\uFEFFinside", "  Ω  ", "tail\uFEFF", "\uFEFF"] },
    { json: ' \r\n[]\r\n', expected: [] },
  ]) {
    const page = loadPage();
    const before = existingResult(page);
    // Native File bytes go through the real entry's arrayBuffer/decoder consumer.
    await page.select(new File([new Uint8Array([0xef, 0xbb, 0xbf]), json], "bom.json"));
    assertKept(page, before);
    assert.equal(page.get("replace-draft").disabled, false);
    assert.deepEqual(JSON.parse(page.get("import-preview").value), expected);
    page.get("replace-draft").click();
    assert.deepEqual(page.values(), expected);
    assertDraft(page);
    assertLabels(page);
    page.get("export-draft").click();
    assert.deepEqual(JSON.parse(page.get("export-preview").value), expected);
    await page.window.emit("pagehide");
  }
});

test("invalid file bytes and values refuse atomically, discard old staging, and preserve current result", async () => {
  const page = loadPage();
  const before = existingResult(page);
  const invalid = [
    ["", "file must contain valid JSON"],
    ['["ok",]', "file must contain valid JSON"],
    ['["ok"] trailing', "file must contain valid JSON"],
    ['["raw\nnewline"]', "file must contain valid JSON"],
    [" \uFEFF[]", "file must contain valid JSON"],
    ["\uFEFF\uFEFF[]", "file must contain valid JSON"],
    ...['null', '{}', '"text"', '3', 'true'].map((text) => [text, "draft must be an array of strings"]),
    ...['null', '3', 'true', '{}', '[]'].map((text) => ['["ok",' + text + ']', "draft[1] must be a string"]),
    ...['\\r', '\\r\\n', '\\u000d'].flatMap((cr) => ["", "\uFEFF"].map((prefix) =>
      [prefix + '["ok","before' + cr + 'after"]', "draft[1] contains CR; textareas cannot preserve CR"],
    )),
    ...[
      [0xc3, 0x28], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff],
    ].flatMap((bytes) => [[], [0xef, 0xbb, 0xbf]].map((prefix) =>
      [new Uint8Array([...prefix, 0x5b, 0x22, ...bytes, 0x22, 0x5d]), "file must contain valid UTF-8"],
    )),
  ];
  for (const [content, reason] of invalid) {
    await page.select(jsonFile('["previous valid staging"]'));
    await page.select(jsonFile(content));
    assertKept(page, before);
    assert.equal(page.get("import-preview").value, "");
    assert.equal(page.get("import-decision").hidden, true);
    assert.equal(page.get("replace-draft").disabled, true);
    assert.equal(page.get("import-status").textContent, "Could not import: " + reason + ". Current draft unchanged.");
    page.get("replace-draft").emit("click");
    assertKept(page, before);
  }
  await page.select({ arrayBuffer() { throw new Error("unreadable file"); } });
  assert.equal(page.get("import-status").textContent, "Could not import: unreadable file. Current draft unchanged.");
  assertKept(page, before);
  await page.select(jsonFile('["recovery"]'));
  page.get("replace-draft").click();
  assert.deepEqual(page.values(), ["recovery"]);
});

// Deferred reads exercise delivery-address-editor.js's generation guard through
// the real entry's change/Cancel/Replace/pagehide handlers. Not native file timing.
function deferredFile() {
  const { promise, resolve, reject } = Promise.withResolvers();
  return { file: { arrayBuffer: () => promise }, resolve, reject };
}
const utf8 = (text) => new TextEncoder().encode(text);

test("newer selection wins over stale success, invalid bytes, and failure even after Replace", async () => {
  for (const settle of [
    (read) => read.resolve(utf8('["old"]')),
    (read) => read.resolve(new Uint8Array([0xff])),
    (read) => read.reject(new Error("old failure")),
  ]) {
    for (const applyBeforeOldSettles of [false, true]) {
      const page = loadPage();
      const before = existingResult(page);
      const old = deferredFile();
      const pending = page.select(old.file);
      assertKept(page, before);
      assert.equal(page.get("replace-draft").disabled, true);
      await page.select(jsonFile('["new"]'));
      if (applyBeforeOldSettles) page.get("replace-draft").click();
      const status = page.get("import-status").textContent;
      settle(old);
      await pending;
      assert.equal(page.get("import-status").textContent, status);
      if (!applyBeforeOldSettles) {
        assertKept(page, before);
        assert.deepEqual(JSON.parse(page.get("import-preview").value), ["new"]);
        page.get("replace-draft").click();
      }
      assert.deepEqual(page.values(), ["new"]);
    }
  }
});

test("Cancel fences pending successes/failures and leaves edits, controls, output and newer staging alone", async () => {
  for (const fail of [false, true]) {
    const page = loadPage();
    const before = existingResult(page);
    const old = deferredFile();
    const pending = page.select(old.file);
    assert.equal(page.get("cancel-import").disabled, false);
    page.get("cancel-import").click();
    assertKept(page, before);
    assert.equal(page.document.activeElement, page.get("import-draft"));
    const cancelled = page.get("import-status").textContent;
    if (fail) old.reject(new Error("late failure"));
    else old.resolve(utf8('["late success"]'));
    await pending;
    assert.equal(page.get("import-status").textContent, cancelled);
    assert.equal(page.get("import-preview").value, "");
    assert.equal(page.get("replace-draft").disabled, true);
    assertKept(page, before);
    const next = deferredFile();
    const nextPending = page.select(next.file);
    page.edit(0, "edited while reading");
    const input = page.inputs()[0];
    next.resolve(utf8('["staged"]'));
    await nextPending;
    assert.equal(page.inputs()[0], input);
    assert.deepEqual(page.values(), ["edited while reading"]);
    page.edit(0, "edited after staging");
    page.get("cancel-import").click();
    assert.deepEqual(page.values(), ["edited after staging"]);
    await page.select(jsonFile('["replacement"]'));
    page.edit(0, "last edit before explicit decision");
    page.get("replace-draft").click();
    assert.deepEqual(page.values(), ["replacement"]);
  }
});

test("old completion cannot fill newer loading/error/empty states or a Cancel followed by new staging", async () => {
  for (const state of ["loading", "error", "empty", "cancel-then-new"]) {
    const page = loadPage();
    const before = existingResult(page);
    const old = deferredFile();
    const pending = page.select(old.file);
    const newer = deferredFile();
    let newerPending;
    if (state === "loading") newerPending = page.select(newer.file);
    if (state === "error") await page.select(jsonFile("null"));
    if (state === "empty") await page.select(null);
    if (state === "cancel-then-new") {
      page.get("cancel-import").click();
      await page.select(jsonFile('["after cancel"]'));
    }
    const status = page.get("import-status").textContent;
    const preview = page.get("import-preview").value;
    old.resolve(utf8('["obsolete"]'));
    await pending;
    assert.equal(page.get("import-status").textContent, status);
    assert.equal(page.get("import-preview").value, preview);
    assertKept(page, before);
    if (newerPending) {
      newer.resolve(utf8('["latest"]'));
      await newerPending;
      page.get("replace-draft").click();
      assert.deepEqual(page.values(), ["latest"]);
    }
  }
});


test("export uses raw current order, native Blob bytes, and read-only JSON without formatting", async () => {
  const page = loadPage();
  const values = ["  Zoe\u0308 李 📦  ", "", "Before\nAfter", "duplicate", "duplicate", "\ud800"];
  values.forEach((value, index) => { if (index) page.add(); page.edit(index, value); });
  page.move(2, "up");
  const before = draftSnapshot(page);
  page.get("export-draft").click();
  const expected = ["  Zoe\u0308 李 📦  ", "Before\nAfter", "", "duplicate", "duplicate", "\ud800"];
  const preview = page.get("export-preview");
  assert.deepEqual(JSON.parse(preview.value), expected);
  assert.equal(preview.readOnly, true);
  assert.equal(preview.hidden, false);
  assertSnapshot(page, before);
  assertDraft(page);
  const link = page.get("download-draft");
  assert.equal(link.attributes.download, "address-draft.json");
  assert.equal(link.hidden, false);
  const blob = resolveObjectURL(link.href);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "application/json;charset=utf-8");
  assert.equal(await blob.text(), preview.value);
  assert.deepEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer())), expected);
  // A second explicit export releases only the old resource.
  const oldUrl = link.href;
  page.get("export-draft").click();
  assert.equal(resolveObjectURL(oldUrl), undefined);
  assert.ok(resolveObjectURL(link.href));
  const currentUrl = link.href;
  await page.window.emit("pagehide");
  assert.equal(resolveObjectURL(currentUrl), undefined);
  assert.equal(preview.hidden, true);
  assert.equal(preview.value, "");
});

test("export is not formatting and its snapshot clears only through the existing invalidation lifecycle", async () => {
  for (const action of ["edit", "add", "remove", "move", "replace", "format"]) {
    const page = loadPage();
    page.edit(0, "First");
    page.add();
    page.edit(1, "Second");
    page.format();
    page.get("export-draft").click();
    const preview = page.get("export-preview");
    const link = page.get("download-draft");
    const url = link.href;
    assert.equal(preview.value, '[\n  "First",\n  "Second"\n]');
    assert.equal(page.get("formatted-address").value, "First\nSecond");
    page.move(0, "up");
    await page.select(jsonFile('["staged"]'));
    page.get("cancel-import").click();
    await page.select(jsonFile('["ok",false]'));
    assert.equal(preview.value, '[\n  "First",\n  "Second"\n]');
    assert.equal(link.href, url);
    assert.ok(resolveObjectURL(url));
    assert.equal(page.get("formatted-address").value, "First\nSecond");
    if (action === "edit") page.edit(0, "changed");
    if (action === "add") page.add();
    if (action === "remove") page.remove(0);
    if (action === "move") page.move(0, "down");
    if (action === "replace") {
      await page.select(jsonFile('["replacement"]'));
      page.get("replace-draft").click();
    }
    if (action === "format") page.format();
    assert.equal(resolveObjectURL(url), undefined, action);
    assert.equal(link.hidden, true, action);
    assert.equal(link.href, "", action);
    assert.equal(preview.value, "", action);
    assert.equal(preview.hidden, true, action);
  }
});

test("download unavailable retains selectable JSON; export refusal leaves draft/result alone", () => {
  const page = loadPage({}); // No object-URL support, not a call-shape spy.
  const before = existingResult(page);
  page.get("export-draft").click();
  assertKept(page, before);
  assert.equal(page.get("export-preview").value, '[\n  "Keep this result"\n]');
  assert.equal(page.get("export-preview").hidden, false);
  assert.equal(page.get("download-draft").hidden, true);
  assert.equal(page.get("export-status").textContent, "Download unavailable. Select the read-only JSON below.");
  // The double does not normalize CR. Verify the codec refuses rather than
  // silently repairing such a value; native textarea normalization is unproven.
  page.edit(0, "before\rafter");
  const draft = draftSnapshot(page);
  page.get("export-draft").click();
  assertSnapshot(page, draft);
  assert.equal(page.get("export-preview").value, "");
  assert.equal(page.get("export-preview").hidden, true);
  assert.equal(page.get("export-status").textContent, "Could not export: draft[0] contains CR; textareas cannot preserve CR");
});

test("pagehide clears staged/loading imports and export resources, fencing late read success and failure", async () => {
  for (const fail of [false, true]) {
    const page = loadPage();
    const before = existingResult(page);
    await page.select(jsonFile('["staged"]'));
    await page.window.emit("pagehide");
    assert.equal(page.get("import-preview").value, "");
    assert.equal(page.get("replace-draft").disabled, true);
    const read = deferredFile();
    const pending = page.select(read.file);
    page.get("export-draft").click();
    const url = page.get("download-draft").href;
    assert.ok(resolveObjectURL(url));
    await page.window.emit("pagehide");
    const status = page.get("import-status").textContent;
    if (fail) read.reject(new Error("late failure"));
    else read.resolve(utf8('["late success"]'));
    await pending;
    assert.equal(page.get("import-status").textContent, status);
    assert.equal(page.get("replace-draft").disabled, true);
    assert.equal(page.get("cancel-import").disabled, true);
    assert.equal(page.get("import-decision").hidden, true);
    assert.equal(resolveObjectURL(url), undefined);
    assertKept(page, before);
    await page.select(jsonFile('["new after return"]'));
    page.get("replace-draft").click();
    assert.deepEqual(page.values(), ["new after return"]);
  }
});


test("bulk Replace uses the row owner for complete values, labels, boundaries and subsequent Add/Move/Remove", async () => {
  const page = loadPage();
  const before = existingResult(page);
  const expected = Array.from({ length: 256 }, (_, index) => " Line " + index + " ");
  await page.select(jsonFile(JSON.stringify(expected)));
  assertKept(page, before);
  page.get("replace-draft").click();
  assert.deepEqual(page.values(), expected);
  assertLabels(page);
  assert.equal(page.document.activeElement, page.inputs()[0]);
  assertDraft(page);
  page.add();
  assert.deepEqual(page.values(), [...expected, ""]);
  assertLabels(page);
  page.move(256, "up");
  assert.deepEqual(page.values(), [...expected.slice(0, 255), "", expected[255]]);
  page.remove(255);
  assert.deepEqual(page.values(), expected);
  assertLabels(page);
});
