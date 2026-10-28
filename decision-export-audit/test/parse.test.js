"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { parseExport } = require("../lib");
const { MAX_BYTES, MAX_DEPTH } = require("../lib/common.js");
const { bytes, digest, baseline } = require("../support/fixtures.js");

test("baseline is the exact 10,874-byte attachment, including final LF", () => {
  const raw = bytes();
  assert.equal(raw.length, 10874);
  assert.equal(raw.at(-1), 10);
  assert.equal(createHash("sha256").update(raw).digest("hex"), digest);
  assert.deepEqual(parseExport(raw), { ok: true, value: baseline(), diagnostics: [] });
  assert.equal(parseExport(raw.toString("utf8")).ok, true);
});

for (const text of ["", "{", "[] trailing", '{"x":1,}', "[1,]", '[01]', '[1.]', '[+1]', '[NaN]', '[undefined]', '{unquoted:1}', '"bad\nstring"', '"\\q"', '"unterminated', '[true false]', '\u00a0{}']) {
  test("parser rejects malformed JSON " + JSON.stringify(text), () => {
    const result = parseExport(text);
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    assert.equal(result.diagnostics[0].code, "MALFORMED_JSON");
    assert.equal(typeof result.diagnostics[0].offset, "number");
  });
}

test("parser preserves string escaping, Unicode, CRLF, null, arrays and exponent values", () => {
  const value = { text: ' quote " backslash \\ / é \r\n\t🚚 ', values: [false, true, null, -1.2e4, 0] };
  assert.deepEqual(parseExport(JSON.stringify(value)).value, value);
});

for (const [text, path] of [
  ['{"a":1,"a":2}', "/a"],
  ['{"a":1,"\\u0061":2}', "/a"],
  ['{"items":[{"a/b~":1,"a/b~":2}]}', "/items/0/a~1b~0"],
  ['{"__proto__":1,"__proto__":2}', "/__proto__"],
]) {
  test("duplicate JSON members cannot silently overwrite: " + text, () => {
    const result = parseExport(text);
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    assert.equal(result.diagnostics[0].code, "DUPLICATE_JSON_MEMBER");
    assert.equal(result.diagnostics[0].path, path);
    assert.ok(result.diagnostics[0].firstOffset < result.diagnostics[0].offset);
  });
}

test("numeric rounding cannot turn malformed revisions into valid integers", () => {
  for (const token of ["1.00000000000000000001", "9007199254740991.1", "9007199254740993", "1e-400", "0.10000000000000001"]) {
    const raw = bytes().toString("utf8").replace('"revision":1', '"revision":' + token);
    const result = parseExport(raw);
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    assert.equal(result.diagnostics[0].code, "NUMBER_PRECISION");
    assert.equal(result.diagnostics[0].path, "/decisions/0/revision");
  }
  for (const token of ["1", "1.0", "1e0", "0.01e2", "100e-2"]) {
    assert.equal(parseExport(token).value, 1);
  }
  assert.equal(parseExport("1.25").value, 1.25);
  assert.equal(parseExport("-0e-99999999999999999999").ok, true);
});

test("parser accepts signed zero without modifying its numeric representation", () => {
  for (const token of ["0", "-0", "-0.0", "-0e10"]) {
    const result = parseExport(token);
    assert.equal(result.ok, true);
    assert.equal(Object.is(result.value, -0), token.startsWith("-"));
  }
});

test("__proto__ is data, not prototype mutation", () => {
  const result = parseExport('{"__proto__":{"polluted":true}}');
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.value, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test("invalid UTF-8, BOM, wrong input type, huge and deeply nested input fail explicitly", () => {
  for (const [input, code] of [
    [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"],
    [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "UNEXPECTED_BOM"],
    ["\ufeff{}", "UNEXPECTED_BOM"],
    [null, "INPUT_TYPE"],
    [baseline(), "INPUT_TYPE"],
    [Buffer.alloc(MAX_BYTES + 1), "INPUT_TOO_LARGE"],
    ["[".repeat(MAX_DEPTH + 1) + "0" + "]".repeat(MAX_DEPTH + 1), "MAX_DEPTH"],
    ["1e400", "NUMBER_RANGE"],
  ]) {
    const result = parseExport(input);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, code);
  }
  assert.equal(parseExport("[".repeat(MAX_DEPTH) + "0" + "]".repeat(MAX_DEPTH)).ok, true);
});
