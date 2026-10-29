# Changelog

- Tighten file input with native JSON.parse source-context quantity spelling
  checks and a small duplicate-member-name guard. Reject rounded fractional
  tokens and silently overwritten object members, document the limits of
  already-parsed library values, and add raw-text/real-CLI regression cases.
- Add optional stock-on-hand snapshots, requested/available/missing quantities
  by requested SKU, prominent shortage warnings, and exit code 4 with a complete
  JSON/text report. Preserve no-stock v1 output and all requested order quantities;
  never reserve or allocate stock. Add enough-stock/shortage examples and tests.
- Add a dependency-free donation dispatch manifest library and Node CLI, JSON
  validation, aggregated pick lists, carton labels, stable JSON/text outputs,
  synthetic sample files, volunteer instructions, and regression/CLI tests.
- Preserve the existing parcelLabel export and outputs unchanged.
- Remote-advance fixture commit for the continuation test.
