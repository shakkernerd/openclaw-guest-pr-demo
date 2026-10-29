"use strict";

// Compare the whole batch, never allocate scarce stock between recipients.
function checkStock(pickList, stockBySku) {
  const items = pickList.map(({ sku, quantity }) => {
    // A supplied stock file is a snapshot: omitted SKUs mean zero on hand.
    const available = stockBySku.get(sku) ?? 0;
    return {
      sku,
      requested: quantity,
      available,
      missing: Math.max(0, quantity - available),
    };
  });
  return { hasShortages: items.some((item) => item.missing > 0), items };
}

module.exports = { checkStock };
