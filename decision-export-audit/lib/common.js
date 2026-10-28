"use strict";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 128;
const MEANING = "Review decisions only; not source changes, approval of sales, dispatches or operational actions.";
const LIMITATIONS = Object.freeze([
  "Review report only: never applies, merges, or authorizes decisions or operational actions.",
  "Declared evidence hashes, paths, sizes, and dates are unverified claims; referenced evidence is never opened or fetched.",
  "Matching hashes do not prove source identity, integrity, shared history, or authorization.",
  "Revision numbers and timestamps are reported independently, not used to infer lineage, precedence, or a winner.",
  "A groupKey match is only a candidate correspondence; changed evidence may describe different underlying events.",
]);
const pointer = (base, key) => base + "/" + String(key).replace(/~/g, "~0").replace(/\//g, "~1");
const compareKeys = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const diagnostic = (code, path, message, extra = {}) => ({ severity: "error", code, path, message, ...extra });

module.exports = { MAX_BYTES, MAX_DEPTH, MEANING, LIMITATIONS, pointer, compareKeys, clone, isObject, diagnostic };
