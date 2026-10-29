"use strict";

const { validateCatalogue, validateOrders, addQuantities } = require("./validate.js");
const { formatCartonLabel } = require("./format.js");

// Code-unit order is deterministic across machines, independent of locale.
function bySku(left, right) {
  return left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0;
}

function createManifest(catalogueDocument, ordersDocument) {
  const catalogue = validateCatalogue(catalogueDocument);
  const validatedOrders = validateOrders(ordersDocument, catalogue);
  const picks = new Map();
  let units = 0;
  const orders = validatedOrders.map((order) => {
    const contents = new Map();
    let totalUnits = 0;
    for (const line of order.items) {
      const product = catalogue.get(line.sku);
      const path = `order ${JSON.stringify(order.id)}`;
      totalUnits = addQuantities(totalUnits, line.quantity, `${path} total`);
      units = addQuantities(units, line.quantity, "manifest total");
      const current = contents.get(line.sku);
      contents.set(line.sku, {
        sku: line.sku,
        name: product.name,
        quantity: addQuantities(current?.quantity ?? 0, line.quantity, `${path} SKU ${JSON.stringify(line.sku)}`),
      });
      const picked = picks.get(line.sku);
      picks.set(line.sku, {
        ...product,
        quantity: addQuantities(picked?.quantity ?? 0, line.quantity, `pick list SKU ${JSON.stringify(line.sku)}`),
      });
    }
    const result = {
      id: order.id,
      recipient: order.recipient,
      address: order.address,
      items: [...contents.values()].sort(bySku),
      totalUnits,
    };
    return { ...result, carton: { number: 1, total: 1, label: formatCartonLabel(result) } };
  });
  return {
    schemaVersion: 1,
    totals: { orders: orders.length, cartons: orders.length, distinctSkus: picks.size, units },
    pickList: [...picks.values()].sort(bySku),
    orders,
  };
}

module.exports = { createManifest };
