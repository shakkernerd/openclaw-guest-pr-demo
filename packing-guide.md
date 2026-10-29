# Packing guide

Before printing the label:

1. Run the dispatch manifest command in the [README](README.md) and resolve any errors.
2. Pick the combined quantities from the pick list, then separate them by order ID.
3. Check each order's SKUs and quantities, not just its total item count. A catalogue
   unit may be a kit or a pair; count it as one unit.
4. Confirm each order fits in one carton. The tool assumes one carton per order;
   it does not calculate capacity or split orders. If it does not fit, use the
   stockroom's manual split-and-labelling process instead of this carton label.
5. Pack securely with suitable cushioning, then seal the carton.
6. Check that the delivery address is complete and matches the order. Attach only
   the matching order's carton label; postage must be arranged separately.
