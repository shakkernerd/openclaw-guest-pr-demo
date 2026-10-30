# Offline returns summary

A dependency-free Python 3.10+ command for reconciling return exports. Uses only
the standard library (`csv`, `json`, `argparse`, `unittest`); no installation,
network access, or services. Python 3.11 is available in this project runtime.

From the repository root:

```sh
python3 e20-project-continuity/returns_summary.py e20-project-continuity/sample-returns.csv
python3 e20-project-continuity/returns_summary.py e20-project-continuity/sample-returns.csv --format markdown
python3 e20-project-continuity/returns_summary.py e20-project-continuity/sample-returns.csv --format csv
cat e20-project-continuity/sample-returns.csv | python3 e20-project-continuity/returns_summary.py -
python3 e20-project-continuity/test_returns_summary.py
```

All formats go to stdout; errors go to stderr with exit status 2 and **no report**.
Success exits 0. The command never writes files. To save reports without
overwriting existing files, use shell noclobber in a subshell:

```sh
(set -C; python3 e20-project-continuity/returns_summary.py e20-project-continuity/sample-returns.csv > e20-project-continuity/summary.json)
(set -C; python3 e20-project-continuity/returns_summary.py e20-project-continuity/sample-returns.csv --format markdown > e20-project-continuity/report.md)
(set -C; python3 e20-project-continuity/returns_summary.py e20-project-continuity/sample-returns.csv --format csv > e20-project-continuity/summary.csv)
```

## Input contract

- UTF-8 CSV, optional BOM, comma delimiter; quoted commas, quotes, and embedded
  newlines work. The header must contain exactly `return_id,sku,reason,units,refund_cents`,
  each once, in any order. Header names are exact and case-sensitive.
- All five values are required; surrounding value whitespace is trimmed. IDs,
  SKUs, and reasons are case-sensitive. Physical blank rows are skipped. Wrong
  field counts, extra/missing/duplicate headers, and malformed quoting are errors.
- `units` is a positive ASCII base-10 integer. `refund_cents` is a nonnegative
  ASCII base-10 integer: no signs, currency symbols, decimals, commas, or exponent
  notation. Zero refunds are valid. Refunds are **total per return**, not per unit.
  All records must use the same currency; the CSV has no currency field.
- Money uses exact integer arithmetic, never floating point. Report consumers must
  also preserve integer precision for large totals. CSV fields are subject to
  Python's standard parser size limits. Python also limits decimal integer
  parsing/formatting (normally 4,300 digits); exceeding that limit in a field
  or an aggregate produces a clean error, not a partial report.
- A repeated `return_id` is ignored only when SKU, reason, units, and refund
  match after trimming and integer parsing (`01` equals `1`). Otherwise the whole
  input fails, with the duplicate ID and source line numbers. Duplicate counts
  are deliberately omitted: repeating an export produces the same summary.
- An empty file is invalid; a header-only file produces zero totals and empty
  groups. The entire input is validated before any report is emitted.

## Output

JSON contains `totals`, `by_sku`, and `by_reason`. Totals and groups contain
`returns` (unique IDs), `units`, and `refund_cents`; each group also carries its
`sku` or `reason`. Groups are sorted by case-sensitive Unicode code-point order,
with fixed key order, indentation, UTF-8 encoding, and a final newline. No
format includes timestamps or filenames; row order and identical duplicates do
not change output. Markdown escapes imported labels and displays cents explicitly.

### CSV summary

`--format csv` emits one row per SKU, combining all reasons, with this stable
header and column order:

```csv
sku,returns,units,refund_cents
```

- `sku` is the validated SKU; rows use case-sensitive Unicode code-point order.
- `returns` counts unique return IDs; `units` sums returned units.
- `refund_cents` sums per-return refunds in exact integer cents, not per-unit
  amounts. All three numeric columns are plain base-10 integers.
- There are no overall-total or per-reason rows. A header-only input produces
  only the CSV header. Use JSON or Markdown for overall and per-reason totals.
- Output is UTF-8 without a BOM, comma-delimited, with CRLF record terminators
  (including the final record). Fields containing commas, double quotes, CR or
  LF are quoted; embedded double quotes are doubled. Embedded line breaks and
  Unicode are preserved. Read with a CSV parser, not by splitting on lines or
  commas; in Python, open saved CSV with `encoding="utf-8", newline=""`.
- As with the other formats, validation and rendering finish before stdout is
  written: invalid input or an unformattable value emits no header or partial rows.

The sample command above prints:

```csv
sku,returns,units,refund_cents
BAG-CANVAS-NAT,2,2,9000
MUG-CERAMIC-WHT,2,3,5400
STICKER-PACK,1,1,0
TSHIRT-NAVY-M,3,4,9996
```

CSV contains summary rows, not return records, so it is not an input file for
this command. When importing into a spreadsheet, treat SKU as text and preserve
integer precision for large numeric values; CSV quoting does not disable formula
interpretation by spreadsheet software.

The sample has nine data rows, including one identical duplicate: **8 unique
returns, 10 units, 24,396 refund cents**. `sample-summary.json` and
`sample-report.md` are saved examples generated by the real command.

Memory usage grows with unique return IDs and grouping keys. This is a local
batch reconciliation tool, not a persistent returns database. Tests execute the
actual CLI in subprocesses; temporary test files stay inside this directory and
are removed afterward. No existing project files or dependencies are changed.
