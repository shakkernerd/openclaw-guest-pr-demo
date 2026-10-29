"use strict";

const { ManifestError } = require("./errors.js");

function parseJsonInput(source, filePath) {
  // Native JSON.parse remains responsible for the entire JSON grammar.
  // Its source context lets us reject decimal/exponent quantity tokens before
  // accepting a rounded Number. This is a notation rule, not a decimal parser.
  const result = JSON.parse(source, (key, value, context) => {
    if (key === "quantity" && typeof value === "number") {
      if (typeof context?.source !== "string") {
        throw new ManifestError("UNSUPPORTED_RUNTIME",
          "File quantity checks require Node.js 22+ with JSON.parse source context.", 1);
      }
      if (!/^-?(0|[1-9][0-9]*)$/.test(context.source)) {
        throw new ManifestError("INVALID_INPUT", JSON.stringify(filePath)
          + ": quantity must use plain integer notation (for example 1, not 1.0 or 1e0)."
          + " Decimal points and exponents are not accepted, even if Number would round to an integer.");
      }
    }
    return value;
  });

  // JSON.parse keeps only the last duplicate member and a reviver cannot see
  // discarded members. Scan the ORIGINAL, already syntax-checked text solely
  // for object scope and member names. Strings are consumed whole so braces,
  // colons and escaped quotes inside values cannot affect the scope stack.
  const scopes = [];
  let lastString;
  for (const token of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:]/g)) {
    const text = token[0];
    if (text === "{") scopes.push(new Set());
    else if (text === "[") scopes.push(null);
    else if (text === "}" || text === "]") scopes.pop();
    else if (text[0] === '"') lastString = token;
    else if (text === ":") {
      // Valid JSON guarantees a member-name string immediately before a colon.
      // Decode with Node so "orders" and "\u006frders" are the same name.
      const name = JSON.parse(lastString[0]);
      const names = scopes.at(-1);
      if (names.has(name)) {
        throw new ManifestError("DUPLICATE_MEMBER", JSON.stringify(filePath)
          + ": duplicate JSON member " + JSON.stringify(name)
          + " near character " + (lastString.index + 1)
          + ". Keep each member name only once within an object.");
      }
      names.add(name);
    }
  }
  return result;
}

module.exports = { parseJsonInput };
