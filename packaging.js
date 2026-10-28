"use strict";

// This API materializes every box; reject impractical output before allocation.
const MAX_BOXES = 100000;

/**
 * Combine exact SKU strings in first-appearance order, then fill boxes in order.
 * Quantities must be non-negative safe integers; capacity must be positive.
 * options.mode is "mixed" (default) or "single-sku" (never mix different SKUs).
 * Returns fresh { maxItemsPerBox, totalItems, boxes } data without mutating items.
 * Only single-SKU plans add mode: "single-sku", preserving legacy output.
 * Throws TypeError for invalid fields/options and RangeError for total/output overflow.
 */
function planPackaging(items, maxItemsPerBox, options = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }
  if (!Number.isSafeInteger(maxItemsPerBox) || maxItemsPerBox <= 0) {
    throw new TypeError("maxItemsPerBox must be a positive safe integer");
  }

  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const { mode = "mixed" } = options;
  if (mode !== "mixed" && mode !== "single-sku") {
    throw new TypeError('options.mode must be "mixed" or "single-sku"');
  }

  const quantities = new Map();
  let totalItems = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const location = "items[" + index + "]";
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(location + " must be an object");
    }
    const { sku, quantity } = item;
    if (typeof sku !== "string" || sku.trim().length === 0) {
      throw new TypeError(location + ".sku must be a non-empty string");
    }
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new TypeError(location + ".quantity must be a non-negative safe integer");
    }
    if (quantity > Number.MAX_SAFE_INTEGER - totalItems) {
      throw new RangeError("total item count must be a safe integer");
    }
    totalItems += quantity;
    // Insertion order also remembers SKUs first seen with a zero quantity.
    quantities.set(sku, (quantities.get(sku) || 0) + quantity);
  }

  // Count the actual mode-specific output before allocating any boxes.
  // Single-SKU mode cannot reuse the space in another SKU's partial box.
  const counts = mode === "single-sku" ? quantities.values() : [totalItems];
  let boxCount = 0;
  for (const quantity of counts) {
    // Avoid quantity + capacity, which could overflow safe integers.
    const required = Math.floor(quantity / maxItemsPerBox) + (quantity % maxItemsPerBox === 0 ? 0 : 1);
    if (required > MAX_BOXES - boxCount) {
      throw new RangeError("packing plan exceeds " + MAX_BOXES + " boxes; increase maxItemsPerBox or split the order");
    }
    boxCount += required;
  }

  const boxes = [];
  let currentBox;
  for (const [sku, quantity] of quantities) {
    if (mode === "single-sku") currentBox = undefined;
    let remaining = quantity;
    // Work per output entry, not per individual item (counts can be very large).
    while (remaining > 0) {
      if (!currentBox || currentBox.totalItems === maxItemsPerBox) {
        currentBox = { contents: [], totalItems: 0 };
        boxes.push(currentBox);
      }
      const packed = Math.min(remaining, maxItemsPerBox - currentBox.totalItems);
      currentBox.contents.push({ sku, quantity: packed });
      currentBox.totalItems += packed;
      remaining -= packed;
    }
  }
  const plan = { maxItemsPerBox, totalItems, boxes };
  if (mode === "single-sku") plan.mode = mode;
  return plan;
}

module.exports = { planPackaging, MAX_BOXES };
