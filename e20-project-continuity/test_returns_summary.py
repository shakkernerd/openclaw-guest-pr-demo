"""Black-box tests: every assertion exercises the real command in a subprocess."""

import csv
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
COMMAND = [sys.executable, str(HERE / "returns_summary.py")]
HEADER = "return_id,sku,reason,units,refund_cents\n"
FORMATS = ("json", "markdown", "csv")


class ReturnsCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".test-", dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.input_path = Path(self.temp.name) / "returns.csv"

    def run_cli(self, *args, stdin=None, env=None):
        if isinstance(stdin, str):
            stdin = stdin.encode("utf-8")
        result = subprocess.run(
            COMMAND + list(args), input=stdin, capture_output=True, timeout=10,
            cwd=self.temp.name,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **(env or {})},
        )
        result.stdout = result.stdout.decode("utf-8")
        result.stderr = result.stderr.decode("utf-8")
        return result

    def run_csv(self, content, output_format="json"):
        self.input_path.write_bytes(content.encode("utf-8") if isinstance(content, str)
                                    else content)
        return self.run_cli(str(self.input_path), "--format", output_format)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertTrue(result.stdout.endswith("\n"))
        return result.stdout

    def assert_error(self, result, message):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, "", "invalid input must never emit a partial report")
        self.assertIn(message, result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_sample_exact_totals_and_groups(self):
        result = self.run_cli(str(HERE / "sample-returns.csv"))
        summary = json.loads(self.assert_success(result))
        self.assertEqual(summary, {
            "totals": {"returns": 8, "units": 10, "refund_cents": 24396},
            "by_sku": [
                {"sku": "BAG-CANVAS-NAT", "returns": 2, "units": 2, "refund_cents": 9000},
                {"sku": "MUG-CERAMIC-WHT", "returns": 2, "units": 3, "refund_cents": 5400},
                {"sku": "STICKER-PACK", "returns": 1, "units": 1, "refund_cents": 0},
                {"sku": "TSHIRT-NAVY-M", "returns": 3, "units": 4, "refund_cents": 9996},
            ],
            "by_reason": [
                {"reason": "changed_mind", "returns": 2, "units": 2, "refund_cents": 6999},
                {"reason": "damaged", "returns": 2, "units": 3, "refund_cents": 5400},
                {"reason": "goodwill_exchange", "returns": 1, "units": 1, "refund_cents": 0},
                {"reason": "not_as_described", "returns": 1, "units": 1, "refund_cents": 4500},
                {"reason": "wrong_size", "returns": 2, "units": 3, "refund_cents": 7497},
            ],
        })

    def test_saved_examples_match_actual_command(self):
        for fmt, name in (("json", "sample-summary.json"), ("markdown", "sample-report.md")):
            with self.subTest(format=fmt):
                result = self.run_cli(str(HERE / "sample-returns.csv"), "--format", fmt)
                self.assertEqual(self.assert_success(result),
                                 (HERE / name).read_text(encoding="utf-8"))

    def test_idempotent_duplicates_and_row_order_in_all_formats(self):
        rows = ["r1,Z-SKU,wrong_size,2,4998\n", "r2,A-SKU,damaged,1,0\n"]
        for fmt in FORMATS:
            with self.subTest(format=fmt):
                original = self.assert_success(self.run_csv(HEADER + "".join(rows), fmt))
                repeated = HEADER + "".join(reversed(rows)) + "".join(rows * 3)
                repeated += " r1 , Z-SKU , wrong_size , 02 , 04998 \n"
                self.assertEqual(original, self.assert_success(self.run_csv(repeated, fmt)))
                self.assertEqual(original, self.assert_success(self.run_csv(HEADER + "".join(rows), fmt)))

    def test_conflicting_duplicate_rejects_every_changed_field(self):
        row = ["r1", "SKU", "damaged", "1", "100"]
        for index, replacement in ((1, "OTHER"), (2, "wrong_size"), (3, "2"), (4, "101")):
            with self.subTest(field=index):
                conflict = row.copy()
                conflict[index] = replacement
                data = HEADER + ",".join(row) + "\n" + ",".join(conflict) + "\n"
                result = self.run_csv(data)
                self.assert_error(result, "conflicting duplicate return_id 'r1'")
                self.assertIn("line 3", result.stderr)
                self.assertIn("first seen on line 2", result.stderr)
                self.assert_error(self.run_csv(data, "markdown"), "conflicting duplicate")
                self.assert_error(self.run_csv(data, "csv"), "conflicting duplicate")

    def test_every_required_field_is_validated(self):
        fields = HEADER.strip().split(",")
        for index, field in enumerate(fields):
            with self.subTest(field=field):
                row = ["r1", "SKU", "damaged", "1", "100"]
                row[index] = "  "
                self.assert_error(self.run_csv(HEADER + ",".join(row)), f"{field} is required")

    def test_invalid_integer_units_and_money(self):
        invalid = ("-1", "+1", "1.0", "1e2", "$10", "NaN", "Infinity", "1_000", "١", "0x10")
        for field, index in (("units", 3), ("refund_cents", 4)):
            for value in invalid + (("0",) if field == "units" else ()):
                with self.subTest(field=field, value=value):
                    row = ["r1", "SKU", "damaged", "1", "100"]
                    row[index] = value
                    self.assert_error(self.run_csv(HEADER + ",".join(row)), field)
        self.assert_error(self.run_csv(HEADER + 'r1,SKU,damaged,1,"1,000"'), "refund_cents")

    def test_invalid_headers(self):
        for header in ("", "\n", "return_id,sku,reason,units\n",
                       HEADER.strip() + ",extra\n", "return_id,sku,reason,units,units\n",
                       HEADER.replace("sku", "SKU"), HEADER.replace("sku", " sku")):
            with self.subTest(header=header):
                self.assert_error(self.run_csv(header), "header")

    def test_incorrect_row_width(self):
        for row in ("r1,SKU,damaged,1", "r1,SKU,damaged,1,100,extra"):
            with self.subTest(row=row):
                self.assert_error(self.run_csv(HEADER + row), "expected 5 fields")

    def test_malformed_quotes_and_late_failure_emit_no_report(self):
        for row in ('r2,SKU,"unterminated,1,100', 'r2,SKU,"damaged"oops,1,100'):
            with self.subTest(row=row):
                data = HEADER + "r1,SKU,damaged,1,100\n" + row
                self.assert_error(self.run_csv(data), "invalid CSV")
                self.assert_error(self.run_csv(data, "markdown"), "invalid CSV")
                self.assert_error(self.run_csv(data, "csv"), "invalid CSV")

    def test_header_only_and_blank_rows(self):
        empty = {"totals": {"returns": 0, "units": 0, "refund_cents": 0},
                 "by_sku": [], "by_reason": []}
        self.assertEqual(json.loads(self.assert_success(self.run_csv(HEADER + "\n\n"))), empty)
        report = self.assert_success(self.run_csv(HEADER, "markdown"))
        self.assertIn("Unique returns: 0", report)
        self.assertEqual(report.count("No returns."), 2)
        result = self.run_csv(HEADER + "\nr1,SKU,damaged,1,0\n\n")
        self.assertEqual(json.loads(self.assert_success(result))["totals"]["returns"], 1)

    def test_bom_reordered_headers_crlf_quoted_fields_and_unicode(self):
        content = io.StringIO(newline="")
        writer = csv.writer(content)
        writer.writerow(["reason", "refund_cents", "units", "sku", "return_id"])
        writer.writerow(['Damaged, "handle"\r\n第二行', "500", "2", "MÜG-白", "r1"])
        data = "\ufeff" + content.getvalue()
        result = self.run_csv(data)
        summary = json.loads(self.assert_success(result))
        self.assertEqual(summary["by_reason"][0]["reason"], 'Damaged, "handle"\r\n第二行')
        self.assertEqual(summary["by_sku"][0]["sku"], "MÜG-白")
        self.assertEqual(summary["totals"], {"returns": 1, "units": 2, "refund_cents": 500})
        self.assertEqual(result.stdout, self.assert_success(self.run_cli("-", stdin=data)))
        csv_output = self.assert_success(self.run_csv(data, "csv"))
        self.assertEqual(csv_output, "sku,returns,units,refund_cents\r\nMÜG-白,1,2,500\r\n")
        self.assertEqual(csv_output, self.assert_success(
            self.run_cli("-", "--format", "csv", stdin=data)))

    def test_exact_large_integer_money_not_multiplied_by_units(self):
        money = 9007199254740993
        data = HEADER + f"r1,SKU,damaged,3,{money}\nr2,SKU,damaged,2,{money}\n"
        summary = json.loads(self.assert_success(self.run_csv(data)))
        expected = {"returns": 2, "units": 5, "refund_cents": 2 * money}
        self.assertEqual(summary["totals"], expected)
        self.assertEqual(summary["by_sku"], [{"sku": "SKU", **expected}])
        report = self.assert_success(self.run_csv(data, "markdown"))
        self.assertIn(f"Refund total (cents): {2 * money}", report)
        csv_output = self.assert_success(self.run_csv(data, "csv"))
        self.assertEqual(csv_output,
                         f"sku,returns,units,refund_cents\r\nSKU,2,5,{2 * money}\r\n")

    @unittest.skipUnless(hasattr(sys, "get_int_max_str_digits"), "runtime has no digit limit")
    def test_oversized_aggregate_is_clean_error(self):
        # Each value parses, but their sum gains a digit and cannot be rendered.
        huge = "9" * 640
        for field in ("units", "refund_cents"):
            for fmt in FORMATS:
                with self.subTest(field=field, format=fmt):
                    units, refund = (huge, "0") if field == "units" else ("1", huge)
                    # A valid first output row must not leak before rendering fails.
                    data = HEADER + "r0,A,damaged,1,0\n"
                    data += f"r1,SKU,damaged,{units},{refund}\n"
                    data += f"r2,SKU,damaged,{units},{refund}\n"
                    result = self.run_cli("-", "--format", fmt, stdin=data,
                                          env={"PYTHONINTMAXSTRDIGITS": "640"})
                    self.assert_error(result, "integer formatting limit")

    @unittest.skipUnless(hasattr(sys, "get_int_max_str_digits"), "runtime has no digit limit")
    def test_oversized_input_integer_is_clean_error(self):
        data = HEADER + "r1,SKU,damaged,1," + "9" * 641 + "\n"
        for fmt in FORMATS:
            with self.subTest(format=fmt):
                result = self.run_cli("-", "--format", fmt, stdin=data,
                                      env={"PYTHONINTMAXSTRDIGITS": "640"})
                self.assert_error(result, "refund_cents is too large to parse")

    def test_markdown_escapes_labels_and_keeps_tables_intact(self):
        content = io.StringIO(newline="")
        writer = csv.writer(content)
        writer.writerow(HEADER.strip().split(","))
        writer.writerow(["r1", "A|B\\C", "<script>&_*[x]" + chr(96) + "\nnext", 1, 100])
        report = self.assert_success(self.run_csv(content.getvalue(), "markdown"))
        self.assertIn(r"| A\|B\\C | 1 | 1 | 100 |", report)
        self.assertIn(r"&lt;script&gt;&amp;\_\*\[x\]" + "\\" + chr(96) + "<br>next", report)
        self.assertNotIn("<script>", report)
        self.assertNotIn("\x01", report)

    def test_file_and_stdin_match_without_modifying_input(self):
        data = HEADER + "r1,SKU,damaged,1,100\n"
        for fmt in FORMATS:
            with self.subTest(format=fmt):
                file_output = self.assert_success(self.run_csv(data, fmt))
                stdin_output = self.assert_success(self.run_cli("-", "--format", fmt, stdin=data))
                self.assertEqual(file_output, stdin_output)
                self.assertEqual(self.input_path.read_bytes(), data.encode("utf-8"))
                self.assertEqual(list(Path(self.temp.name).iterdir()), [self.input_path])

    def test_missing_path_directory_and_invalid_utf8(self):
        self.assert_error(self.run_cli(str(self.input_path)), "error:")
        self.assert_error(self.run_cli(self.temp.name), "error:")
        data = HEADER.encode() + b"r1,SKU,\xff,1,100\n"
        self.assert_error(self.run_csv(data), "codec")
        self.assert_error(self.run_cli("-", stdin=data), "codec")

    def test_help_and_usage_errors(self):
        self.assertIn("--format {json,markdown,csv}",
                      self.assert_success(self.run_cli("--help")))
        self.assert_error(self.run_cli(), "required")
        self.assert_error(self.run_cli("-", "--format", "xml", stdin=HEADER), "invalid choice")

    def test_csv_sample_stable_header_and_one_summary_row_per_sku(self):
        sample = HERE / "sample-returns.csv"
        before = sample.read_bytes()
        output = self.assert_success(self.run_cli(str(sample), "--format", "csv"))
        self.assertEqual(output,
                         "sku,returns,units,refund_cents\r\n"
                         "BAG-CANVAS-NAT,2,2,9000\r\n"
                         "MUG-CERAMIC-WHT,2,3,5400\r\n"
                         "STICKER-PACK,1,1,0\r\n"
                         "TSHIRT-NAVY-M,3,4,9996\r\n")
        reader = csv.DictReader(io.StringIO(output, newline=""))
        self.assertEqual(reader.fieldnames, ["sku", "returns", "units", "refund_cents"])
        rows = [{"sku": row["sku"], **{field: int(row[field])
                 for field in ("returns", "units", "refund_cents")}} for row in reader]
        summary = json.loads(self.assert_success(self.run_cli(str(sample))))
        self.assertEqual(rows, summary["by_sku"])
        self.assertEqual(sample.read_bytes(), before)

    def test_csv_round_trip_escaping_unicode_and_deterministic_order(self):
        skus = ["plain", "comma,sku", 'quote"sku', "LF\nsku", "CR\rsku",
                "CRLF\r\nsku", "白-🫖", 'MÜG, "白"\r\nnext', "a", "Z", "Á"]
        records = [[f"r{index}", sku, 'reason, "quoted"\nline', 2, index]
                   for index, sku in enumerate(skus)]

        def input_csv(rows):
            buffer = io.StringIO(newline="")
            writer = csv.writer(buffer)
            writer.writerow(HEADER.strip().split(","))
            writer.writerows(rows)
            return buffer.getvalue()

        data = input_csv(records)
        output = self.assert_success(self.run_csv(data, "csv"))
        decoded = list(csv.reader(io.StringIO(output, newline=""), strict=True))
        expected = [[sku, "1", "2", str(index)] for index, sku in enumerate(skus)]
        self.assertEqual(decoded, [["sku", "returns", "units", "refund_cents"]]
                         + sorted(expected, key=lambda row: row[0]))
        for escaped in ('"comma,sku"', '"quote""sku"', '"LF\nsku"',
                        '"CR\rsku"', '"CRLF\r\nsku"', '"MÜG, ""白""\r\nnext"'):
            with self.subTest(escaped=escaped):
                self.assertIn(escaped + ",1,2,", output)
        self.assertIn("白-🫖", output)
        self.assertFalse(output.startswith("\ufeff"))
        reordered = input_csv(list(reversed(records)) + records)
        self.assertEqual(output, self.assert_success(self.run_csv(reordered, "csv")))
        self.assertEqual(output, self.assert_success(
            self.run_cli("-", "--format", "csv", stdin=data)))

    def test_csv_header_only_has_no_data_or_total_row(self):
        for data in (HEADER, HEADER + "\n\n"):
            with self.subTest(data=data):
                self.assertEqual(self.assert_success(self.run_csv(data, "csv")),
                                 "sku,returns,units,refund_cents\r\n")

    def test_csv_invalid_input_never_emits_header(self):
        invalid = [
            ("", "header"),
            (HEADER.replace("sku", "units"), "header"),
            (HEADER + "r1,SKU,damaged,1", "expected 5 fields"),
            (HEADER + "r1,SKU,damaged,1,100,extra", "expected 5 fields"),
            (HEADER + "r1,SKU,damaged,0,100", "units"),
            (HEADER + "r1,SKU,damaged,1,-1", "refund_cents"),
            (HEADER + "r1,SKU,damaged,1,1.5", "refund_cents"),
            (HEADER.encode() + b"r1,SKU,\xff,1,100\n", "codec"),
        ]
        for index, field in enumerate(HEADER.strip().split(",")):
            row = ["r1", "SKU", "damaged", "1", "100"]
            row[index] = " "
            invalid.append((HEADER + ",".join(row), f"{field} is required"))
        for data, message in invalid:
            with self.subTest(data=data):
                self.assert_error(self.run_csv(data, "csv"), message)
                self.assert_error(self.run_cli("-", "--format", "csv", stdin=data), message)


if __name__ == "__main__":
    unittest.main(verbosity=2)
