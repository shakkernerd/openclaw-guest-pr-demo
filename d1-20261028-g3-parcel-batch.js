"use strict";

const { parcelLabel } = require("./parcel-label.js");

/**
 * Formats an array of nonnegative safe integer numbers without coercion.
 */
function parcelLabels(counts) {
  if (!Array.isArray(counts)) {
    throw new TypeError("counts must be an array");
  }

  const labels = [];
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index];
    if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count)) {
      throw new TypeError(`counts[${index}] must be a finite integer number`);
    }
    if (count < 0 || !Number.isSafeInteger(count)) {
      throw new RangeError(`counts[${index}] must be a nonnegative safe integer`);
    }
    labels.push(parcelLabel(count));
  }
  return labels;
}

module.exports = { parcelLabels };
