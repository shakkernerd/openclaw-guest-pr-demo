"use strict";

/**
 * Formats a parcel count as an item label (for example, "1 item" or "3 items").
 * The number 1, the exact string "1", and the BigInt 1n use the singular form.
 */
function parcelLabel(count) {
  return `${count} ${count === 1 || count === "1" || count === 1n ? "item" : "items"}`;
}

module.exports = { parcelLabel };
