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

function formatReport(manifest) {
  const { totals } = manifest;
  const lines = [
    "DONATION STOCKROOM — DISPATCH MANIFEST",
    `Orders: ${totals.orders} | Cartons: ${totals.cartons} | SKUs: ${totals.distinctSkus} | Total: ${parcelLabel(totals.units)}`,
    "",
    "PICK LIST (combined quantities; sorted by SKU)",
    ...manifest.pickList.map((item) => `  ${item.quantity} x ${item.sku} — ${item.name} | Location: ${item.location ?? "not recorded"}`),
  ];
  if (totals.orders === 0) {
    lines.push("  No orders to dispatch.");
  } else {
    lines.push("", "CARTON LABELS (one carton per order; confirm everything fits)");
    for (const order of manifest.orders) {
      lines.push("", "----------------------------------------", order.carton.label);
    }
  }
  return `${lines.join("\n")}\n`;
}

module.exports = { formatCartonLabel, formatReport };
