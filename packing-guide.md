# Packing guide

Before printing the label:

1. Check that the item count matches the order.
2. Pack the items securely with suitable cushioning, then seal the parcel.
3. Check that the delivery address is complete and matches the order.

## Prepare labels for the whole batch

1. Make a UTF-8 JSON array with exactly id and count on each parcel record:
   [{ "id": "box-b", "count": 3 }, { "id": "box-a", "count": 1 }]. Use a distinct,
   nonblank string ID and a nonnegative safe whole-number count for each parcel.
   IDs are compared exactly: spaces and case are preserved, not normalized.
2. Save the array as batch.json, then run from the repository root:

       node packing-batch-cli.js batch.json

   Or supply the same JSON via stdin:

       node packing-batch-cli.js < batch.json

3. Check that the command exits with status 0 before using its stdout result.
   Match each id back to its parcel in input order. For the example, labels are
   "3 items" and "1 item", parcelCount is 2, and totalItemCount is 4. Reconcile
   both totals against the packing list; zero-count parcels still count as
   parcels. An empty array intentionally produces no parcels and both totals 0.
4. If the command reports an error on stderr, fix the batch or I/O problem and
   rerun it. Invalid input produces no result; an output error can leave a
   partial result, which must not be used. The tool does not change input files
   or maintain state, so rerunning the same batch produces the same output.

To save stdout, redirect to a **different** file, for example:

    node packing-batch-cli.js batch.json > labels.json

Never redirect to batch.json itself: the shell can truncate it before reading.
Redirection is not an atomic replacement; use only a successful command's
completed output. See README.md for the exact schema, numeric limits and error
semantics. These batch labels do not replace the address and packing checks
above.
