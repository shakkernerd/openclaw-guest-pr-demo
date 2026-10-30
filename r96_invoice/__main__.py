"""JSON-only command-line interface for r96_invoice."""

import argparse
import json
import sys

from . import calculate_totals


def _reject_constant(value):
    raise ValueError(f"{value} is not a valid JSON number")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Calculate invoice totals in integer cents from a JSON array."
    )
    parser.add_argument("input", help="path to a UTF-8 JSON invoice file")
    args = parser.parse_args(argv)

    try:
        with open(args.input, encoding="utf-8") as source:
            items = json.load(source, parse_constant=_reject_constant)
        report = calculate_totals(items)
        # Serialize before writing so invalid input never produces a partial report.
        output = json.dumps(report, indent=2, allow_nan=False)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"r96_invoice: error: {exc}", file=sys.stderr)
        return 1

    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
