# Packing CLI reference

Start with the [quick-start and output choices](README.md#quick-start). This guide
is the canonical schema, error, spreadsheet-import and print reference. Run all
commands from the repository root with Node.js 22 or newer.

- [Dispatch schema](#dispatch-format-and-validation) and [totals](#reading-totals-and-anomalies)
- [Errors](#error-examples-and-exit-codes) and [pipe previews](#previewing-through-a-pipe)
- [CSV handoff](#csv-warehouse-handoff), [Text imports](#import-id-and-postcode-as-text-preserve-leading-zeros) and [formula protection](#formula-protection-separate-from-column-types)
- [Printing HTML](#printable-html-handoff) and [test coverage](#tests)

## Files and output selection

Supply exactly one file path. Quote paths containing spaces; prefix filenames
starting with `-` with `./`. Both `--help` and `-h` print usage and exit 0.
Default output is text. Select **one** optional output flag, `--csv` or `--html`,
before or after the path. Repeated or combined output flags exit 2 with no report.
All formats consume the **same validation report** and use the
[exit codes listed in the README](README.md#exit-codes).

## Text checklist example

Success output (excerpt; each parcel gets the complete checklist):

```text
E10 Dispatch Desk — packing checklist
Parcels: 2 | Items: 4 | Ready: 2 | Needs attention: 0
Ready-to-dispatch items: 4

Parcel 1 — E10-001 [READY]
  Recipient: Zoë O’Example
  Address:
    street: 12 Example Lane, Flat #4-B
    city: London
    postcode: E10 0ZZ
    country: United Kingdom
  Contents: 3 items (order: 3 items)
  [x] Unique parcel ID provided
  [x] Recipient name provided
  [x] Complete delivery address provided
  [x] Item count matches order
  [x] Items securely packed
  [x] Suitable cushioning used
  [x] Parcel sealed
  [x] Address checked against order
  [x] Recipient name readable on label
  [x] Label securely attached
...
Anomalies: none

Result: READY — all recorded checks passed.
```

## Dispatch format and validation

Start with [examples/dispatch.json](examples/dispatch.json). The UTF-8 file
(optional UTF-8 BOM accepted) must contain an object with a **non-empty `parcels`
array**. Each entry represents **one physical parcel**, not a batch. Each parcel
requires:

- `id`: a non-blank string, unique within the file (exact, case-sensitive match).
  All occurrences of duplicate IDs are flagged.
- `recipient`: a non-blank recipient name string.
- `address`: an object with non-blank strings `street`, `postcode` and `country`.
  Include apartment/unit details in `street`. Optional `city` and `region` strings
  are validated and displayed when present; include them where the destination
  requires them. Keep postcodes as strings to preserve leading zeros.
- `itemCount`: the actual number of packed items in this parcel.
- `orderItemCount`: the expected number allocated to this parcel from the order.
  For a split order, use the parcel's allocation, not the entire order quantity.
  Both counts must be positive safe integers (1–9007199254740991) and equal.
  Zero, negative, fractional, unsafe, missing or string counts are anomalies;
  there is no numeric coercion.
- `checks`: an object containing **all six explicit boolean confirmations** below.
  Missing values, `false`, `"true"` and `1` do not pass. Record `true` only after
  the corresponding physical check is complete:
  - `securelyPacked` — items are packed securely.
  - `cushioningUsed` — suitable cushioning is in place.
  - `sealed` — the parcel is sealed.
  - `addressMatchesOrder` — the full address has been compared with the order.
  - `recipientReadable` — the recipient name on the label is clearly readable.
  - `labelAttached` — the label is securely attached.

Punctuation and international text are preserved without trimming, transliteration
or Unicode normalization. All text fields must be single-line; control characters
(including tabs/newlines) and bidi overrides/isolate controls are rejected and
escaped in the report so they cannot inject checklist lines. Invalid UTF-8 is an
input error, not silently replaced text. Unpaired Unicode surrogates in JSON string
escapes are also rejected instead of printing replacement characters. Unrelated
metadata fields are ignored, not displayed: use the documented address fields
for all delivery details.

This is a **recorded-checks validator**, not an address lookup, carrier label
printer or proof of physical packing. It checks required address fields but does
not verify postcode formats, postal deliverability or truthfulness of confirmations.
The operator must compare the full address and item counts with the order.

### Reading totals and anomalies

- `Parcels` counts all supplied entries, including malformed or duplicate entries.
- `Items` sums valid packed `itemCount` values, even for parcels blocked by other
  issues. It is **not** a ready-to-ship item total. Invalid counts are excluded and
  the total is explicitly marked **partial**, with the number of uncounted parcels.
  Integer totals remain exact even when the sum exceeds the safe-number limit.
- `Ready-to-dispatch items` sums items only in parcels with **no anomalies**, after
  duplicate-ID checks. Blocked parcels never contribute, even when their item
  counts are valid. Both item totals use exact integer arithmetic. This does not
  override a failing dispatch exit code or replace physical sign-off.
- `Ready` means that parcel has no anomalies; `Needs attention` counts the rest.
- Each anomaly includes a zero-based JSON path (for example,
  `parcels[0].checks.sealed`) and an action. Checklist parcel headings are one-based.
  All entries are checked rather than stopping at the first problem.
- Malformed or empty dispatch structures fail validation even though their parcel
  total is zero. Only the final `Result: READY` and exit 0 indicate success.

## Error examples and exit codes

A supplied failing fixture demonstrates a blank postcode, an item mismatch and an
unattached label:

```sh
node packing-quality.js examples/dispatch-needs-attention.json
echo $?  # 1
```

Validation output (excerpt):

```text
E10 Dispatch Desk — packing checklist
Parcels: 1 | Items: 1 | Ready: 0 | Needs attention: 1
Ready-to-dispatch items: 0
...
Anomalies (3):
  - parcels[0].address.postcode: must be a non-blank string; copy the complete value from the order.
  - parcels[0].itemCount: packed count 1 does not match orderItemCount 2; reconcile the packed items with the order before dispatch.
  - parcels[0].checks.labelAttached: must be explicitly true (boolean). Securely attach the label, then record true.

Result: NEEDS ATTENTION — resolve every anomaly before dispatch.
```

An existing Markdown file is deliberately **not JSON**, making this error command
reproducible without creating another fixture:

```sh
node packing-quality.js packing-guide.md
echo $?  # 2
```

```text
Error: invalid JSON in packing-guide.md. Check JSON syntax (double-quoted keys/strings, no comments or trailing commas).
```

An omitted path is also an error:

```sh
node packing-quality.js
echo $?  # 2; stderr starts with "Error: expected one dispatch JSON file and at most one output flag (--csv or --html)."
```

See [exit-code essentials](README.md#exit-codes) for status meanings and output routing.

For automation, capture the status immediately; do not pipe through a command
that hides it. Example in a POSIX shell (the report includes names and addresses):

```sh
status=0
node packing-quality.js examples/dispatch.json > packing-checklist.txt || status=$?
echo "packing-quality exit: $status"
# Proceed only when status is 0. Share/store the report as delivery data.
```

### Previewing through a pipe

A reader such as `head` may close stdout early. The CLI treats only `EPIPE` as a
quiet closed pipe and retains its validation status: 0 for ready, 1 for anomalies.
Other output-write errors (for example `ENOSPC`) emit a concise diagnostic and exit
2; an output file may be partial. A closed pipe is not proof of a complete export.

```sh
# Bash, without set -e (errexit), so a known failing preview can be inspected:
node packing-quality.js examples/dispatch-training.json | head -n 5
printf 'CLI=%s head=%s\n' "${PIPESTATUS[@]}"  # CLI=1 head=0
```

Capture `PIPESTATUS` immediately. A default pipeline reports only the last
command's status; use both statuses (or Bash `set -o pipefail`) to detect failures.
`EPIPE` cannot distinguish a deliberate preview from a failed consumer, so do not
ignore the consumer's exit status. For a full handoff, save the complete report
and check its status before previewing the file. `head` does not reduce generation
work here: the CLI validates and formats the whole input before writing.

## CSV warehouse handoff

Write to a separate file (never redirect onto the input JSON). These POSIX-shell
commands capture the exit status even when the tool finds anomalies:

```sh
status=0
node packing-quality.js --csv examples/dispatch.json > examples/packing-handoff.csv || status=$?
echo "handoff exit: $status"  # 0

status=0
node packing-quality.js --csv examples/dispatch-needs-attention.json > packing-review.csv || status=$?
echo "review exit: $status"  # 1: review anomalies; not dispatch approval

# Read full corrective actions for the same input:
node packing-quality.js examples/dispatch-needs-attention.json
```

The ready example produces [examples/packing-handoff.csv](examples/packing-handoff.csv):
a small, entirely synthetic fixture with two ready parcels and four items.
Regenerate it with the command above rather than editing it by hand. Tests compare
its bytes with the actual CLI output and check the rows against the source JSON
and the [README CSV example](README.md#csv-output-example).

The header and column order are fixed. Each input entry gets **one row in its
original position**, including duplicates, invalid objects and parcels needing
attention. There is no sorting, filtering, deduplication or totals/footer row.
The file is UTF-8 without a BOM, with CRLF record endings. All text cells are
quoted; embedded quotes are doubled, so commas and quotes stay in their cells.

- `street`, `city`, `region`, `postcode` and `country` are separate columns.
  Absent or non-string text fields are empty cells; supplied strings retain
  punctuation, Unicode and surrounding spaces. Blank optional fields do not
  cause columns to shift.
- `itemCount` contains the validated packed count, including known counts for
  blocked parcels. An invalid/unknown count is an **empty cell, not zero**.
- `readiness` is `READY` or `NEEDS ATTENTION`, using the existing validation issues.
  `anomalies` contains every issue's indexed path and short description, joined
  with ` | `. Use the human checklist for the full corrective actions.
- An empty or invalid dispatch structure yields a header with **no data rows**,
  a validation diagnostic on stderr, and exit 1. Usage, file, UTF-8 and JSON errors
  yield no CSV and exit 2. Do not mistake an existing output file for success:
  shell redirection can create an empty file even when input fails.

### Import ID and postcode as Text (preserve leading zeros)

**CSV quoting protects field boundaries, not spreadsheet data types.** A quoted
`"00123"` can still become the number `123`, and `"00042"` can become `42`.
Import the file rather than double-clicking it, and set the `id` and `postcode`
columns to **Text before loading the data**. Changing a column to Text after the
zeros have been stripped will not restore them; re-import the original CSV.

For example, this additional synthetic handoff row uses a realistic Rome postcode
and a recipient containing an apostrophe, a comma and an accented character:

```csv
id,recipient,street,city,region,postcode,country,itemCount,readiness,anomalies
"00042","O'Neill, Zoë","Via Esempio 12, Scala B","Roma","Lazio","00123","Italia",1,"READY",""
```

After import, confirm that `id` is exactly `00042`, `postcode` is exactly `00123`,
and `recipient` is a single cell containing `O'Neill, Zoë`. The apostrophe inside
this name is ordinary data, not the formula-protection prefix described below.

- **Excel (Get & Transform / Power Query):** choose **Data → From Text/CSV**,
  select the file, and choose **UTF-8** and **Comma**. Choose **Transform Data**
  instead of loading immediately. If there is an automatic **Changed Type** step
  in Applied Steps, remove it so the original text values are restored. Select
  `id` and `postcode` and set their **Data Type → Text**, then **Close & Load**.
  If using the legacy Text Import Wizard instead, choose comma-delimited input
  with `"` as the text qualifier, then select each of those columns and choose
  **Text** in the column-data-format step before finishing.
- **LibreOffice Calc:** open the file with **Text Import** options visible; choose
  **Unicode (UTF-8)**, **Comma**, and `"` as the string/text delimiter. Select the
  `id` and `postcode` columns in the preview and set **Column type → Text**
  (also available from the preview's column context menu), then confirm the import.

Keep recipient, other address fields and anomalies as Text too. Very large item
counts should also be imported as Text to avoid spreadsheet precision loss.
Menu names vary by version; the essential step is selecting Text **before** any
automatic number conversion. See [Excel CSV import](https://support.microsoft.com/en-us/office/import-or-export-text-txt-or-csv-files-5250ac4c-663c-47ce-937b-339e391393ba)
and [Calc CSV import](https://help.libreoffice.org/latest/en-US/text/scalc/guide/csv_files.html).

### Formula protection (separate from column types)

Text beginning with `=`, `+`, `-` or `@`, including after leading whitespace or
invisible control/format characters, is prefixed with an apostrophe **before**
that whitespace. For example, the input `  =1+1` becomes the CSV cell `"'  =1+1"`.
This intentional export-only change prevents formula interpretation; quoting
alone would not. The apostrophe may be visible in some spreadsheet programs.
This protection does **not** force numeric-looking IDs or postcodes to remain
Text; use the import settings above to preserve leading zeros.
The input JSON and human checklist are not changed by CSV protection. Invalid
control characters/newlines and unpaired surrogates are escaped as literal
`\uXXXX` text, as in the checklist, rather than injecting extra rows.

### Handoff review

Before using the handoff, confirm:

1. Verify the imported Text values against the original CSV: leading zeros in ID
   and postcode, accents, apostrophes and comma-containing names must survive.
   Do not rely on CSV quotes or a display-only number format to preserve them.
2. Check the exit code, fixed columns and row count against the JSON and human
   checklist. Compare all counted items separately from ready-to-dispatch items;
   never treat partial totals or an exit-1 review export as dispatch approval.
3. Keep formula-protection apostrophes intact; do not strip them or enable formulas
   when re-importing. Confirm recipient/address text survived the import, and
   share/store the file as delivery data, not a public artifact. CSV contains
   recorded validation results, not a warehouse sign-off.

## Printable HTML handoff

Use `--html` for a self-contained sheet you can open locally in a browser and
print. It contains the readiness summary, separate all-counted and ready-to-dispatch
item totals, per-parcel checks, and full actionable anomalies in input order.

Generate the small, entirely synthetic [HTML example](examples/packing-handoff.html)
from the successful dispatch (two ready parcels, four items) using the
[HTML command in the quick-start](README.md#choose-an-output).

Regenerate that file with the CLI rather than editing it by hand. For an anomaly
review, capture the status immediately, including in shells using `set -e`:

```sh
status=0
node packing-quality.js --html examples/dispatch-needs-attention.json > packing-review.html || status=$?
echo "review exit: $status"  # 1: printable review, not dispatch approval
```

Open the generated file using your browser's **File → Open File**, then choose
**Print** (`Ctrl+P` / `Cmd+P`). No server, JavaScript, external fonts/assets, network
access or new dependencies are required. Use A4 or Letter portrait at 100% scale
as a starting point; preview pages before handing them over. Browser-added
headers/footers are optional. International text is retained as UTF-8; check that
the local browser/printer fonts display each script correctly.

The sheet uses black-on-white text, explicit `READY`/`NEEDS ATTENTION` labels and
`[x]`/`[ ]` checks rather than relying on color. Long values wrap, and print styles
try to keep each parcel together; exceptionally long entries may still span pages.
A reviewer/date line supports a physical handoff, but recorded confirmations are
**not** proof of packing or dispatch authorization. Resolve anomalies, compare
items/labels with the order, then obtain your warehouse's physical sign-off.

Input values are HTML-escaped: literal `<`, `>`, `&`, quotes and markup-like text
are displayed as text, not interpreted as elements or scripts. Formula-looking
text also remains literal; HTML does **not** add CSV formula-protection prefixes.
This printable sheet is not a spreadsheet export. For CSV use, retain the separate
formula protection and **import ID/postcode as Text** guidance above.

HTML validation anomalies (including empty/invalid dispatch structures) stay in
the sheet and exit 1; file/JSON/UTF-8/usage errors go to stderr
and exit 2 without HTML. Redirect only to a separate output file, never the source
JSON. An output file's existence is not success: redirection can leave an empty
file after an input error. Treat generated sheets as delivery data.

## Tests

```sh
node --test
# Just the CLI/validation tests:
node --test packing-quality.test.js
```

Tests use `node:test` and `node:assert/strict`, plus child processes to verify real
stdout, stderr and exit codes. Coverage includes totals, malformed structures,
required fields, international text/punctuation, invalid counts, order mismatches,
every boolean confirmation, duplicate IDs, partial/large totals, control-character
safety, file/JSON/UTF-8 errors, BOMs, paths with spaces and non-mutating imports.
CSV CLI tests cover fixed rows/columns, input order, quoting/Unicode round-trips,
formula prefixes across every input text column, leading whitespace and controls,
concise anomalies, ready-item totals, and the same exit-code meanings.
HTML CLI tests cover escaping in every text field, literal formula-looking text,
mixed readiness/partial totals, actionable anomalies, standalone document structure
and print styles, exclusive output selection, and unchanged exit-code meanings.
Generated CSV/HTML fixtures are compared byte-for-byte with real CLI output.
Pipe tests cover early-closing readers, preserved validation status and non-EPIPE
write errors; Linux also exercises the real `/dev/full` failure sink.
These checks do not replace a print preview in the warehouse's browser/printer.
The original helper tests for 0, 1 and 3 items remain unchanged.
