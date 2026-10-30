import copy
import unittest

from r96_invoice import InvoiceError, calculate_totals


class TotalsTests(unittest.TestCase):
    def test_multiple_lines_and_input_unchanged(self):
        items = [
            {"sku": "PEN", "quantity": 3, "unit_price_cents": 125},
            {"sku": "BOOK", "quantity": 2, "unit_price_cents": 999},
        ]
        original = copy.deepcopy(items)
        self.assertEqual(calculate_totals(items), {
            "lines": [
                dict(items[0], line_total_cents=375),
                dict(items[1], line_total_cents=1998),
            ],
            "invoice_total_cents": 2373,
        })
        self.assertEqual(items, original)

    def test_empty_invoice(self):
        self.assertEqual(calculate_totals([]), {"lines": [], "invoice_total_cents": 0})

    def test_zero_quantity_and_zero_price(self):
        report = calculate_totals([
            {"sku": "A", "quantity": 0, "unit_price_cents": 100},
            {"sku": "B", "quantity": 5, "unit_price_cents": 0},
        ])
        self.assertEqual([line["line_total_cents"] for line in report["lines"]], [0, 0])
        self.assertEqual(report["invoice_total_cents"], 0)

    def test_large_integer_arithmetic_is_exact(self):
        price = 2**60 + 1
        report = calculate_totals([{"sku": "A", "quantity": 3, "unit_price_cents": price}])
        self.assertEqual(report["invoice_total_cents"], 3 * price)
        self.assertIs(type(report["invoice_total_cents"]), int)

    def test_duplicate_skus_remain_separate_and_extra_fields_are_ignored(self):
        item = {"sku": "A", "quantity": 1, "unit_price_cents": 10, "note": "ignored"}
        report = calculate_totals([item, item])
        self.assertEqual(len(report["lines"]), 2)
        self.assertEqual(report["invoice_total_cents"], 20)
        self.assertNotIn("note", report["lines"][0])

    def test_invalid_invoice_shape(self):
        for value in ({}, None, "invoice", 1, True):
            with self.subTest(value=value), self.assertRaisesRegex(InvoiceError, "array"):
                calculate_totals(value)

    def test_invalid_line_shape(self):
        for value in ([], None, "item", 1, True):
            with self.subTest(value=value), self.assertRaisesRegex(InvoiceError, "line 1.*object"):
                calculate_totals([value])

    def test_missing_fields(self):
        valid = {"sku": "A", "quantity": 1, "unit_price_cents": 10}
        for field in valid:
            item = dict(valid)
            del item[field]
            with self.subTest(field=field), self.assertRaisesRegex(InvoiceError, field):
                calculate_totals([item])

    def test_invalid_skus(self):
        for sku in ("", "  ", None, 1, True, [], {}):
            with self.subTest(sku=sku), self.assertRaisesRegex(InvoiceError, "sku"):
                calculate_totals([{"sku": sku, "quantity": 1, "unit_price_cents": 10}])

    def test_invalid_numeric_values(self):
        for field in ("quantity", "unit_price_cents"):
            invalid = (-1, 1.5, 1.0, True, False, None, "1", [], {}, float("nan"), float("inf"))
            for value in invalid:
                item = {"sku": "A", "quantity": 1, "unit_price_cents": 10}
                item[field] = value
                with self.subTest(field=field, value=value):
                    with self.assertRaisesRegex(InvoiceError, f"line 1: {field}"):
                        calculate_totals([item])


if __name__ == "__main__":
    unittest.main()
