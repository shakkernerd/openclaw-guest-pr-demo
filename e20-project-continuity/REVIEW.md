# Technical verification

Verified on 2026-10-30 with Python 3.11.2 and Node.js v24.22.1.
All commands below run from the repository root; no dependencies were installed.

## Commands and results

```sh
python3 e20-project-continuity/test_returns_summary.py
node --test
```

- Python suite: 18 tests passed, no failures or skips; exit status 0. Tests invoke
  the actual CLI in subprocesses rather than mocking its processing path.
- Existing Node.js suite: 3 tests passed, no failures or skips; exit status 0.
- The sample reconciles to 8 unique returns, 10 units, and 24,396 refund cents.
  Tests confirm both saved examples match fresh JSON and Markdown command output.

## Coverage

- Required fields and headers, row widths, invalid integer units and money,
  malformed CSV, invalid UTF-8, missing paths, and CLI usage errors.
- Exact totals and grouping; refunds counted per return rather than per unit.
- Idempotent identical duplicates, normalized duplicates, conflicts in SKU,
  reason, units, and refund, and row-order independence in both output formats.
- File/stdin parity, BOMs, CRLF, reordered headers, quoted multiline fields,
  Unicode, blank rows, and header-only inputs.
- Markdown escaping, unchanged input files, and no partial report on invalid
  input; oversized integers and aggregates fail without tracebacks.

## Remaining limitations

- Runtime verification covers Python 3.11.2 only, not every supported Python
  version or operating system. No large-export performance benchmark was run.
- Memory grows with unique return IDs and grouping keys. Standard Python CSV
  field-size and decimal integer conversion limits still apply.
- Records must share one currency; the CSV has no currency field. The tool does
  not validate returns against an external inventory or orders database.
