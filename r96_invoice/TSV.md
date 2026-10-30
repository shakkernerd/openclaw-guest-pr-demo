# TSV invoice input companion

Run from the repository root with Python 3; no third-party dependencies are needed:

```sh
python3 -m r96_invoice.tsv input.tsv
```

This separate command reads TSV and reuses `r96_invoice.calculate_totals` to emit
the same JSON report as the existing JSON command. The JSON entry point
(`python3 -m r96_invoice input.json`) is unchanged. This companion does not add
CSV output or modify any CSV functionality.

## Example

The first line must be the header below, with actual tab separators, not spaces.
Create an example file with:

```sh
printf 'sku\tquantity\tunit_price_cents\nPEN\t3\t125\nBOOK\t2\t999\n' > input.tsv
python3 -m r96_invoice.tsv input.tsv
```

The JSON report contains:

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

Each line total is `quantity * unit_price_cents`; the invoice total is the sum.
All monetary arithmetic uses exact integers in cents, not floating point.

## TSV rules

- Use a UTF-8 file with the exact header `sku`, `quantity`, `unit_price_cents`,
  in that order, separated by tabs. Missing, duplicate, reordered, or extra
  headers are rejected.
- Each data record must have exactly three fields. Missing/extra fields and
  blank records are errors, rather than silently skipped.
- `sku` must not be empty or whitespace-only. Its text is preserved. Input
  order and separate rows with duplicate SKUs are preserved.
- After TSV field decoding, both numeric fields must match `[0-9]+`: one or
  more ASCII digits. Zero and leading zeros are accepted (`002` becomes `2`).
  Signs (`-1`, `-0`, `+1`), decimals, exponents, separators, Unicode digits,
  booleans, empty values, and surrounding whitespace are rejected. No values
  are rounded, trimmed, or otherwise coerced.
- Standard double-quoted fields are supported through the standard-library
  TSV reader: quoted fields may contain tabs/newlines; double a quote inside
  a quoted field. Decoded numeric fields still obey the digit-only rule.
  Unterminated quotes and text after a closing quote are errors.
- LF and CRLF line endings are accepted; a final newline is optional.
- A header-only file is a valid empty invoice and produces
  `{"lines": [], "invoice_total_cents": 0}`. An entirely empty file is invalid.

## Errors and output

Success prints only JSON on stdout and exits with status **0**. Input or file
errors print `r96_invoice.tsv: error: ...` on stderr, exit with status **1**,
and produce no partial report. Row errors identify the starting physical file
line (header is line 1) and the offending field where applicable, for example:

```text
r96_invoice.tsv: error: line 3: quantity must be non-negative whole-number text (0-9 only)
```

Command usage errors exit with status **2**. Use
`python3 -m r96_invoice.tsv --help` for help (status **0**).

To save the JSON output:

```sh
python3 -m r96_invoice.tsv input.tsv > report.json
```

Use a different output filename: redirecting to the input file would truncate it.
This command takes a file path, not stdin, and provides no output-format option.

## Tests

Run just the separate TSV command tests:

```sh
python3 -m unittest r96_invoice.tests.test_tsv_cli -v
```

Run all Python tests, including the unchanged JSON command tests:

```sh
python3 -m unittest discover -v
```

The focused tests invoke the actual module in subprocesses, compare its report
with the shared calculator and JSON command, and cover invalid numeric text,
headers, row widths, quoting, file errors, empty invoices, and exact large totals.
