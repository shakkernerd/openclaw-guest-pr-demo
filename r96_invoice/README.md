# r96_invoice: JSON-input invoice totals

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
the JSON report to standard output by default (or with `--format json`):

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

### CSV report output

Select CSV output with `--format csv`; the input file is still JSON:

```sh
python -m r96_invoice input.json --format csv
# Or save it:
python -m r96_invoice input.json --format csv > report.csv
```

For the example above, the report is:

```csv
sku,quantity,unit_price_cents,line_total_cents
PEN,3,125,375
BOOK,2,999,1998
TOTAL,,,2373
```

The header always has these four columns in this order. Each input item becomes
one row, followed by a final `TOTAL` row with blank quantity and unit-price cells
and the invoice total in `line_total_cents`. An empty invoice emits the header
and `TOTAL,,,0`. A line item whose SKU is `TOTAL` is still an ordinary item; the
summary is always the final row with the two blank cells.

CSV quoting preserves SKU values, including commas, quotes, and embedded
newlines. Numeric cells are exact decimal integers, with prices and totals in
cents, never floating-point values. All input is validated before any output,
including the header, is written.

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
- An empty array produces `{"lines": [], "invoice_total_cents": 0}` in JSON mode
  or the header and zero-valued `TOTAL` row in CSV mode.
- Invalid input or file-reading errors produce a diagnostic on standard error,
  exit status **1**, and no report on standard output. Validation errors identify
  the 1-based line-item position and offending field where applicable.
- Command usage errors exit with status **2**; success and `--help` exit with **0**.

The main command accepts **JSON files only** and emits **JSON by default** or
**CSV** with `--format csv`. `--format` controls output only; the main command
does not accept CSV or TSV input. For TSV input, use the separate companion:

```sh
python3 -m r96_invoice.tsv input.tsv
```

The companion emits the same JSON report using the shared integer-cent
calculator. See [TSV.md](TSV.md) for its header, numeric-text validation, and
error-handling rules. It does not accept an output-format option.

Neither command provides TSV output, standard-input mode, tax, discounts,
currency conversion, or decimal prices. Unsupported output formats are command
usage errors.

## Tests

From the repository root, run the standard-library suite:

```sh
python -m unittest discover -v
```

Or select only this package's tests:

```sh
python -m unittest discover -s r96_invoice/tests -v
```

Tests cover exact arithmetic, zero and empty invoices, default and explicit JSON
output, CSV columns/totals/quoting, large integers, and the real
`python -m r96_invoice` command via subprocesses. Validation, malformed JSON,
CSV/TSV input rejection, and file/encoding errors are checked across both output
formats. Separate TSV command tests and combined-format regression tests verify
that TSV input, JSON input, and CSV reports agree on totals, including empty
invoices, special-character SKUs, and large integers.
Tests use temporary files and require no third-party test runner.
The existing JavaScript tests remain runnable separately with `node --test`.
