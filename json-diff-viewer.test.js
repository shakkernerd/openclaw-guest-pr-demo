"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { File } = require("node:buffer");
const { compareJson } = require("./json-diff.js");

const html = fs.readFileSync(path.join(__dirname, "json-diff-viewer.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const source = fs.readFileSync(path.join(__dirname, "json-diff.js"), "utf8");
const empty = { added: [], removed: [], changed: [] };
const encode = report => Buffer.from(JSON.stringify(report) + "\n");
const plain = value => JSON.parse(JSON.stringify(value));
const changed = (before, after, segments = []) => ({
  added: [], removed: [], changed: [{ path: segments, before, after }],
});
const reportFile = (bytes, name = "synthetic.json") => new File([bytes], name);
const producerReport = (before, after) => compareJson(Buffer.from(JSON.stringify(before)), Buffer.from(JSON.stringify(after))).report;

// Deliberately small DOM double: execute the maintained inline script, not a
// copied validator/controller. This is NOT browser layout, accessibility-tree,
// native file-picker, or physical keyboard proof. Unexpected HTML sinks throw.
function viewer() {
  const elements = new Map();
  const created = [];
  const document = { activeElement: null, actions: [] };
  class Element {
    constructor(tag = "div") {
      this.tagName = tag; this.children = []; this.listeners = new Map();
      this.attributes = new Map(); this.value = ""; this.files = [];
      this.hidden = false; this.disabled = false; this._text = "";
      created.push(this);
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set innerHTML(_) { throw new Error("HTML sink used"); }
    set outerHTML(_) { throw new Error("HTML sink used"); }
    insertAdjacentHTML() { throw new Error("HTML sink used"); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ""; this.children = children; }
    get firstElementChild() { return this.children[0]; }
    setAttribute(key, value) {
      assert.doesNotMatch(key, /^(on|src|href)/i);
      this.attributes.set(key, String(value));
    }
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler); this.listeners.set(type, handlers);
    }
    fire(type, properties = {}) {
      const event = { ...properties, prevented: false, preventDefault() { this.prevented = true; } };
      for (const handler of this.listeners.get(type) || []) handler(event);
      return event;
    }
    focus(options) {
      document.activeElement = this;
      document.actions.push({ type: "focus", element: this, options });
    }
    scrollIntoView(options) { document.actions.push({ type: "scroll", element: this, options }); }
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(match[3], element);
  }
  elements.get("kind").value = "all";
  document.getElementById = id => { assert.ok(elements.has(id), "missing element " + id); return elements.get(id); };
  document.createElement = tag => new Element(tag);
  const context = vm.createContext({ document, TextDecoder, Uint8Array });
  new vm.Script(script, { filename: "json-diff-viewer.html:inline" }).runInContext(context, { timeout: 1000 });
  const api = vm.runInContext("({parseReport, jsonText, makeRows, filterRows, valueType, loadFile, selectMatch, applyFilters})", context);
  return { ...api, ui: Object.fromEntries(elements), context, document, created };
}

test("artifact: inline-only assets, inert sinks, labels, focus and source-matched bounds", () => {
  const v = viewer();
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal((html.match(/<style\b/g) || []).length, 1);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'"]) assert.ok(html.includes(directive));
  assert.doesNotMatch(html, /\s(?:src|srcset|action|on\w+)\s*=/i);
  assert.doesNotMatch(html, /\shref\s*=/i);
  assert.doesNotMatch(script, /\b(?:fetch|XMLHttpRequest|WebSocket|Worker|EventSource|open|eval|Function|setTimeout|setInterval)\s*\(/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|cookie|clipboard|createObjectURL|download|compareJson/);
  assert.doesNotMatch(html, /@import|url\s*\(/i);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of html.matchAll(/(?:aria-labelledby|aria-describedby|for)="([^"]+)"/g)) {
    for (const id of match[1].split(" ")) assert.ok(ids.includes(id), id);
  }
  for (const id of ["report-file", "kind", "query", "jump"]) assert.ok(html.includes('for="' + id + '"'));
  assert.match(html, /:focus-visible/);
  assert.match(html, /@media \(max-width: 38rem\)/);
  assert.match(html, /overflow-wrap: anywhere/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
  assert.equal(v.ui.workspace.hidden, true);
  assert.equal(v.ui.filters.disabled, true);
  for (const name of ["MAX_REPORT_BYTES", "MAX_DEPTH", "MAX_VALUES", "MAX_COMPARISONS"]) {
    const declaration = source.match(new RegExp("const " + name + " = ([^;]+);"))[1];
    assert.equal(vm.runInContext(name, v.context), vm.runInNewContext(declaration), name);
  }
});

test("skip action stays local and preserves state under file and srcdoc bases", async () => {
  const button = html.match(/<button\b[^>]*\bid="skip-detail"[^>]*>Skip to selected change<\/button>/);
  assert.ok(button, "skip must be a native button, not a fragment link that can navigate srcdoc");
  assert.match(button[0], /\btype="button"/);
  assert.doesNotMatch(button[0], /\b(?:href|formaction|disabled|tabindex)\b/);
  for (const [url, baseURI] of [
    ["file:///offline/viewer.html", "file:///offline/viewer.html"],
    ["about:srcdoc", "http://files.invalid/native-preview/"],
  ]) {
    const v = viewer();
    v.document.URL = url;
    v.document.baseURI = baseURI;
    for (const target of [v.document, v.context]) {
      Object.defineProperty(target, "location", {
        get() { assert.fail("skip must not access location"); },
        set() { assert.fail("skip must not navigate"); },
      });
    }
    const report = {
      added: [{ path: ["new"], value: null }],
      removed: [{ path: ["old"], value: false }, { path: ["tail"], value: "" }],
      changed: Array.from({ length: 8 }, (_, i) => ({ path: ["keep", i], before: i, after: [null, false, "", {}, []] })),
    };
    await v.loadFile(reportFile(encode(report)));
    assert.match(v.ui.totals.textContent, /Total 11$/);
    v.ui.kind.value = "changed"; v.ui.kind.fire("change");
    v.ui.query.value = "keep"; v.ui.query.fire("input");
    v.selectMatch(3);
    const state = () => vm.runInContext("({rows, matches, cursor, generation})", v.context);
    const before = state();
    const encodedState = JSON.stringify(before);
    const display = () => Object.fromEntries([
      "file-name", "status", "totals", "match-count", "page-label", "detail-title", "path", "before", "after", "change-list",
    ].map(id => [id, v.ui[id].textContent]));
    const beforeDisplay = display();
    const list = v.ui["change-list"].children;
    v.ui["skip-detail"].focus();
    v.document.actions.length = 0;
    // Native button semantics provide Enter/Space activation in a browser.
    // This DOM double checks the click handler, not physical key dispatch.
    v.ui["skip-detail"].fire("click");
    assert.equal(v.document.activeElement, v.ui["detail-title"]);
    assert.deepEqual(v.document.actions.map(action => action.type), ["focus", "scroll"]);
    assert.equal(v.document.actions.every(action => action.element === v.ui["detail-title"]), true);
    assert.deepEqual(plain(v.document.actions[0].options), { preventScroll: true });
    assert.deepEqual(plain(v.document.actions[1].options), { block: "start" });
    assert.equal(state().rows, before.rows);
    assert.equal(state().matches, before.matches);
    assert.equal(JSON.stringify(state()), encodedState);
    assert.deepEqual(display(), beforeDisplay);
    assert.equal(v.ui["change-list"].children, list);
    assert.equal(v.ui.kind.value, "changed");
    assert.equal(v.ui.query.value, "keep");
    assert.equal(v.ui.jump.value, "4");
    assert.equal(v.ui.workspace.hidden, false);
    assert.equal(v.ui.detail.hidden, false);
    assert.equal(v.document.URL, url);
    assert.equal(v.document.baseURI, baseURI);
  }
});

test("fresh producer reports round-trip typed paths, whole values, literal keys and category order", async () => {
  const v = viewer();
  const literal = JSON.parse('{"__proto__":{"constructor":"<img src=x onerror=alert(1)>"},"toString":false,"n":null,"s":"","a":[],"o":{}}');
  const cases = [
    [null, null],
    [{ old: literal, items: [null, false, "", [], {}, 0, "tail"] }, { new: literal, items: [false, "", [], {}, null, 1] }],
    [{ nest: { "0": { "a/b": 0 }, "": 1, "~.": 2 } }, { nest: { "0": { "a/b": 1 }, "": 0, "~.": 3 } }],
    [false, literal],
    [["root replacement"], { array: [1, false, "", null, [], {}] }],
  ];
  for (const [before, after] of cases) {
    const bytes = Buffer.from(producerReport(before, after));
    const expected = JSON.parse(bytes);
    assert.deepEqual(plain(v.parseReport(bytes)), expected);
    await v.loadFile(reportFile(bytes, "<svg onload=alert(1)>.json"));
    const rows = v.makeRows(v.parseReport(bytes));
    assert.equal(rows.map(row => row.kind).join(","), [
      ...expected.added.map(() => "added"), ...expected.removed.map(() => "removed"), ...expected.changed.map(() => "changed"),
    ].join(","));
    rows.forEach((row, index) => {
      v.selectMatch(index);
      assert.deepEqual(JSON.parse(v.ui.path.textContent), plain(row.entry.path));
      if (row.kind === "added") {
        assert.equal(v.ui["before-title"].textContent, "Before · absent");
        assert.match(v.ui.before.textContent, /not JSON null/);
      } else assert.deepEqual(JSON.parse(v.ui.before.textContent), plain(row.kind === "changed" ? row.entry.before : row.entry.value));
      if (row.kind === "removed") {
        assert.equal(v.ui["after-title"].textContent, "After · absent");
        assert.match(v.ui.after.textContent, /not JSON null/);
      } else assert.deepEqual(JSON.parse(v.ui.after.textContent), plain(row.kind === "changed" ? row.entry.after : row.entry.value));
    });
    assert.match(v.ui["file-name"].textContent, /<svg onload=/);
  }
  assert.equal(v.created.some(element => ["img", "svg", "script"].includes(element.tagName)), false);
  assert.equal(vm.runInContext("({}).polluted", v.context), undefined);
});

test("all JSON types, absence, root and ambiguous-looking segments stay explicit", async () => {
  const v = viewer();
  const values = [null, false, "", [], {}, 0, 1.25, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
  const kinds = ["null", "boolean", "string", "array", "object", "number", "number", "number", "number"];
  const report = { added: [{ path: ["new"], value: null }], removed: [{ path: ["old"], value: null }], changed: values.map((value, index) => ({ path: [String(index)], before: value, after: values[(index + 1) % values.length] })) };
  await v.loadFile(reportFile(encode(report)));
  assert.equal(v.ui["after-title"].textContent, "After · null");
  v.selectMatch(1);
  assert.equal(v.ui["before-title"].textContent, "Before · null");
  values.forEach((value, index) => {
    v.selectMatch(index + 2);
    assert.equal(v.ui["before-title"].textContent, "Before · " + kinds[index]);
    assert.deepEqual(JSON.parse(v.ui.before.textContent), value);
  });
  for (const segments of [[], ["0"], [0], [""], ["a/b", "~", "a.b", "__proto__", "constructor", "toString"]]) {
    await v.loadFile(reportFile(encode(changed(null, false, segments))));
    assert.equal(v.ui.path.textContent, JSON.stringify(segments));
    assert.equal(v.ui["root-path"].hidden, segments.length !== 0);
    assert.equal(v.ui.segments.children.length, segments.length);
    segments.forEach((segment, index) => assert.match(v.ui.segments.children[index].textContent, typeof segment === "string" ? /Object key \(string\)/ : /Array index \(number\)/));
  }
});

test("invisible, Unicode, markup and prototype-like strings remain complete inert JSON text", async () => {
  const v = viewer();
  const text = 'é😀\u0000"\\\n\u202e\u2066\u200d\u2028\ud800</script><script>globalThis.polluted=true</script>';
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":null},"toString":"literal"}');
  value.text = text;
  await v.loadFile(reportFile(Buffer.from(producerReport(null, value))));
  assert.deepEqual(JSON.parse(v.ui.after.textContent), value);
  assert.match(v.ui.after.textContent, /\\u202e/);
  assert.match(v.ui.after.textContent, /\\ud800/);
  assert.equal(v.ui.after.children.length, 0);
  assert.equal(vm.runInContext("globalThis.polluted", v.context), undefined);
  assert.equal(vm.runInContext("({}).polluted", v.context), undefined);
  assert.equal(v.valueType(null), "null");
  assert.equal(v.valueType([]), "array");
});

test("malformed bytes, shape, fields, paths and numbers fail with bounded data-free errors", () => {
  const v = viewer();
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xc3, 0x28]), Buffer.from("\ufeff{}"), Buffer.from("  "), Buffer.from("{} trailing"), Buffer.from("{}{}")]) assert.throws(() => v.parseReport(bytes));
  for (const value of [null, [], 1, {}, { ...empty, added: {} }, { ...empty, extra: "secret" }, { ...empty, changed: [null] }, { ...empty, added: [{ path: [], before: null }] }, { ...empty, changed: [{ path: [], before: 1 }] }, { ...empty, changed: [{ path: [], before: 1, after: 2, value: "secret" }] }]) {
    assert.throws(() => v.parseReport(encode(value)), error => !error.message.includes("secret"));
  }
  for (const segments of [null, "/a", [null], [true], [{}], [[]], [-1], [0.5], [9007199254740992], Array(65).fill("x")]) {
    assert.throws(() => v.parseReport(encode(changed(0, 1, segments))), /path/);
  }
  for (const number of ["1e400", "9007199254740992", "-9007199254740992"]) {
    const report = '{"added":[{"path":["n"],"value":{"deep":[' + number + ']}}],"removed":[],"changed":[]}';
    assert.throws(() => v.parseReport(Buffer.from(report)), /finite.*safe/);
  }
  assert.deepEqual(plain(v.parseReport(Buffer.from('{"added":null,"added":[],"removed":[],"changed":[]}'))), empty);
  assert.equal(Object.hasOwn(v.parseReport(encode(changed(null, JSON.parse('{"__proto__":null}')))).changed[0].after, "__proto__"), true);
});

test("inclusive report byte boundary is a real producer report, not the smaller input bound", async () => {
  const v = viewer();
  const limit = 262144;
  const before = "b".repeat(131070); // Exactly 131072 input bytes, including quotes.
  const overhead = encode(changed("", "")).length;
  const after = "a".repeat(limit - overhead - before.length);
  assert.equal(Buffer.byteLength(JSON.stringify(before)), 131072);
  assert.ok(Buffer.byteLength(JSON.stringify(after)) <= 131072);
  const bytes = Buffer.from(producerReport(before, after));
  assert.equal(bytes.length, limit);
  assert.deepEqual(plain(v.parseReport(bytes)), changed(before, after));
  await v.loadFile(reportFile(bytes));
  assert.equal(JSON.parse(v.ui.before.textContent), before);
  assert.equal(JSON.parse(v.ui.after.textContent), after);
  assert.throws(() => v.parseReport(Buffer.concat([bytes, Buffer.from(" ")])), /262144/);
  const unicode = Buffer.from(producerReport("é".repeat(65000), false));
  assert.ok(unicode.length > unicode.toString().length);
  assert.equal(v.parseReport(unicode).changed[0].before.length, 65000);
});

test("absolute source depth includes paths but excludes report wrappers", () => {
  const v = viewer();
  const nest = (value, count) => { for (let i = 0; i < count; i++) value = { x: value }; return value; };
  for (const [before, after] of [[nest(0, 64), nest(1, 64)], [nest(0, 64), null], [nest(0, 64), nest(null, 32)]]) {
    const bytes = Buffer.from(producerReport(before, after));
    assert.deepEqual(plain(v.parseReport(bytes)), JSON.parse(bytes));
  }
  assert.throws(() => v.parseReport(encode(changed(nest(0, 33), null, Array(32).fill("x")))), /depth/);
  assert.throws(() => v.parseReport(encode(changed(nest(0, 65), null))), /depth/);
  // Reject deeply nested malformed input iteratively before stringifying it.
  const deep = '{"added":[],"removed":[],"changed":[{"path":[],"before":null,"after":' + '['.repeat(2000) + '0' + ']'.repeat(2000) + '}]}';
  assert.throws(() => v.parseReport(Buffer.from(deep)), /depth/);
});

test("per-side value budgets and maximum producer visits do not lose valid entries", async () => {
  const v = viewer();
  const before = Array(9999).fill(0);
  const after = { children: Array(9998).fill(1) };
  const twoSides = Buffer.from(producerReport(before, after));
  assert.deepEqual(plain(v.parseReport(twoSides)), JSON.parse(twoSides));
  await v.loadFile(reportFile(twoSides));
  assert.deepEqual(JSON.parse(v.ui.before.textContent), before);
  assert.deepEqual(JSON.parse(v.ui.after.textContent), after);
  assert.throws(() => v.parseReport(encode(changed(null, Array(10000).fill(0)))), /after: reported values/);
  assert.throws(() => v.parseReport(encode({ added: [], removed: [{ path: ["old"], value: Array(5000).fill(0) }], changed: [{ path: ["new"], before: Array(5000).fill(0), after: null }] })), /before: reported values/);
  assert.throws(() => v.parseReport(encode({ ...empty, added: Array(10001).fill(null) })), /entries/);
  const many = Buffer.from(producerReport([], before)); // Root + 9999 visits; 10000 right-side values.
  assert.ok(many.length <= 262144);
  assert.equal(v.parseReport(many).added.length, 9999);
  await v.loadFile(reportFile(many));
  assert.equal(v.ui["change-list"].children.length, 100);
  assert.match(v.ui.totals.textContent, /Total 9999$/);
  v.selectMatch(9998);
  assert.equal(v.ui.path.textContent, "[9998]");
  assert.equal(v.ui["change-list"].children.length, 99);
  assert.match(v.ui["detail-title"].textContent, /9999 of 9999/);
});

test("filters search full values literally without sorting, and clear unmatched details", async () => {
  const v = viewer();
  const report = { added: [{ path: ["z"], value: "BEGIN" }, { path: ["a"], value: "far".repeat(2000) + "[Needle].*" }], removed: [{ path: ["x"], value: "needle" }], changed: [{ path: ["Needle"], before: 0, after: 1 }] };
  await v.loadFile(reportFile(encode(report)));
  assert.deepEqual(plain(v.makeRows(v.parseReport(encode(report))).map(row => row.entry.path)), [["z"], ["a"], ["x"], ["Needle"]]);
  v.ui.query.value = "NEEDLE"; v.ui.query.fire("input");
  assert.equal(v.ui["change-list"].children.length, 3);
  assert.equal(v.ui.path.textContent, '["a"]');
  v.ui.query.value = "[needle].*"; v.ui.query.fire("input");
  assert.equal(v.ui["change-list"].children.length, 1);
  assert.equal(JSON.parse(v.ui.after.textContent), report.added[1].value);
  v.ui.kind.value = "removed"; v.ui.kind.fire("change");
  assert.equal(v.ui.workspace.hidden, true);
  assert.match(v.ui.empty.textContent, /No changes match/);
  for (const id of ["path", "before", "after", "segments", "detail-title"]) assert.equal(v.ui[id].textContent, "");
  assert.equal(v.ui.filters.disabled, false);
  v.ui["reset-filters"].fire("click");
  assert.equal(v.ui.workspace.hidden, false);
  assert.equal(v.ui["change-list"].children.length, 4);
  assert.equal(v.ui.path.textContent, '["z"]');
  v.selectMatch(1);
  v.ui.query.value = "far"; v.ui.query.fire("input");
  assert.equal(v.ui.path.textContent, '["a"]');
});

test("wired navigation handles pages, boundaries, jumps and list key events", async () => {
  const v = viewer();
  const report = { ...empty, added: Array.from({ length: 205 }, (_, index) => ({ path: [index], value: index })) };
  await v.loadFile(reportFile(encode(report)));
  assert.equal(v.ui.previous.disabled, true);
  v.ui.next.fire("click"); assert.equal(v.ui.path.textContent, "[1]");
  v.ui.previous.fire("click"); assert.equal(v.ui.path.textContent, "[0]");
  v.ui["next-page"].fire("click"); assert.equal(v.ui.path.textContent, "[100]");
  v.ui["next-page"].fire("click"); assert.equal(v.ui["change-list"].children.length, 5);
  assert.equal(v.ui["next-page"].disabled, true);
  v.ui["previous-page"].fire("click"); assert.equal(v.ui.path.textContent, "[100]");
  v.selectMatch(99);
  let button = v.ui["change-list"].children[99].firstElementChild;
  assert.equal(button.fire("keydown", { key: "ArrowDown" }).prevented, true);
  assert.equal(v.ui.path.textContent, "[100]");
  assert.equal(v.document.activeElement, v.ui["change-list"].children[0].firstElementChild);
  v.document.activeElement.fire("keydown", { key: "End" });
  assert.equal(v.ui.path.textContent, "[204]");
  assert.equal(v.ui.next.disabled, true);
  v.document.activeElement.fire("keydown", { key: "Home" });
  assert.equal(v.ui.path.textContent, "[0]");
  assert.equal(v.document.activeElement.fire("keydown", { key: "ArrowDown", ctrlKey: true }).prevented, false);
  assert.equal(v.document.activeElement.fire("keydown", { key: "Tab" }).prevented, false);
  v.ui.jump.value = "205";
  assert.equal(v.ui["jump-form"].fire("submit").prevented, true);
  assert.equal(v.ui.path.textContent, "[204]");
  assert.equal(v.document.activeElement, v.ui["detail-title"]);
  for (const invalid of ["", "0", "206", "2.5", "NaN"]) {
    v.ui.jump.value = invalid; v.ui["jump-form"].fire("submit");
    assert.equal(v.ui.path.textContent, "[204]");
  }
  button = v.ui["change-list"].children[0].firstElementChild;
  button.fire("click"); assert.equal(v.ui.path.textContent, "[200]");
  assert.equal(v.document.activeElement, v.ui["detail-title"]);
});

test("invalid, unreadable and empty reports clear accepted state; actual reads are bounded", async () => {
  const v = viewer();
  const good = reportFile(encode(changed(null, { private: "old content" })));
  const failures = [
    [reportFile(Buffer.from("not JSON")), /Invalid JSON/],
    [reportFile(Buffer.alloc(0)), /File is empty/],
    [reportFile(encode({ ...empty, changed: [{}] })), /expected exactly/],
    [{ name: "unreadable", size: 1, slice() { throw new Error("private OS path"); } }, /Could not read/],
    [{ name: "rejected read", size: 1, slice() { return { arrayBuffer: () => Promise.reject(new Error("private OS path")) }; } }, /Could not read/],
    [{ name: "oversize", size: 262145, slice() { assert.fail("must not read"); } }, /262144/],
    [{ name: "grew", size: 1, slice(start, end) { assert.equal(start, 0); assert.equal(end, 262145); return { arrayBuffer: async () => new ArrayBuffer(262145) }; } }, /262144/],
  ];
  for (const [file, message] of failures) {
    await v.loadFile(good);
    await v.loadFile(file);
    assert.match(v.ui.status.textContent, message);
    assert.doesNotMatch(v.ui.status.textContent, /private OS path/);
    assert.equal(v.ui["report-file"].attributes.get("aria-invalid"), "true");
    assert.equal(v.ui.workspace.hidden, true);
    assert.equal(v.ui.filters.disabled, true);
    assert.equal(v.ui.totals.hidden, true);
    for (const id of ["path", "before", "after", "segments", "detail-title", "change-list", "totals"]) assert.equal(v.ui[id].textContent, "");
  }
  await v.loadFile(reportFile(encode(empty)));
  assert.match(v.ui.empty.textContent, /valid empty report/);
  assert.match(v.ui.status.textContent, /No differences/);
  assert.equal(v.ui["report-file"].attributes.get("aria-invalid"), "false");
  assert.match(v.ui.totals.textContent, /Total 0$/);
  await v.loadFile(good);
  assert.equal(v.ui.workspace.hidden, false);
});

test("asynchronous old success/failure cannot replace newer files, errors or a cleared viewer", async () => {
  const v = viewer();
  const oldBytes = encode(changed(0, "old"));
  const newFile = reportFile(encode(changed(0, "new")));
  for (const outcome of ["resolve", "reject"]) {
    for (const replacement of [newFile, reportFile(Buffer.from("invalid")), { name: "oversize", size: 262145 }, null]) {
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      const oldFile = { name: "old", size: oldBytes.length, slice: () => ({ arrayBuffer: () => pending }) };
      await v.loadFile(newFile);
      const oldLoad = v.loadFile(oldFile);
      assert.equal(v.ui.after.textContent, ""); // Cleared before read settles.
      await v.loadFile(replacement);
      const snapshot = [v.ui.status.textContent, v.ui.after.textContent, v.ui["file-name"].textContent, v.ui.workspace.hidden];
      if (outcome === "resolve") resolve(Uint8Array.from(oldBytes).buffer);
      else reject(new Error("stale read failure"));
      await oldLoad;
      assert.deepEqual([v.ui.status.textContent, v.ui.after.textContent, v.ui["file-name"].textContent, v.ui.workspace.hidden], snapshot);
    }
  }
  v.ui["report-file"].files = [newFile]; v.ui["report-file"].value = "synthetic.json";
  v.ui["report-file"].fire("change");
  await new Promise(setImmediate);
  assert.equal(v.ui.after.textContent, '"new"');
  assert.equal(v.ui["report-file"].value, "");
  v.ui["report-file"].files = []; v.ui["report-file"].fire("change");
  assert.equal(v.ui.after.textContent, '"new"');
  v.ui.clear.fire("click");
  assert.equal(v.ui.after.textContent, "");
  assert.equal(v.ui.workspace.hidden, true);
  assert.equal(v.ui["file-name"].textContent, "No report selected.");
});
