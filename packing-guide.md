# Packing guide

Before printing the label:

1. Check that the item count matches the order.
2. Pack the items securely with suitable cushioning, then seal the parcel.
3. Check that the delivery address is complete and matches the order.

For batch work, record ordered and packed quantities by SKU using the JSON format
in [README.md](README.md), then run:

```sh
node fulfill.js path/to/shipments.json
```

Do not dispatch a `BLOCKED` shipment. Pack the reported missing quantities, remove
excess or unordered items, and resolve reused parcel IDs. Parcel IDs must identify
one assignment across the whole batch; splitting an order requires distinct IDs.
Rerun validation after corrections. Invalid item data must be corrected before
quantity differences can be calculated reliably.

The included `examples/shipments.json` intentionally contains one blocked order
to demonstrate the correction workflow. A `READY` result only confirms the recorded
packing data: still perform the physical packing, address, and label checks above.
