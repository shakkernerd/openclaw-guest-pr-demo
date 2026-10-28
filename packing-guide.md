# Packing guide

Before printing the label:

1. Check that the item count matches the order.
2. Pack the items securely with suitable cushioning, then seal the parcel.
3. Check that the delivery address is complete and matches the order.

For proposed box contents and utilization, first use `packaging-cli.js` as shown
in the [plan-to-record workflow](README.md#plan-record-validate-report). Its mixed
or single-SKU plan is guidance, not evidence of actual packing. Assign IDs and
record only physically checked parcel contents; never automatically treat proposed
boxes or a utilization summary as recorded fulfillment. Planning accepts zero
quantities, while fulfillment requires positive quantities and non-empty item lists.

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

For automation, use `node fulfill.js --json path/to/shipments.json`, or pipe an
export into `node fulfill.js --json -`. Check the exit code first: 0 and 1 provide
a JSON report with overall `valid`, `ready`/`blocked` counts, shipment results,
and actionable error codes/paths; exit 2 provides a stderr diagnostic. Output-write
failures can leave an incomplete report: discard it, fix the destination, and retry.
Never treat a failed command or an invalid batch root as an empty successful batch.

For a browser-readable checklist, run

```sh
node fulfill.js --html path/to/shipments.json > packing-report.html
```

Open the report locally, or preview [the saved sample](examples/shipments.report.html).
Exit 1 still produces a complete report: inspect the expanded blocked shipments
and their correction messages. Tab to a shipment summary and press Enter or
Space to toggle details. Ready/blocked section links provide quick navigation.
This offline snapshot sends no data and does not revalidate when opened; correct
the source batch and regenerate the report before dispatch. Keep the output file
separate from your input, since shell redirection overwrites its destination. If
the command exits 2 because output could not be written, do not use a partial HTML
file; correct the output destination and regenerate it.
