"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parcelLabel } = require("./parcel-label.js");
const { validateDraft } = require("./preview/parcel-preview.js");
const { buildPreview, readSources } = require("./build-parcel-preview.js");

const sources = readSources();
const html = buildPreview(sources);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test("draft validation accepts zero, whole counts and the safe-integer boundary", () => {
  for (const [input, expected] of [["0", 0], ["1", 1], ["3", 3], [" 0003 ", 3], ["9007199254740991", Number.MAX_SAFE_INTEGER]]) {
    const draft = validateDraft("  Parcel 📦 東京  ", input);
    assert.deepEqual(draft.errors, { identifier: "", count: "" });
    assert.deepEqual(draft.value, { identifier: "Parcel 📦 東京", count: expected });
  }
});

test("draft validation rejects missing, non-decimal, fractional and unsafe counts", () => {
  const invalid = ["", " ", "-0", "-1", "+1", "1.0", "1.5", "1e3", "0x10", "1_000", "1,000", "1 2", "1\n2", "NaN", "Infinity", "１２", "9007199254740992", "9007199254740993", "9".repeat(400)];
  for (const input of invalid) {
    const draft = validateDraft("Parcel", input);
    assert.equal(draft.value, null, input);
    assert.ok(draft.errors.count, input);
  }
  for (const name of ["", " ", "\t\n"]) {
    const draft = validateDraft(name, "0");
    assert.equal(draft.value, null);
    assert.ok(draft.errors.identifier);
    assert.equal(draft.errors.count, "");
  }
});

test("built HTML is fresh, self-contained and has no unresolved build marker", () => {
  assert.equal(fs.readFileSync(path.join(__dirname, "parcel-preview.html"), "utf8"), html);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(html, /PARCEL_PREVIEW_SCRIPT/);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe|audio|video)\b[^>]*\b(?:src|href)\s*=/i);
  assert.doesNotMatch(html, /@import|url\s*\(|\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b|\bwindow\.print\s*\(/);
});

test("bundle consumes the canonical CommonJS source without changing its behavior", () => {
  function bundledLabels(formatterSource) {
    const built = buildPreview({
      template: sources.template,
      formatterSource,
      appSource: `module.exports = { mountPreview(document, formatter) {
        document.labels = [0, 1, 3, Number.MAX_SAFE_INTEGER, -1, 1.5, "1", null].map(formatter);
      } };`,
    });
    const context = { document: {} };
    vm.runInNewContext(built.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    assert.equal(context.module, undefined);
    assert.equal(context.parcelLabel, undefined);
    return Array.from(context.document.labels);
  }
  assert.deepEqual(
    bundledLabels(sources.formatterSource),
    [0, 1, 3, Number.MAX_SAFE_INTEGER, -1, 1.5, "1", null].map(parcelLabel),
  );
  // A changed helper must actually affect the bundle, not a hand-copied formatter.
  const changed = sources.formatterSource + '\nmodule.exports.parcelLabel = () => "from source: $& $$";';
  assert.ok(bundledLabels(changed).every((label) => label === "from source: $& $$"));
});

test("builder rejects ambiguous template markers and HTML script delimiters", () => {
  for (const template of ["", "<!-- PARCEL_PREVIEW_SCRIPT --><!-- PARCEL_PREVIEW_SCRIPT -->"]) {
    assert.throws(() => buildPreview({ ...sources, template }), /exactly one script marker/);
  }
  for (const delimiter of ["</script>", "</ScRiPt >", "<script", "<!--"]) {
    assert.throws(() => buildPreview({ ...sources, formatterSource: `// ${delimiter}` }), /script delimiters/);
    assert.throws(() => buildPreview({ ...sources, appSource: `// ${delimiter}` }), /script delimiters/);
  }
});

// A deliberately small DOM contract double: runs the *generated* script without
// launching a browser. It checks state/text/event wiring, not layout or printing.
function loadPreview() {
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById: (id) => {
      assert.ok(elements.has(id), `Missing template element: ${id}`);
      return elements.get(id);
    },
    createElement: (tag) => new Element(tag),
  };
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.value = "";
      this.attributes = {};
      this.listeners = {};
      this.text = "";
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    set innerHTML(_) { assert.fail("Labels must be text, never HTML"); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ""; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    focus() { document.activeElement = this; }
    fire(type) {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      assert.ok(this.listeners[type], `Missing ${type} listener`);
      this.listeners[type](event);
      return event;
    }
  }
  for (const match of sources.template.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi)) {
    assert.ok(!elements.has(match[2]), `Duplicate id: ${match[2]}`);
    elements.set(match[2], new Element(match[1]));
  }
  vm.runInNewContext(script, { document });
  const get = document.getElementById;
  function draft(name, count) {
    get("parcel-identifier").value = name;
    get("parcel-count").value = count;
    get("parcel-form").fire("input");
  }
  return { document, get, draft };
}

test("generated app clears invalid previews and never adds invalid drafts", () => {
  const { document, get, draft } = loadPreview();
  const preview = get("label-preview");
  const sheet = get("label-sheet");
  const form = get("parcel-form");
  assert.equal(preview.children.length, 0);
  assert.equal(get("clear-sheet").disabled, true);
  assert.equal(get("count-error").textContent, "");

  const literal = '<img src=x onerror=alert(1)> & 東京 📦 </script>';
  draft(literal, "0");
  assert.equal(preview.children[0].children[0].textContent, literal);
  assert.equal(preview.children[0].children[1].textContent, "0 items");
  assert.equal(form.fire("submit").prevented, true);
  assert.equal(sheet.children.length, 1);
  assert.notEqual(sheet.children[0], preview.children[0]);
  const accepted = sheet.children[0];
  assert.equal(get("sheet-empty").hidden, true);
  assert.equal(get("sheet-count").textContent, "1 label");

  for (const invalid of ["", "-1", "1.5", "1e3", "9007199254740992"]) {
    draft("Edited parcel", invalid);
    assert.equal(preview.children.length, 0);
    assert.equal(get("parcel-count").attributes["aria-invalid"], "true");
    assert.ok(get("count-error").textContent);
    form.fire("submit");
    assert.equal(sheet.children.length, 1);
    assert.equal(sheet.children[0], accepted);
    assert.equal(accepted.children[0].textContent, literal);
    assert.equal(document.activeElement, get("parcel-count"));
  }
  draft("  ", "3");
  assert.equal(preview.children.length, 0);
  form.fire("submit");
  assert.equal(document.activeElement, get("parcel-identifier"));
  assert.equal(sheet.children.length, 1);

  draft("Next parcel", "1");
  assert.equal(get("count-error").textContent, "");
  assert.equal(get("parcel-count").attributes["aria-invalid"], "false");
  form.fire("submit");
  assert.equal(sheet.children.length, 2);
  assert.equal(sheet.children[1].children[1].textContent, "1 item");
});

test("form reset and sheet reset are independent and fresh loads are empty", () => {
  const { document, get, draft } = loadPreview();
  const form = get("parcel-form");
  draft("Parcel", "3");
  form.fire("submit");
  draft("Parcel", "bad");
  assert.equal(form.fire("reset").prevented, true);
  assert.equal(get("parcel-identifier").value, "");
  assert.equal(get("parcel-count").value, "");
  assert.equal(get("label-preview").children.length, 0);
  assert.equal(get("count-error").textContent, "");
  assert.equal(get("identifier-error").textContent, "");
  assert.equal(get("parcel-count").attributes["aria-invalid"], "false");
  assert.equal(get("label-sheet").children.length, 1);
  assert.equal(document.activeElement, get("parcel-identifier"));

  draft("Keep this draft", "9007199254740991");
  const previewText = get("label-preview").textContent;
  get("clear-sheet").fire("click");
  assert.equal(get("label-sheet").children.length, 0);
  assert.equal(get("sheet-count").textContent, "0 labels");
  assert.equal(get("sheet-empty").hidden, false);
  assert.equal(get("clear-sheet").disabled, true);
  assert.equal(get("label-preview").textContent, previewText);
  assert.equal(document.activeElement, get("parcel-identifier"));
  assert.equal(loadPreview().get("label-sheet").children.length, 0);
});
