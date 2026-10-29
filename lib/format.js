"use strict";

const { parcelLabel } = require("../parcel-label.js");

function formatCartonLabel(order) {
  return [
    "DONATION DISPATCH",
    `Order: ${order.id}`,
    "Carton: 1 of 1",
    `To: ${order.recipient}`,
    ...order.address.lines,
    order.address.postcode,
    order.address.country,
    "Contents:",
    ...order.items.map((item) => `  ${item.quantity} x ${item.sku} — ${item.name}`),
    `Total: ${parcelLabel(order.totalUnits)}`,
  ].join("\n");
}

function formatStockCheck(stockCheck) {
  const lines = [
    "",
    stockCheck.hasShortages
      ? "STOCK SHORTAGE — DO NOT PACK THIS BATCH"
      : "STOCK CHECK — ENOUGH STOCK FOR THIS BATCH",
    "On-hand snapshot; omitted SKUs count as zero. No stock has been reserved.",
    ...stockCheck.items.map((item) => `  ${item.sku} | Requested: ${item.requested} | Available: ${item.available} | Missing: ${item.missing}${item.missing > 0 ? " [SHORT]" : ""}`),
  ];
  if (stockCheck.items.length === 0) lines.push("  No requested SKUs to check.");
  if (stockCheck.hasShortages) {
    lines.push("Resolve shortages with the stockroom coordinator before packing.",
      "Order quantities are unchanged; no stock has been allocated to recipients.");
  }
  return lines;
}

function formatReport(manifest) {
  const { totals } = manifest;
  const lines = [
    "DONATION STOCKROOM — DISPATCH MANIFEST",
    `Orders: ${totals.orders} | Cartons: ${totals.cartons} | SKUs: ${totals.distinctSkus} | Total: ${parcelLabel(totals.units)}`,
    ...(manifest.stockCheck ? formatStockCheck(manifest.stockCheck) : []),
    "",
    "PICK LIST (combined quantities; sorted by SKU)",
    ...manifest.pickList.map((item) => `  ${item.quantity} x ${item.sku} — ${item.name} | Location: ${item.location ?? "not recorded"}`),
  ];
  if (totals.orders === 0) {
    lines.push("  No orders to dispatch.");
  } else {
    lines.push("", manifest.stockCheck?.hasShortages
      ? "CARTON LABELS — PLANNING ONLY; DO NOT USE UNTIL SHORTAGES ARE RESOLVED"
      : "CARTON LABELS (one carton per order; confirm everything fits)");
    for (const order of manifest.orders) {
      lines.push("", "----------------------------------------", order.carton.label);
    }
  }
  return `${lines.join("\n")}\n`;
}

module.exports = { formatCartonLabel, formatReport };
