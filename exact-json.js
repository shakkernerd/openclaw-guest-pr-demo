"use strict";

// Internal JSON boundary helper, not planning or fulfillment validation. Call only
// AFTER native JSON.parse has accepted the source syntax. The caller owns which
// rounded integers to mark and how to interpret the replacement JSON token.
function isIntegerToken(token) {
  const [coefficient, exponent = "0"] = token.toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = (whole + fraction).replace("-", "");
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") end -= 1;
  if (end === 0) return true; // Zero is integral at any exponent.
  const trailingZeros = digits.length - end;
  // The threshold is bounded by token length. Even infinite Number exponents
  // compare correctly here; never expand a power of ten.
  return Number(exponent) >= fraction.length - trailingZeros;
}

function guardIntegerTokens(content, replacement) {
  const parts = [];
  let copied = 0;
  let index = 0;
  const isDigit = character => character >= "0" && character <= "9";
  while (index < content.length) {
    const character = content[index];
    if (character === '"') {
      index += 1;
      while (index < content.length) {
        const next = content[index++];
        if (next === "\\") index += 1; // Skip escaped quotes and backslashes.
        else if (next === '"') break;
      }
    } else if (character === "-" || isDigit(character)) {
      const start = index++;
      while (index < content.length && (isDigit(content[index]) || ".eE+-".includes(content[index]))) index += 1;
      const token = content.slice(start, index);
      const value = Number(token);
      if (Number.isSafeInteger(value) && !isIntegerToken(token)) {
        const marked = replacement(token, value);
        if (marked !== token) {
          parts.push(content.slice(copied, start), marked);
          copied = index;
        }
      }
    } else {
      index += 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(content.slice(copied));
  return parts.join("");
}

module.exports = { guardIntegerTokens };
