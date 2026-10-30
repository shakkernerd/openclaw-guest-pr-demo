import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
FORMATS = ((), ("--format", "json"), ("--format", "csv"))
CSV_HEADER = ["sku", "quantity", "unit_price_cents", "line_total_cents"]


class CommandTests(unittest.TestCase):
    def invoke(self, *args, text=True):
        return subprocess.run(
            [sys.executable, "-m", "r96_invoice", *args],
            cwd=ROOT, capture_output=True, text=text, timeout=10,
        )

    def run_input(self, content, *args, text=True):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invoice input.json"
            path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
            return self.invoke(str(path), *args, text=text)

    def assert_failure(self, result, message):
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn("r96_invoice: error:", result.stderr)
        self.assertIn(message, result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def assert_input_failure(self, content, message):
        for args in FORMATS:
            with self.subTest(format=args):
                self.assert_failure(self.run_input(content, *args), message)

    def test_module_command_outputs_complete_json_report(self):
        items = [
            {"sku": "PEN", "quantity": 3, "unit_price_cents": 125},
            {"sku": "BOOK", "quantity": 2, "unit_price_cents": 999},
        ]
        result = self.run_input(json.dumps(items))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), {
            "lines": [dict(items[0], line_total_cents=375), dict(items[1], line_total_cents=1998)],
            "invoice_total_cents": 2373,
        })
        explicit = self.run_input(json.dumps(items), "--format", "json")
        self.assertEqual(explicit.returncode, 0, explicit.stderr)
        self.assertEqual(explicit.stderr, "")
        self.assertEqual(explicit.stdout, result.stdout)

    def test_csv_report_columns_rows_and_total(self):
        items = [
            {"sku": "PEN", "quantity": 3, "unit_price_cents": 125},
            {"sku": "BOOK", "quantity": 2, "unit_price_cents": 999},
        ]
        result = self.run_input(json.dumps(items), "--format", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(result.stdout,
                         "sku,quantity,unit_price_cents,line_total_cents\n"
                         "PEN,3,125,375\nBOOK,2,999,1998\nTOTAL,,,2373\n")

    def test_csv_empty_invoice(self):
        result = self.run_input("[]", "--format", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))),
                         [CSV_HEADER, ["TOTAL", "", "", "0"]])

    def test_csv_zero_values_duplicate_skus_and_extra_fields(self):
        items = [
            {"sku": "A", "quantity": 0, "unit_price_cents": 100, "note": "ignored"},
            {"sku": "A", "quantity": 5, "unit_price_cents": 0},
            {"sku": "TOTAL", "quantity": 2, "unit_price_cents": 7},
        ]
        result = self.run_input(json.dumps(items), "--format", "csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(list(csv.reader(io.StringIO(result.stdout))), [
            CSV_HEADER, ["A", "0", "100", "0"], ["A", "5", "0", "0"],
            ["TOTAL", "2", "7", "14"], ["TOTAL", "", "", "14"],
        ])

    def test_csv_quoting_unicode_and_large_integers(self):
        price = 2**60 + 1
        skus = [' café, "large" ', "line\nbreak", "carriage\rreturn", "both\r\nbreaks", "tab\there"]
        items = [{"sku": sku, "quantity": 3, "unit_price_cents": price} for sku in skus]
        # Capture bytes so universal-newline decoding cannot alter SKU contents.
        result = self.run_input(json.dumps(items, ensure_ascii=False),
                                "--format", "csv", text=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        rows = list(csv.reader(io.StringIO(result.stdout.decode("utf-8"), newline="")))
        self.assertEqual(rows, [CSV_HEADER] + [
            [sku, "3", str(price), str(3 * price)] for sku in skus
        ] + [["TOTAL", "", "", str(len(skus) * 3 * price)]])

    def test_empty_invoice(self):
        result = self.run_input("[]")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"lines": [], "invoice_total_cents": 0})

    def test_unicode_sku_and_large_integer_round_trip(self):
        price = 2**60 + 1
        result = self.run_input(json.dumps([
            {"sku": "café", "quantity": 3, "unit_price_cents": price},
        ], ensure_ascii=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["lines"][0]["sku"], "café")
        self.assertEqual(report["invoice_total_cents"], 3 * price)

    def test_invalid_quantities_and_prices(self):
        for field in ("quantity", "unit_price_cents"):
            for value in (-1, 0.5, 1.0, True, False, "2", None, [], {}):
                item = {"sku": "A", "quantity": 1, "unit_price_cents": 100}
                item[field] = value
                with self.subTest(field=field, value=value):
                    self.assert_input_failure(json.dumps([item]), field)

    def test_invalid_structures_and_missing_fields(self):
        cases = [
            ({}, "array"), (None, "array"), ([1], "object"), ([{}], "sku"),
            ([{"sku": "A"}], "quantity"),
            ([{"sku": "A", "quantity": 1}], "unit_price_cents"),
            ([{"sku": "", "quantity": 1, "unit_price_cents": 1}], "sku"),
        ]
        for value, message in cases:
            with self.subTest(value=value):
                self.assert_input_failure(json.dumps(value), message)

    def test_invalid_skus(self):
        for sku in ("", " \t\n", None, 1, True, [], {}):
            with self.subTest(sku=sku):
                self.assert_input_failure(json.dumps([
                    {"sku": sku, "quantity": 1, "unit_price_cents": 100},
                ]), "sku")

    def test_bad_later_line_has_no_partial_report(self):
        self.assert_input_failure(json.dumps([
            {"sku": "A", "quantity": 1, "unit_price_cents": 100},
            {"sku": "B", "quantity": -1, "unit_price_cents": 100},
        ]), "line 2: quantity")

    def test_malformed_json_and_non_json_formats(self):
        for content in ("", "[{", "[] trailing", "sku,quantity,unit_price_cents\nA,1,100",
                        "sku\tquantity\tunit_price_cents\nA\t1\t100"):
            with self.subTest(content=content):
                self.assert_input_failure(content, "error")

    def test_nonstandard_json_numbers(self):
        for value in ("NaN", "Infinity", "-Infinity"):
            content = '[{"sku":"A","quantity":1,"unit_price_cents":' + value + '}]'
            with self.subTest(value=value):
                self.assert_input_failure(content, "not a valid JSON number")

    def test_exponential_numbers_are_rejected(self):
        for field in ("quantity", "unit_price_cents"):
            content = '[{"sku":"A","quantity":1,"unit_price_cents":1}]'
            content = content.replace('"' + field + '":1', '"' + field + '":1e2')
            with self.subTest(field=field):
                self.assert_input_failure(content, field)

    def test_invalid_utf8(self):
        self.assert_input_failure(b"\xff", "decode")

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            for args in FORMATS:
                with self.subTest(format=args):
                    result = self.invoke(str(Path(directory) / "missing.json"), *args)
                    self.assert_failure(result, "missing.json")

    def test_directory_instead_of_file(self):
        with tempfile.TemporaryDirectory() as directory:
            for args in FORMATS:
                with self.subTest(format=args):
                    self.assert_failure(self.invoke(directory, *args), "error")

    def test_missing_argument(self):
        for args in FORMATS:
            with self.subTest(format=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertIn("usage:", result.stderr)

    def test_help(self):
        result = self.invoke("--help")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertIn("JSON", result.stdout)
        self.assertIn("--format {json,csv}", result.stdout)
        self.assertIn("default: json", result.stdout)

    def test_unsupported_format_option(self):
        result = self.invoke("input.json", "--format", "tsv")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("invalid choice", result.stderr)

    def test_missing_format_value(self):
        result = self.invoke("input.json", "--format")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("expected one argument", result.stderr)


if __name__ == "__main__":
    unittest.main()
