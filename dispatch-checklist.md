# Dispatch checklist

Use this checklist for each order before handing its parcels to the carrier.
If a check fails, hold the affected parcels until the issue is corrected.

The demo’s `parcelLabel(count)` helper formats only a count as text, such as
`1 item` or `3 items`; it does not create an address label or barcode. The
printed-label checks below are manual checks for the dispatch workflow.

## 1. Confirm the recipient and address

- [ ] Match the recipient name on each label to the order, and check it is clearly
  readable.
- [ ] Match the full delivery address to the order, including the street address,
  any required flat or unit number, postcode, and destination country.
- [ ] Resolve missing, unclear, or conflicting details before printing or
  dispatching; do not guess an address correction.

## 2. Match the count and parcels

- [ ] Check the packed item count against the order, following the existing
  [packing guide](packing-guide.md).
- [ ] Count the physical parcels for the order and match that total to the
  expected parcel count. Check each label belongs to the parcel it is attached
  to, especially when an order has multiple parcels.
- [ ] If using the demo helper for the parcel count, pass that same total and
  check the text: `0 items`, `1 item`, or `3 items` for counts 0, 1, or 3. The
  helper calls them "items"; do not confuse the parcel total with the number of
  products packed inside. A `0 items` result is not approval to dispatch.
- [ ] Check for accidental duplicate prints by comparing the printed labels and
  their tracking references with the shipment record. Set aside extra copies;
  never use a duplicate label on another parcel.
- [ ] Resolve any missing, extra, or mismatched parcel before handover.

## 3. Inspect the printed label and barcode

- [ ] Confirm the recipient, address, and any tracking text are fully printed,
  readable, and free of smudges, fading, or clipped edges.
- [ ] Check the whole barcode and the clear space around it are visible, with no
  tears, creases, smears, or overlapping labels.
- [ ] Attach the label securely to a flat surface, not across an edge or seam;
  keep tape and other material from obscuring the text or barcode.
- [ ] Scan the barcode with a suitable scanner when available and match the
  result to the intended shipment. If it fails to scan, hold the parcel and
  investigate rather than assuming the barcode is usable.

## 4. Replace a damaged label

- [ ] Set the affected parcel aside; do not dispatch it with a torn, wet, faded,
  unreadable, or otherwise damaged label.
- [ ] Reprint the correct label from the verified shipment record. Do not redraw
  the barcode or guess missing details; if the correct label cannot be
  recovered, ask the person responsible for dispatch to resolve it.
- [ ] Remove or completely cover the damaged label and any obsolete shipping
  barcodes so only the current shipping label can be read or scanned.
- [ ] Secure the replacement, repeat the recipient, address, count, and
  readability checks above, and scan again when a scanner is available.
- [ ] Release the parcel only after the checks pass.

## 5. Record the final handoff

- [ ] After all checks pass, record who checked each parcel and when, before
  releasing it. Add the carrier and handoff time at collection, then retain the
  completed record with the order’s dispatch record.

- Order reference: ____________________
- Parcel / tracking reference: ____________________
- Checked by (name or staff ID): ____________________
- Checked at (date, time, and time zone): ____________________
- Handed to (carrier / collector): ____________________
- Handoff at (date, time, and time zone): ____________________
