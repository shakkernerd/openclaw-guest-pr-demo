"""JSON-input command with JSON (default) or CSV invoice reports."""

import argparse
import csv
import io
import json
import sys

from . import calculate_totals


def _reject_constant(value):
    raise ValueError(f"{value} is not a valid JSON number")


def _csv_report(report):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=(
        "sku", "quantity", "unit_price_cents", "line_total_cents",
    ))
    writer.writeheader()
    writer.writerows(report["lines"])
    writer.writerow({"sku": "TOTAL", "line_total_cents": report["invoice_total_cents"]})
    return output.getvalue()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Calculate invoice totals in integer cents from a JSON array."
    )
    parser.add_argument("input", help="path to a UTF-8 JSON invoice file")
    parser.add_argument("--format", choices=("json", "csv"), default="json",
                        help="report output format (default: json); input is always JSON")
    args = parser.parse_args(argv)

    try:
        with open(args.input, encoding="utf-8") as source:
            items = json.load(source, parse_constant=_reject_constant)
        report = calculate_totals(items)
        # Serialize before writing so invalid input never produces a partial report.
        if args.format == "csv":
            output = _csv_report(report)
        else:
            output = json.dumps(report, indent=2, allow_nan=False) + "\n"
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"r96_invoice: error: {exc}", file=sys.stderr)
        return 1

    sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
