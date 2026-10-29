"use strict";

const { parcelLabel } = require("./parcel-label.js");

/**
 * Validate and label an ordered batch of { id, count } records without mutation.
 * Throws before returning any result if a record or the total is invalid.
 */
function preparePackingBatch(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("batch must be a JSON array");
  }

  const identifiers = new Set();
  const parcels = [];
  let totalItemCount = 0;

  for (const [index, record] of records.entries()) {
    const location = "parcels[" + index + "]";
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, "id") ||
      !Object.hasOwn(record, "count")
    ) {
      throw new TypeError(location + " must be an object with exactly id and count");
    }

    const { id, count } = record;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new TypeError(location + ".id must be a nonempty, non-whitespace string");
    }
    if (identifiers.has(id)) {
      throw new TypeError(location + ".id duplicates an earlier identifier");
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(location + ".count must be a nonnegative safe integer");
    }
    if (count > Number.MAX_SAFE_INTEGER - totalItemCount) {
      throw new RangeError(location + ".count would make totalItemCount exceed Number.MAX_SAFE_INTEGER");
    }

    identifiers.add(id);
    totalItemCount += count;
    parcels.push({ id, count, label: parcelLabel(count) });
  }

  return { parcels, parcelCount: parcels.length, totalItemCount };
}

module.exports = { preparePackingBatch };
