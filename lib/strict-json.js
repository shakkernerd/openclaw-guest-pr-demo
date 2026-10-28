"use strict";

class BriefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BriefError";
    this.code = code;
  }
}

function fail(code, message) { throw new BriefError(code, message); }

function asBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    fail("INPUT_TYPE", `${label}: supply raw Buffer or Uint8Array bytes, not parsed JSON or text`);
  }
  return Buffer.from(value);
}

// Canonical decimal value, not floating-point arithmetic. Allows 1.0/1e0,
// rejects e.g. 9007199254740993 and 0.10000000000000001 being rounded.
function decimal(token) {
  const [mantissa, exponent = "0"] = token.toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ""] = unsigned.split(".");
  let digits = (whole + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  let scale = BigInt(exponent) - BigInt(fraction.length);
  const zeros = digits.match(/0+$/)?.[0].length ?? 0;
  if (zeros) { digits = digits.slice(0, -zeros); scale += BigInt(zeros); }
  return `${negative ? "-" : ""}${digits}e${scale}`;
}

function parseJson(bytes, label) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { fail("INVALID_UTF8", `${label}: invalid UTF-8`); }
  if (source.charCodeAt(0) === 0xfeff) fail("INVALID_JSON", `${label}: UTF-8 BOM is not supported`);
  // Native syntax validation first. The second pass detects ambiguous keys and
  // numeric loss, which JSON.parse alone would silently accept.
  let value;
  try { value = JSON.parse(source); }
  catch { fail("INVALID_JSON", `${label}: malformed JSON`); }
  let pos = 0;
  const ws = () => { while (/[ \t\r\n]/.test(source[pos] ?? "x")) pos++; };
  function string() {
    const start = pos++;
    while (source[pos] !== '"') {
      if (source[pos] === "\\") pos++;
      pos++;
    }
    pos++;
    return JSON.parse(source.slice(start, pos));
  }
  function scan(depth) {
    if (depth > 128) fail("JSON_DEPTH", `${label}: JSON nesting exceeds 128 levels`);
    ws();
    if (source[pos] === "{") {
      pos++; ws();
      const keys = new Set();
      if (source[pos] === "}") { pos++; return; }
      while (true) {
        ws();
        const key = string();
        if (keys.has(key)) fail("DUPLICATE_KEY", `${label}: duplicate JSON member ${JSON.stringify(key)}`);
        keys.add(key);
        ws(); pos++; // colon (syntax was checked above)
        scan(depth + 1); ws();
        if (source[pos++] === "}") return;
      }
    }
    if (source[pos] === "[") {
      pos++; ws();
      if (source[pos] === "]") { pos++; return; }
      while (true) {
        scan(depth + 1); ws();
        if (source[pos++] === "]") return;
      }
    }
    if (source[pos] === '"') { string(); return; }
    const token = source.slice(pos).match(/^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/)[0];
    if (/^[-0-9]/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number) || Object.is(number, -0) ||
          (Number.isInteger(number) && !Number.isSafeInteger(number)) ||
          decimal(token) !== decimal(String(number))) {
        fail("UNSAFE_NUMBER", `${label}: numeric value ${token} cannot be preserved exactly; unsupported number`);
      }
    }
    pos += token.length;
  }
  scan(0);
  return value;
}

module.exports = { BriefError, fail, asBytes, parseJson };
