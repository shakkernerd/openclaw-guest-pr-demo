# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Prepare a packing batch

With Node.js 22 or newer, prepare all labels and totals in one operation using
only the standard library. The existing single-count helper is unchanged.

Save a UTF-8 JSON array (without a byte-order mark) as, for example, batch.json:

    [
      { "id": "box-b", "count": 3 },
      { "id": "box-a", "count": 1 },
      { "id": "empty", "count": 0 }
    ]

Run from the repository root:

    node packing-batch-cli.js batch.json

Or read standard input with no argument (an explicit - also means stdin):

    printf '%s\n' '[{"id":"box-a","count":1}]' | node packing-batch-cli.js
    node packing-batch-cli.js - < batch.json

The CLI accepts at most one argument, a file path or -. A supplied path is used
instead of stdin; paths with spaces must be quoted. Use ./- for a file named -.
It never rewrites its input file. Success writes only the completed JSON result
to stdout, with two-space indentation and a final newline:

    {
      "parcels": [
        {
          "id": "box-b",
          "count": 3,
          "label": "3 items"
        },
        {
          "id": "box-a",
          "count": 1,
          "label": "1 item"
        },
        {
          "id": "empty",
          "count": 0,
          "label": "0 items"
        }
      ],
      "parcelCount": 3,
      "totalItemCount": 4
    }

Field order is always parcels, parcelCount, totalItemCount; each parcel has
id, count, label, in that order.

### Record and total contracts

- The top-level value must be an array. Every record must be an object with
  exactly two fields: id and count. Missing or additional fields are rejected.
- id must be a string containing at least one non-whitespace character, using
  JavaScript String.trim() to test for blankness only. It is otherwise preserved
  verbatim, including leading/trailing whitespace and case.
- IDs must be distinct by exact string equality. "box", "Box" and " box " are
  different identifiers; two occurrences of " box " are duplicates. There is
  no trimming, case folding or Unicode normalization for identity.
- count must be a numeric, nonnegative safe integer: 0 through
  Number.MAX_SAFE_INTEGER (9007199254740991). Strings, fractions, negative values
  and unsafe numbers are rejected, with no coercion. Standard JSON.parse number
  semantics apply; numeric spelling is not preserved (1.0 becomes 1, and -0
  serializes as 0). This is not an arbitrary-precision number format.
- Record order and parsed counts are preserved. label comes directly from the
  unchanged parcelLabel(count) helper. parcelCount counts records, including
  zero-count parcels; totalItemCount sums counts. A total above
  Number.MAX_SAFE_INTEGER rejects the entire batch before unsafe addition.
- An empty array succeeds with exactly the data
  { "parcels": [], "parcelCount": 0, "totalItemCount": 0 }.

### Reuse and failures

The reusable module is independent of the CLI and performs no I/O:

    const { preparePackingBatch } = require("./packing-batch.js");
    const result = preparePackingBatch([{ id: "box-a", count: 1 }]);

It returns a fresh result without modifying the array or records, or throws on
an invalid batch. Record errors use zero-based positions such as parcels[1].
Each call is independent; no identifiers or totals persist between calls.

The CLI reads, validates and serializes the entire batch before writing any
success output. Malformed JSON/UTF-8, invalid batches, input I/O errors and
incorrect argument counts report a diagnostic to stderr, leave stdout empty
and exit with status 1. Success exits with status 0. An output I/O error (for
example, a full device or closed pipe) also reports to stderr and exits 1, but
some output bytes may already have been written. Stdout is **not an atomic file
replacement**, and success does not guarantee durable storage or downstream
processing. Check the CLI's exit status; do not use a partial result.

Input bytes are not rewritten, but shell redirection is outside the CLI's
control: never redirect stdout to the input file. The shell could truncate it
before the CLI reads it. The whole input and result are held in memory; this is
an in-memory batch tool, not a streaming or unbounded-data processor.

## Tests

There is no application build pipeline or browser UI. No build scaffolding or
browser/media checks are required. To check the batch paths directly:

    node --check packing-batch.js
    node --check packing-batch-cli.js
    node --check packing-batch.test.js
    node --check packing-batch-cli.test.js
    node --test packing-batch.test.js packing-batch-cli.test.js

The batch tests cover record shape, exact identifiers, order, count boundaries,
safe totals, empty batches, non-mutation and reuse of the existing formatter.
Integration tests launch real CLI processes for file/stdin input, exact output,
unchanged input bytes, malformed/invalid input, read errors, large pipe output,
and a reader closing after partial output. The full-device test uses /dev/full
on Linux; the directory-descriptor read-error test requires POSIX. Those tests
are explicitly skipped on unsupported platforms.

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively.
