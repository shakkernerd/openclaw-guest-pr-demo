"""Read TSV invoice items and emit the shared integer-cent JSON report."""

import argparse
import csv
import json
import re
import sys

from . import InvoiceError, calculate_totals


_COLUMNS = ("sku", "quantity", "unit_price_cents")


def _next_row(reader):
    """Read a record, identifying its starting physical line on parse errors."""
    line = reader.line_num + 1
    try:
        return line, next(reader, None)
    except csv.Error as exc:
        raise InvoiceError(f"line {line}: malformed TSV row: {exc}") from exc


def read_items(source):
    """Convert a tab-delimited text stream to shared-calculator line items."""
    reader = csv.reader(source, delimiter="\t", strict=True)
    _, header = _next_row(reader)
    if header != list(_COLUMNS):
        raise InvoiceError(
            "line 1: expected tab-separated header: sku, quantity, unit_price_cents"
        )

    items = []
    while True:
        line, row = _next_row(reader)
        if row is None:
            return items
        if len(row) != len(_COLUMNS):
            raise InvoiceError(f"line {line}: expected 3 columns, found {len(row)}")
        item = dict(zip(_COLUMNS, row))
        if not item["sku"].strip():
            raise InvoiceError(f"line {line}: sku must be a non-empty string")
        for field in _COLUMNS[1:]:
            if re.fullmatch(r"[0-9]+", item[field]) is None:
                raise InvoiceError(
                    f"line {line}: {field} must be non-negative whole-number text (0-9 only)"
                )
            try:
                item[field] = int(item[field])
            except ValueError as exc:
                raise InvoiceError(f"line {line}: {field}: {exc}") from exc
        items.append(item)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Calculate integer-cent invoice totals from TSV; output JSON."
    )
    parser.add_argument("input", help="path to a UTF-8 TSV invoice file with a header")
    args = parser.parse_args(argv)

    try:
        with open(args.input, encoding="utf-8", newline="") as source:
            items = read_items(source)
        report = calculate_totals(items)
        output = json.dumps(report, indent=2, allow_nan=False)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"r96_invoice.tsv: error: {exc}", file=sys.stderr)
        return 1

    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
