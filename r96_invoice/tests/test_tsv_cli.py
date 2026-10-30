import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from r96_invoice import calculate_totals


ROOT = Path(__file__).resolve().parents[2]
HEADER = "sku\tquantity\tunit_price_cents\n"


class TSVCommandTests(unittest.TestCase):
    def invoke(self, *args, module="r96_invoice.tsv"):
        return subprocess.run(
            [sys.executable, "-m", module, *args],
            cwd=ROOT, capture_output=True, text=True, timeout=10,
        )

    def run_input(self, content):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invoice input.tsv"
            path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
            return self.invoke(str(path))

    def assert_failure(self, result, message):
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn("r96_invoice.tsv: error:", result.stderr)
        self.assertIn(message, result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_report_matches_shared_calculator_and_json_command(self):
        items = [
            {"sku": "PEN", "quantity": 3, "unit_price_cents": 125},
            {"sku": "BOOK", "quantity": 2, "unit_price_cents": 999},
        ]
        result = self.run_input(HEADER + "PEN\t3\t125\nBOOK\t2\t999\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), calculate_totals(items))
        self.assertEqual(json.loads(result.stdout)["invoice_total_cents"], 2373)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            path.write_text(json.dumps(items), encoding="utf-8")
            original = self.invoke(str(path), module="r96_invoice")
        self.assertEqual(original.returncode, 0, original.stderr)
        self.assertEqual(result.stdout, original.stdout)

    def test_header_only_is_empty_invoice(self):
        for content in (HEADER, HEADER.rstrip("\n")):
            with self.subTest(content=content):
                result = self.run_input(content)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {
                    "lines": [], "invoice_total_cents": 0,
                })

    def test_zero_values_and_leading_zeros(self):
        result = self.run_input(HEADER + "A\t0\t100\nB\t5\t0\nC\t002\t003\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual([line["line_total_cents"] for line in report["lines"]], [0, 0, 6])
        self.assertEqual(report["invoice_total_cents"], 6)
        for line in report["lines"]:
            for field in ("quantity", "unit_price_cents", "line_total_cents"):
                self.assertIs(type(line[field]), int)

    def test_unicode_skus_order_duplicates_and_exact_large_totals(self):
        price = 2**60 + 1
        result = self.run_input(HEADER + f"café\t3\t{price}\ncafé\t1\t7\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), calculate_totals([
            {"sku": "café", "quantity": 3, "unit_price_cents": price},
            {"sku": "café", "quantity": 1, "unit_price_cents": 7},
        ]))

    def test_crlf_and_missing_final_newline(self):
        result = self.run_input(HEADER.replace("\n", "\r\n") + "A\t2\t50")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["invoice_total_cents"], 100)

    def test_standard_quoted_tsv_fields(self):
        result = self.run_input(HEADER + '"A\t""special"""\t"2"\t"50"\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["lines"][0], {
            "sku": 'A\t"special"', "quantity": 2, "unit_price_cents": 50,
            "line_total_cents": 100,
        })

    def test_numeric_text_must_contain_only_ascii_digits(self):
        invalid = (
            "-1", "-0", "+1", "1.0", "0.5", "1e2", "1_000", "0x10",
            "true", "null", "NaN", "Infinity", "", " ", " 1", "1 ", "١", "１２",
        )
        for index, field in ((1, "quantity"), (2, "unit_price_cents")):
            for value in invalid:
                row = ["A", "1", "100"]
                row[index] = value
                with self.subTest(field=field, value=value):
                    self.assert_failure(
                        self.run_input(HEADER + "\t".join(row) + "\n"),
                        f"line 2: {field}",
                    )

    def test_missing_or_incorrect_headers(self):
        cases = (
            "", "\n", "A\t1\t100\n", "sku,quantity,unit_price_cents\n",
            "sku\tquantity\n", "sku\tquantity\tquantity\n",
            "quantity\tsku\tunit_price_cents\n",
            "SKU\tquantity\tunit_price_cents\n",
            "sku\tquantity\tunit_price_cents\textra\n",
        )
        for content in cases:
            with self.subTest(content=content):
                self.assert_failure(self.run_input(content), "line 1: expected tab-separated header")

    def test_missing_extra_and_blank_columns(self):
        for row in ("A\n", "A\t1\n", "A\t1\t100\textra\n", "A\t1\t100\t\n", "\n"):
            with self.subTest(row=row):
                self.assert_failure(self.run_input(HEADER + row), "line 2: expected 3 columns")

    def test_empty_or_whitespace_skus(self):
        for sku in ("", "   "):
            with self.subTest(sku=sku):
                self.assert_failure(self.run_input(HEADER + sku + "\t1\t100\n"), "line 2: sku")

    def test_later_invalid_row_has_no_partial_report(self):
        result = self.run_input(HEADER + "A\t1\t100\nB\t-1\t100\n")
        self.assert_failure(result, "line 3: quantity")

    def test_malformed_quoting(self):
        for row in ('"unterminated\t1\t100\n', '"A"unexpected\t1\t100\n'):
            with self.subTest(row=row):
                self.assert_failure(self.run_input(HEADER + row), "line 2: malformed TSV row")

    def test_line_numbers_after_multiline_quoted_sku(self):
        content = HEADER + '"multi\nline"\t1\t100\nB\t-1\t100\n'
        self.assert_failure(self.run_input(content), "line 4: quantity")

    def test_json_input_is_not_accepted(self):
        self.assert_failure(self.run_input("[]"), "line 1: expected tab-separated header")

    def test_invalid_utf8(self):
        self.assert_failure(self.run_input(b"\xff"), "decode")

    def test_missing_file_and_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assert_failure(self.invoke(str(Path(directory) / "missing.tsv")), "missing.tsv")
            self.assert_failure(self.invoke(directory), "error")

    def test_missing_argument(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("usage:", result.stderr)

    def test_help(self):
        result = self.invoke("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn("TSV", result.stdout)
        self.assertIn("JSON", result.stdout)

    def test_csv_output_option_is_not_added(self):
        result = self.invoke("input.tsv", "--format", "csv")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("unrecognized arguments", result.stderr)


if __name__ == "__main__":
    unittest.main()
