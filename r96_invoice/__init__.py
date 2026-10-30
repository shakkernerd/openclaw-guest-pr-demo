"""Validate invoice line items and calculate exact integer-cent totals."""


class InvoiceError(ValueError):
    """An invoice does not match the supported input format."""


def calculate_totals(items):
    """Return a new report for a JSON-style list of invoice line items."""
    if not isinstance(items, list):
        raise InvoiceError("invoice must be a JSON array of line items")

    lines = []
    invoice_total = 0
    for index, item in enumerate(items, start=1):
        prefix = f"line {index}"
        if not isinstance(item, dict):
            raise InvoiceError(f"{prefix} must be an object")
        for field in ("sku", "quantity", "unit_price_cents"):
            if field not in item:
                raise InvoiceError(f"{prefix}: missing required field '{field}'")

        sku = item["sku"]
        if not isinstance(sku, str) or not sku.strip():
            raise InvoiceError(f"{prefix}: sku must be a non-empty string")
        for field in ("quantity", "unit_price_cents"):
            value = item[field]
            # bool is a subclass of int, but is not an invoice quantity/price.
            if type(value) is not int or value < 0:
                raise InvoiceError(f"{prefix}: {field} must be a non-negative integer")

        line_total = item["quantity"] * item["unit_price_cents"]
        lines.append({
            "sku": sku,
            "quantity": item["quantity"],
            "unit_price_cents": item["unit_price_cents"],
            "line_total_cents": line_total,
        })
        invoice_total += line_total

    return {"lines": lines, "invoice_total_cents": invoice_total}
