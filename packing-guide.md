# Packing guide

Before printing the label:

1. Check that the item count matches the order.
2. Pack the items securely with suitable cushioning, then seal the parcel.
3. Check that the delivery address is complete and matches the order.

## Recording checklist completion

Use `packingChecklistStatus` from `packing-checklist.js` to report caller-recorded
marks for the steps above. The IDs are `count` for step 1, `packing` for step 2,
and `address` for step 3. For example, `packingChecklistStatus(["count"])` returns
`complete: false` with the packing and address instructions still pending, in
that order. All three IDs are required for `complete: true`; duplicate marks do
not change the result.

These marks do not verify that the steps were physically performed. The helper
does not validate numeric counts, inspect a parcel or address, format labels,
authorize printing or dispatch, or assign work. Follow the instructions above
independently of the recorded status.

See the [README](README.md#packing-checklist-status) for the full contract,
consumer example, input errors, and result independence guarantees.
