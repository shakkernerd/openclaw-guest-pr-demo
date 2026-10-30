# r96_invoice: JSON invoice totals

A small Python 3 standard-library command. No dependencies or installation are
needed: run it from the repository root. Existing project files are unchanged.

## Run

Save this UTF-8 JSON as `input.json`:

```json
[
  {"sku": "PEN", "quantity": 3, "unit_price_cents": 125},
  {"sku": "BOOK", "quantity": 2, "unit_price_cents": 999}
]
```

```sh
python -m r96_invoice input.json
```

Use `python3` instead of `python` if that is your Python 3 executable. Use
`python -m r96_invoice --help` for command help. A successful run prints only
the JSON report to standard output:

```json
{
  "lines": [
    {
      "sku": "PEN",
      "quantity": 3,
      "unit_price_cents": 125,
      "line_total_cents": 375
    },
    {
      "sku": "BOOK",
      "quantity": 2,
      "unit_price_cents": 999,
      "line_total_cents": 1998
    }
  ],
  "invoice_total_cents": 2373
}
```

To save the report: `python -m r96_invoice input.json > report.json`. Use a
different output path: redirecting to the input file would truncate it.

## Input rules and behavior

- The top-level value must be an array of objects. Every object must contain
  `sku`, `quantity`, and `unit_price_cents`.
- `sku` must be a non-empty string, not just whitespace. Its value is preserved.
- Quantity and price must be non-negative JSON integers. Zero is valid. Negative
  values, fractions, `1.0`, exponential notation, booleans, strings, nulls, arrays,
  and objects are rejected for these fields; values are never coerced or rounded.
- Nonstandard JSON constants (`NaN`, `Infinity`, `-Infinity`) are rejected.
- Each line total is quantity times unit price. The invoice total is their sum.
  Arithmetic uses Python integers, never floating-point currency calculations.
- Input order is retained, including separate lines with the same SKU. Extra
  object fields are ignored and are not copied to the report.
- An empty array produces `{"lines": [], "invoice_total_cents": 0}`.
- Invalid input or file-reading errors produce a diagnostic on standard error,
  exit status **1**, and no report on standard output. Validation errors identify
  the 1-based line-item position and offending field where applicable.
- Command usage errors exit with status **2**; success and `--help` exit with **0**.

This version accepts **JSON files only** and emits **JSON only**. It has no CSV
mode, standard-input mode, tax, discount, currency conversion, or decimal prices.

## Tests

From the repository root, run the standard-library suite:

```sh
python -m unittest discover -v
```

Or select only this package's tests:

```sh
python -m unittest discover -s r96_invoice/tests -v
```

Tests cover exact arithmetic, zero and empty invoices, validation, malformed
JSON, file/encoding errors, and the real `python -m r96_invoice` command via
subprocesses. They use temporary files and require no third-party test runner.
The existing JavaScript tests remain runnable separately with `node --test`.
