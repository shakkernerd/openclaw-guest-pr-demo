"""Check TSV input and JSON/CSV reports against the same invoice data."""

import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from r96_invoice import calculate_totals


ROOT = Path(__file__).resolve().parents[2]


class CombinedFormatsTests(unittest.TestCase):
    def assert_formats_agree(self, items):
        with tempfile.TemporaryDirectory() as directory:
            json_path = Path(directory) / "input.json"
            tsv_path = Path(directory) / "input.tsv"
            json_path.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
            with tsv_path.open("w", encoding="utf-8", newline="") as source:
                writer = csv.DictWriter(
                    source, fieldnames=("sku", "quantity", "unit_price_cents"),
                    delimiter="\t",
                )
                writer.writeheader()
                writer.writerows(items)

            commands = {
                "tsv": ["r96_invoice.tsv", str(tsv_path)],
                "default_json": ["r96_invoice", str(json_path)],
                "explicit_json": ["r96_invoice", str(json_path), "--format", "json"],
                "csv": ["r96_invoice", str(json_path), "--format", "csv"],
            }
            outputs = {}
            for name, args in commands.items():
                with self.subTest(command=name):
                    result = subprocess.run(
                        [sys.executable, "-m", *args], cwd=ROOT,
                        capture_output=True, timeout=10,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, b"")
                    outputs[name] = result.stdout.decode("utf-8")

        report = calculate_totals(items)
        for name in ("tsv", "default_json", "explicit_json"):
            with self.subTest(report=name):
                self.assertEqual(json.loads(outputs[name]), report)
        self.assertEqual(outputs["tsv"], outputs["default_json"])
        self.assertEqual(outputs["explicit_json"], outputs["default_json"])

        # Preserve embedded CR/LF characters when reading the CSV result.
        csv_rows = list(csv.reader(io.StringIO(outputs["csv"], newline="")))
        expected = [["sku", "quantity", "unit_price_cents", "line_total_cents"]]
        expected.extend([
            line["sku"], str(line["quantity"]), str(line["unit_price_cents"]),
            str(line["line_total_cents"]),
        ] for line in report["lines"])
        expected.append(["TOTAL", "", "", str(report["invoice_total_cents"])])
        self.assertEqual(csv_rows, expected)

    def test_all_commands_agree_on_empty_invoice(self):
        self.assert_formats_agree([])

    def test_all_commands_agree_on_special_skus_and_exact_totals(self):
        self.assert_formats_agree([
            {"sku": 'café, "quoted"\tline\r\nbreak', "quantity": 3,
             "unit_price_cents": 2**60 + 1},
            {"sku": "duplicate", "quantity": 0, "unit_price_cents": 123},
            {"sku": "duplicate", "quantity": 2, "unit_price_cents": 0},
            {"sku": "TOTAL", "quantity": 2, "unit_price_cents": 7},
        ])


if __name__ == "__main__":
    unittest.main()
