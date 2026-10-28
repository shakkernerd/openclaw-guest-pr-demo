# Dispatch checklist

Use this checklist for each order before handing parcels to the carrier. Follow
the [packing guide](packing-guide.md), [delivery checks](delivery-checks.md), and
[label checks](label-checks.md) alongside these final checks.

The demo's `parcelLabel(count)` helper in `parcel-label.js` only formats a count
as text; it does not validate addresses, print shipping labels, or generate or
scan barcodes. The shipping-label checks below are manual checks.

## 1. Confirm the recipient and address

- [ ] Match the recipient name on each label to the order or dispatch record.
- [ ] Check that the full delivery address matches the order, including any flat
      or unit number, street address, town or city, postcode, and destination country.
- [ ] Stop and resolve missing, unclear, or conflicting details before dispatch;
      do not guess an address or send a parcel with a known mismatch.

## 2. Match the parcel count

- [ ] Count the sealed parcels for this order and match the total to the dispatch
      record and the count supplied to `parcelLabel(count)`. Check the packed
      item count against the order separately; items and parcels may differ.
- [ ] Confirm the demo count text: `0` gives `0 items`, `1` gives `1 item`, and
      `3` gives `3 items`. These are count strings, not complete shipping labels.
- [ ] If no parcels are present or the count differs, hold the dispatch and
      reconcile the record and physical parcels before proceeding.
- [ ] For a multi-parcel order, check each parcel has its own correct shipping
      label; do not reuse one parcel's label on another.
- [ ] Check for accidentally printing the same label twice: compare each parcel's
      label identifier with the dispatch record. Hold any duplicate-labelled
      parcels and securely discard unused duplicate prints before proceeding.

## 3. Check the printed label and barcode

- [ ] Confirm the recipient, address, and shipment reference are readable, with
      no fading, smudging, clipping, or missing print.
- [ ] Check the whole barcode and its surrounding blank space are visible and
      undamaged. Keep the barcode flat, away from seams, folds, and parcel edges.
- [ ] Secure the label without obscuring text or the barcode; avoid tape or
      wrapping that causes glare across the barcode.
- [ ] Scan the barcode with the normal dispatch scanner and confirm it resolves
      to the expected shipment. If it fails or cannot be checked, hold the parcel
      for the responsible dispatch colleague rather than assuming it is readable.

## 4. Replace a damaged label

- [ ] Hold any parcel with a torn, wet, smudged, peeling, or unreadable label.
- [ ] Reprint the correct label from the verified shipment record using the
      normal carrier workflow; do not redraw a barcode or guess missing details.
- [ ] Remove or fully cover the damaged label and any obsolete shipping barcodes
      so only the current shipping label can be read or scanned.
- [ ] Attach the replacement securely, then repeat the recipient, address, count,
      print-readability, and barcode-scan checks before releasing the parcel.

## 5. Record the final handoff

- [ ] Complete a handoff record for each parcel in the dispatch log after the
      checks pass and before handing it to the carrier:

      - Parcel / shipment reference: ____________________
      - Checked by (name or initials): ____________________
      - Checked at (date, time, and time zone): ____________________
      - Handed to (carrier or colleague) and handoff date/time: ____________________

Dispatch only when every applicable check passes and all discrepancies are resolved.
