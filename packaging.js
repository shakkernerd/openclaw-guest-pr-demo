"use strict";

// This API materializes every box; reject impractical output before allocation.
const MAX_BOXES = 100000;

/**
 * Combine exact SKU strings in first-appearance order, then fill boxes in order.
 * Quantities must be non-negative safe integers; capacity must be positive.
 * Returns fresh { maxItemsPerBox, totalItems, boxes } data without mutating items.
 * Throws TypeError for invalid fields and RangeError for total/output overflow.
 */
function planPackaging(items, maxItemsPerBox) {
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }
  if (!Number.isSafeInteger(maxItemsPerBox) || maxItemsPerBox <= 0) {
    throw new TypeError("maxItemsPerBox must be a positive safe integer");
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

  // Avoid adding capacity to totalItems, which could overflow safe integers.
  const boxCount = Math.floor(totalItems / maxItemsPerBox) + (totalItems % maxItemsPerBox === 0 ? 0 : 1);
  if (boxCount > MAX_BOXES) {
    throw new RangeError("packing plan exceeds " + MAX_BOXES + " boxes; increase maxItemsPerBox or split the order");
  }

  const boxes = [];
  let currentBox;
  for (const [sku, quantity] of quantities) {
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
  return { maxItemsPerBox, totalItems, boxes };
}

module.exports = { planPackaging, MAX_BOXES };
