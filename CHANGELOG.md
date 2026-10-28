# Changelog

## Unreleased

- Integrate the public packaging (#7) and corrected fulfillment/HTML (#8)
  contributions with an explicit plan → record → validate → report workflow.
  Keep both APIs, CLI defaults, domain rules, and existing tests intact.
- Share only exact-number JSON boundary scanning; retain `parseBatchJson` values
  and diagnostics, and extend escape-heavy string handling to planning.
- Check both packing modes through real CLI handoffs, explicit records, corrections,
  duplicate assignments, and text/JSON/HTML report agreement.

- Report stdout write failures (including full devices and closed pipes) as exit 2
  with a diagnostic in every format; preserve complete successful output flushing.
- Accept deeply nested ignored metadata without recursive JSON revival, retaining
  exact quantity-token checks, native JSON semantics, and existing validation.

- Add offline `--html` packing reports with ready/blocked sections, labeled native
  keyboard disclosures, escaped text, quantities, and actionable issues. Include
  a runnable HTML example; preserve text/JSON/stdin validation and exit behavior.

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
