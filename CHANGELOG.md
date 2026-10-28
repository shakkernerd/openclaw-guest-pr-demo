# Changelog

## Unreleased

- Add `--json` reports and `-` stdin input for fulfillment automation, preserving
  default text output, validation protections, and exit codes. Include a checked
  JSON report example and file/pipe regression coverage.
- Fix rounded fractional JSON quantities incorrectly passing packing validation;
  check original numeric tokens and retain exact integer decimal/exponent forms.
- Add Node-only packing validation for per-SKU shortages/excess, duplicate parcel
  and shipment assignments, and malformed or unsafe quantities.
- Add `node fulfill.js <shipments.json>` with ready/blocked summaries, actionable
  errors, and documented exit codes; retain existing parcel-label behavior.
- Add a realistic executable batch example and validator/CLI regression tests.

- Remote-advance fixture commit for the continuation test.
