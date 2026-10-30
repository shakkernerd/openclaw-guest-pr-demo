#!/usr/bin/env python3
"""Summarize validated return records using only the Python standard library."""

import argparse
import csv
import html
import json
import re
import sys
from contextlib import nullcontext


FIELDS = ("return_id", "sku", "reason", "units", "refund_cents")
INTEGER = re.compile(r"[0-9]+")


class InputError(ValueError):
    """A CSV record does not satisfy the documented input contract."""


def parse_integer(value, field, line):
    if not INTEGER.fullmatch(value):
        raise InputError(f"line {line}: {field} must be an unsigned base-10 integer")
    try:
        number = int(value)
    except ValueError as exc:
        raise InputError(f"line {line}: {field} is too large to parse") from exc
    if field == "units" and number == 0:
        raise InputError(f"line {line}: units must be greater than zero")
    return number


def empty_totals():
    return {"returns": 0, "units": 0, "refund_cents": 0}


def add_record(totals, units, refund_cents):
    totals["returns"] += 1
    totals["units"] += units
    totals["refund_cents"] += refund_cents


def summarize(stream):
    reader = csv.reader(stream, strict=True)
    totals = empty_totals()
    by_sku, by_reason, seen = {}, {}, {}
    try:
        header = next(reader, None)
        if not header:
            raise InputError("missing CSV header")
        # Accept UTF-8 BOMs from spreadsheets, including when reading stdin.
        header[0] = header[0].removeprefix("\ufeff")
        if len(header) != len(FIELDS) or set(header) != set(FIELDS):
            raise InputError("header must contain each required column exactly once: "
                             + ", ".join(FIELDS))
        for row in reader:
            line = reader.line_num
            if not row:  # Physical blank lines are harmless; empty fields are not.
                continue
            if len(row) != len(header):
                raise InputError(f"line {line}: expected {len(header)} fields, got {len(row)}")
            record = dict(zip(header, (value.strip() for value in row)))
            for field in FIELDS:
                if not record[field]:
                    raise InputError(f"line {line}: {field} is required")
            units = parse_integer(record["units"], "units", line)
            refund = parse_integer(record["refund_cents"], "refund_cents", line)
            return_id = record["return_id"]
            sku, reason = record["sku"], record["reason"]
            canonical = (sku, reason, units, refund)
            if return_id in seen:
                previous, first_line = seen[return_id]
                if previous != canonical:
                    raise InputError(f"line {line}: conflicting duplicate return_id "
                                     f"{return_id!r} (first seen on line {first_line})")
                continue
            seen[return_id] = (canonical, line)
            add_record(totals, units, refund)
            add_record(by_sku.setdefault(sku, empty_totals()), units, refund)
            add_record(by_reason.setdefault(reason, empty_totals()), units, refund)
    except csv.Error as exc:
        raise InputError(f"line {reader.line_num}: invalid CSV: {exc}") from exc
    return {
        "totals": totals,
        "by_sku": [{"sku": key, **by_sku[key]} for key in sorted(by_sku)],
        "by_reason": [{"reason": key, **by_reason[key]} for key in sorted(by_reason)],
    }


def markdown_cell(value):
    # Escape HTML and Markdown syntax so imported labels remain plain table text.
    value = html.escape(value, quote=False)
    special = chr(92) + chr(96) + "*_{}[]()#+.!|>~=-"
    value = "".join(chr(92) + char if char in special else char for char in value)
    return "<br>".join(value.splitlines())


def markdown_report(summary):
    totals = summary["totals"]
    lines = [
        "# Returns summary",
        "",
        f"- Unique returns: {totals['returns']}",
        f"- Units returned: {totals['units']}",
        f"- Refund total (cents): {totals['refund_cents']}",
        "",
        "Refunds are per-return totals in integer cents, not per-unit amounts.",
    ]
    for section, key, label in (("by_sku", "sku", "SKU"),
                                ("by_reason", "reason", "Reason")):
        lines.extend(["", f"## By {label}", "",
                      f"| {label} | Returns | Units | Refund (cents) |",
                      "| --- | ---: | ---: | ---: |"])
        for group in summary[section]:
            lines.append(f"| {markdown_cell(group[key])} | {group['returns']} | "
                         f"{group['units']} | {group['refund_cents']} |")
        if not summary[section]:
            lines.extend(["", "No returns."])
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Validate and summarize a returns CSV offline.")
    parser.add_argument("input", help="UTF-8 CSV path, or - for stdin")
    parser.add_argument("--format", choices=("json", "markdown"), default="json",
                        help="output format (default: json); written to stdout")
    args = parser.parse_args(argv)
    try:
        if args.input == "-":
            sys.stdin.reconfigure(encoding="utf-8-sig", errors="strict", newline="")
            source = nullcontext(sys.stdin)
        else:
            source = open(args.input, encoding="utf-8-sig", newline="")
        with source as stream:
            summary = summarize(stream)
        try:
            output = (json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
                      if args.format == "json" else markdown_report(summary))
        except ValueError as exc:
            raise InputError("summary exceeds Python's integer formatting limit") from exc
        sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
        sys.stdout.write(output)
        sys.stdout.flush()
    except BrokenPipeError:
        return 0
    except (InputError, OSError, UnicodeError) as exc:
        parser.exit(2, f"returns-summary: error: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
