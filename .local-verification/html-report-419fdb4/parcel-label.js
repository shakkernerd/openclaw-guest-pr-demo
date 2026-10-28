"use strict";

/**
 * Formats a parcel count as an item label (for example, "1 item" or "3 items").
 */
function parcelLabel(count) {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

module.exports = { parcelLabel };
