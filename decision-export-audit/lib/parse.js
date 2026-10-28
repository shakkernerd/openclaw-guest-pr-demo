"use strict";

const { MAX_BYTES, MAX_DEPTH, pointer, diagnostic } = require("./common.js");

// Compare decimal values, not raw spelling (1, 1.0 and 1e0 are equivalent).
// This prevents fractional revisions rounding to integers or tiny values to zero.
function decimalIdentity(token) {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  let digits = (match[2] + (match[3] || "")).replace(/^0+/, "");
  if (!digits) return "0";
  const trailing = /0*$/.exec(digits)[0].length;
  if (trailing) digits = digits.slice(0, -trailing);
  const exponent = Number(match[4] || 0) - (match[3] || "").length + trailing;
  return match[1] + digits + "e" + exponent;
}

/** Parse data, never filenames. Duplicate members are rejected before any result escapes. */
function parseExport(input) {
  let text;
  const fail = (code, message) => ({ ok: false, value: null, diagnostics: [diagnostic(code, "", message)] });
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    return fail("INPUT_TYPE", "Expected a JSON string or UTF-8 Uint8Array/Buffer, not a parsed value or filename.");
  }
  const size = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (size > MAX_BYTES) return fail("INPUT_TOO_LARGE", "Input exceeds the 16 MiB local limit.");
  try {
    text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return fail("INVALID_UTF8", "Input is not valid UTF-8.");
  }
  if (text.charCodeAt(0) === 0xfeff) return fail("UNEXPECTED_BOM", "UTF-8 BOM is not supported; input is not rewritten.");

  let offset = 0;
  const diagnostics = [];
  function syntax(path, message, code = "MALFORMED_JSON") {
    throw diagnostic(code, path, message, { offset });
  }
  function whitespace() {
    while (offset < text.length && /[ \t\r\n]/.test(text[offset])) offset++;
  }
  function string(path) {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") offset++;
      else if (char === '"') {
        try { return JSON.parse(text.slice(start, offset)); }
        catch { syntax(path, "Invalid JSON string or escape sequence."); }
      }
    }
    syntax(path, "Unterminated JSON string.");
  }
  function value(path, depth) {
    whitespace();
    const char = text[offset];
    if (char === "{" || char === "[") {
      if (depth >= MAX_DEPTH) syntax(path, "Input exceeds 128 nested containers.", "MAX_DEPTH");
      offset++;
      whitespace();
      const object = char === "{";
      const result = object ? {} : [];
      const seen = new Map();
      const close = object ? "}" : "]";
      if (text[offset] === close) { offset++; return result; }
      let index = 0;
      for (;;) {
        whitespace();
        let key = index++;
        let keyOffset = offset;
        if (object) {
          if (text[offset] !== '"') syntax(path, "Expected a quoted object member name.");
          key = string(path);
          whitespace();
          if (text[offset++] !== ":") syntax(pointer(path, key), "Expected ':' after member name.");
        }
        const childPath = pointer(path, key);
        const child = value(childPath, depth + 1);
        if (object) {
          if (seen.has(key)) {
            diagnostics.push(diagnostic("DUPLICATE_JSON_MEMBER", childPath,
              "Duplicate object member; no first/last-write-wins result is returned.",
              { offset: keyOffset, firstOffset: seen.get(key) }));
          } else {
            seen.set(key, keyOffset);
            // Handles __proto__ as data, never as a prototype assignment.
            Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
          }
        } else result.push(child);
        whitespace();
        if (text[offset] === close) { offset++; return result; }
        if (text[offset++] !== ",") syntax(path, "Expected ',' or closing delimiter.");
      }
    }
    if (char === '"') return string(path);
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset));
    if (number) {
      offset += number[0].length;
      const result = Number(number[0]);
      if (!Number.isFinite(result)) syntax(path, "Number is outside the finite JavaScript range.", "NUMBER_RANGE");
      if (decimalIdentity(number[0]) !== decimalIdentity(String(result))) {
        syntax(path, "Number loses decimal precision when represented by JavaScript; input is not rounded into a valid field.", "NUMBER_PRECISION");
      }
      return result;
    }
    syntax(path, "Expected a JSON value.");
  }
  let result;
  try {
    result = value("", 0);
    whitespace();
    if (offset !== text.length) syntax("", "Unexpected content after the JSON value.");
  } catch (error) {
    if (!error || !error.code) throw error;
    diagnostics.push(error);
  }
  return { ok: diagnostics.length === 0, value: diagnostics.length ? null : result, diagnostics };
}

module.exports = { parseExport };
