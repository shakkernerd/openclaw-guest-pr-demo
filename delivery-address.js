"use strict";

/**
 * Joins caller-supplied lines with LF, preserving accepted text and order.
 * Requires a nonempty array of nonblank strings without embedded line breaks.
 * Throws TypeError for nonarrays, missing entries, or nonstring entries;
 * RangeError for an empty array, blank lines, or embedded line breaks.
 * Formats plain text only: no address verification, HTML escaping, or dispatch
 * authorization. Does not mutate the input.
 */
function formatDeliveryAddress(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError("lines must be an array of strings");
  }
  if (lines.length === 0) {
    throw new RangeError("lines must not be empty");
  }

  const labelLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!Object.hasOwn(lines, index)) {
      throw new TypeError("lines[" + index + "] must not be missing");
    }
    const line = lines[index];
    if (typeof line !== "string") {
      throw new TypeError("lines[" + index + "] must be a string");
    }
    if (line.trim().length === 0) {
      throw new RangeError("lines[" + index + "] must not be blank");
    }
    if (/[\n\r\v\f\u0085\u2028\u2029]/u.test(line)) {
      throw new RangeError("lines[" + index + "] must not contain line breaks");
    }
    labelLines.push(line);
  }

  return labelLines.join("\n");
}

module.exports = { formatDeliveryAddress };
