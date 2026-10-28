"use strict";

// Called only with a numeric token from already syntax-validated JSON.
function isIntegerToken(token) {
  const [coefficient, exponent = "0"] = token.toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = (whole + fraction).replace("-", "");
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") end -= 1;
  if (end === 0) return true; // Zero is integral at any exponent.
  const trailingZeros = digits.length - end;
  // The threshold is bounded by token length. Huge exponents may become +/-Infinity
  // here without affecting this comparison; never allocate a power of ten.
  return Number(exponent) >= fraction.length - trailingZeros;
}

function parseOrderJson(source) {
  // Validate syntax FIRST so the token pass cannot repair malformed JSON.
  // No reviver: native parsing handles deeply nested ignored data without a
  // recursive JavaScript walk or a dependency on reviver context.source.
  const parsed = JSON.parse(source);
  const guarded = source.replace(/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token[0] === '"' || !Number.isSafeInteger(Number(token)) || isIntegerToken(token)) return token;
    // Internal invalid-count sentinel: reuse the planner's existing validation
    // only if this value is used. Extra/overwritten fields remain ignored.
    return "null";
  });
  // Native parsing preserves escaped keys and last-property-wins semantics.
  return guarded === source ? parsed : JSON.parse(guarded);
}

// Pure text-to-order boundary shared by both CLIs; field validation stays in packaging.js.
function parseOrder(source) {
  let order;
  try {
    order = parseOrderJson(source);
  } catch {
    throw new Error("input must contain one valid JSON order");
  }
  if (order === null || typeof order !== "object" || Array.isArray(order)) {
    throw new TypeError("order must be an object with items and maxItemsPerBox");
  }
  return order;
}

module.exports = { parseOrder };
