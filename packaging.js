"use strict";

// Detailed plans materialize every box; summaries do not use this limit.
const MAX_BOXES = 100000;

// Keep validation and first-appearance SKU aggregation identical for both APIs.
function prepareOrder(items, maxItemsPerBox, options = {}) {
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

  return { mode, totalItems, quantities };
}

function summarizeOrder({ mode, totalItems, quantities }, maxItemsPerBox) {
  const capacity = BigInt(maxItemsPerBox);
  const counts = mode === "single-sku" ? quantities.values() : [totalItems];
  let fullBoxes = 0n;
  let partialBoxes = 0n;
  let unusedItemSlots = 0n;
  // Work once per combined SKU (once per order in mixed mode), never per box.
  for (const quantity of counts) {
    const count = BigInt(quantity);
    fullBoxes += count / capacity;
    const remainder = count % capacity;
    if (remainder !== 0n) {
      partialBoxes += 1n;
      unusedItemSlots += capacity - remainder;
    }
  }
  // Each box contains at least one item, so all box counts <= the safe total.
  // Unused slots can exceed that bound; keep them exact and JSON-safe as a string.
  return {
    mode, maxItemsPerBox, totalItems,
    boxCount: Number(fullBoxes + partialBoxes),
    fullBoxes: Number(fullBoxes),
    partialBoxes: Number(partialBoxes),
    unusedItemSlots: unusedItemSlots.toString(),
  };
}

/**
 * Return compact utilization counts without allocating boxes or applying MAX_BOXES.
 * Accepts the same inputs/options as planPackaging; aggregate totals must stay safe.
 * Always includes mode and a decimal-string unusedItemSlots; other counts are numbers.
 */
function summarizePackaging(items, maxItemsPerBox, options = {}) {
  return summarizeOrder(prepareOrder(items, maxItemsPerBox, options), maxItemsPerBox);
}

/**
 * Combine exact SKU strings in first-appearance order, then fill boxes in order.
 * Quantities must be non-negative safe integers; capacity must be positive.
 * options.mode is "mixed" (default) or "single-sku" (never mix different SKUs).
 * Returns fresh { maxItemsPerBox, totalItems, boxes } data without mutating items.
 * Only single-SKU plans add mode: "single-sku", preserving legacy output.
 * Throws TypeError for invalid fields/options and RangeError for total/output overflow.
 */
function planPackaging(items, maxItemsPerBox, options = {}) {
  const order = prepareOrder(items, maxItemsPerBox, options);
  const { mode, totalItems, quantities } = order;
  // Count the actual mode-specific output before allocating any boxes.
  if (summarizeOrder(order, maxItemsPerBox).boxCount > MAX_BOXES) {
    throw new RangeError("packing plan exceeds " + MAX_BOXES + " boxes; increase maxItemsPerBox or split the order");
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

module.exports = { planPackaging, summarizePackaging, MAX_BOXES };
