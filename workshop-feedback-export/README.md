# Workshop feedback export v1

A small offline Python command, using only the standard library. Tested with
Python 3.11.2 in the supplied sandbox. No installation, network, dependencies,
configuration, Git, or remote publication is needed or performed.

## Run

From this directory, choose an output directory that does **not** already exist:

~~~sh
python3 -B export_feedback.py examples/fictional-workshop-feedback.csv review-output
~~~

This creates exactly:

- `review-output/feedback.csv` — columns `session,score,comment`, in input row order.
- `review-output/session-summary.csv` — columns `session,response_count,score_total`.

The two positional arguments are the complete output interface. `--help` shows
usage. The output's parent directory must already exist. Any existing destination
path (including an empty directory, file, or symlink, even a dangling symlink) is
refused; nothing is merged, appended, or overwritten. There is no force option.
Using the input file itself as the destination is also refused.

Exit status is 0 for success, 1 for input/output errors, and 2 for incorrect command
arguments. Successful exports are silent. Errors go to stderr with a useful
message; record errors identify the data-row number and physical CSV line.
Multiline records count as one data row.

## Input and preservation contract

- Input is UTF-8, optionally with a UTF-8 BOM at the start of the file. Invalid
  UTF-8 is rejected, not replaced with placeholder characters.
- The decoded header must be exactly these five names in this order:
  `response_id,contact_email,session,score,comment`. Missing, extra, duplicate,
  misspelled, reordered, or whitespace-altered names are rejected.
- Parsing uses Python's standard comma-separated CSV dialect, with double-quote
  quoting, doubled quotes inside quoted fields, and `strict=True`. Quoted commas,
  Unicode, and multiline fields are handled by the CSV parser, not line splitting.
- Every data record must have exactly five fields. Short rows, extra fields, and
  blank records are errors. A final record terminator is not an extra record.
  A header-only file is valid and produces two header-only outputs.
- Scores must represent integers 1 through 5. For validation only, surrounding
  whitespace is stripped; the remaining spelling must be ASCII decimal digits
  with an optional leading sign. Leading zeroes and a leading plus are allowed
  (for example, ` +05 ` and `02`). Fractions, exponents, underscores, Unicode
  digits, empty scores, negative numbers, zero, and values above five are rejected.
- The original decoded strings in **all three retained fields** are exported
  unchanged, including the spelling and whitespace of an accepted score. No
  stripping, Unicode normalization, sorting, deduplication, or text redaction is
  applied. Empty session/comment values are allowed; dropped fields are not
  subjected to unrelated email or identifier validation.
- Output CSV uses UTF-8 without a BOM and CRLF record terminators. CSV quoting and
  record terminators can differ from the original bytes; decoded retained values
  are preserved, including CR, LF, or CRLF embedded in a quoted comment.
- The source is opened only for reading. The supplied example is a byte-for-byte
  copy of the attachment, not a transcription or rewritten CSV.

## Session summary

Sessions are grouped by their exact decoded string, with no case folding or
whitespace/Unicode normalization. Each session's response count includes every
row, and its score total uses the numeric value of the validated score.

Summary rows follow **first appearance of each session in the input**. This is
deterministic, locale-independent, and deliberately not alphabetical order.
For the supplied eight responses:

| Session | response_count | score_total |
| --- | ---: | ---: |
| Paper circuits — débutants | 3 | 11 |
| Textile & mending | 3 | 8 |
| 海辺の読書会 | 2 | 8 |

## Invalid-input and output guarantees

The complete input is read, decoded, parsed, structurally validated, and score
validated, and both output CSVs are rendered in memory **before any output path
is created**. Therefore an invalid row after valid rows still produces no export
directory, partial CSV, or temporary output. Existing destinations remain
untouched, including when input is invalid.

Only after validation does the command exclusively create the new directory and
write its two files. For a normal write-time I/O error, it attempts to remove the
files/directory it created and reports any cleanup failure. This is **not** a
two-file crash/power-loss transaction: an interrupted valid export can leave a
partial directory. Consumers should wait for exit status 0. Do not edit or replace
the destination concurrently. The invalid-input guarantee does not depend on
cleanup because invalid input never reaches output creation.

This command keeps the input and rendered outputs in memory; it is intended for
small workshop exports, not unbounded streaming datasets.

## This is NOT anonymization

Only the `response_id` and `contact_email` **columns** are dropped. Identifiers in
comments, session titles, or other retained text are intentionally preserved. In
particular, the supplied fictional Mara comment still contains
`mara@example.invalid`. Neither the projected CSV nor its summary should be
assumed anonymous or safe for public release. Review free text and contextual
identifiers separately before sharing real feedback.

Formula-looking text is also preserved, not escaped or sanitized. If inspecting
untrusted CSV in a spreadsheet, import fields as text rather than evaluating them.
The included original input still contains all five columns and is clearly
fictional; it is included for review, not as an anonymized artifact.

## Focused tests

~~~sh
python3 -B -m unittest -v test_export_feedback.py
~~~

The 13 tests invoke the actual command in subprocesses; they do not import or mock
the exporter. They cover exact projection, supplied summary values, free-text
identifiers, CSV quoting, Unicode, embedded newline forms, BOM input, whitespace
and score spelling, long comments, header-only input, invalid headers/rows/scores,
malformed CSV, invalid UTF-8, late invalid records, output collisions, source
preservation, and missing paths. Temporary test directories are isolated and
cleaned up; `-B` avoids bytecode caches.

## Included examples and reproduction

The packaged valid outputs were actually generated with:

~~~sh
python3 -B export_feedback.py examples/fictional-workshop-feedback.csv examples/valid-output
python3 -B export_feedback.py examples/valid-edge-cases.csv examples/valid-edge-output
~~~

Those directories are already included, so rerunning those exact commands refuses
them. For independent reproduction, use fresh names instead:

~~~sh
python3 -B export_feedback.py examples/fictional-workshop-feedback.csv review-output
python3 -B export_feedback.py examples/valid-edge-cases.csv review-edge-output
~~~

Each command creates `feedback.csv` and `session-summary.csv` in its destination.
The edge example includes a BOM, a quoted comma/quote/CRLF comment, Unicode,
whitespace, alternate valid score spellings, a free-text email, and empty fields.

Run these examples separately; **each is expected to fail with exit status 1**:

~~~sh
python3 -B export_feedback.py examples/invalid-score-after-valid.csv review-invalid-score
python3 -B export_feedback.py examples/invalid-short-row.csv review-invalid-row
python3 -B export_feedback.py examples/invalid-header.csv review-invalid-header
python3 -B export_feedback.py examples/invalid-quoting.csv review-invalid-quoting
python3 -B export_feedback.py examples/invalid-utf8.csv review-invalid-utf8
~~~

Expected diagnostics:

| Input | Error |
| --- | --- |
| `invalid-score-after-valid.csv` | Data row 2, physical line 3: score must be an integer from 1 through 5 |
| `invalid-short-row.csv` | Data row 2, physical line 3: expected 5 fields, found 4 |
| `invalid-header.csv` | Header must be exactly the required five names (the example duplicates `score`) |
| `invalid-quoting.csv` | Data row 2: malformed CSV, unexpected end of data |
| `invalid-utf8.csv` | Invalid UTF-8, invalid start byte |

All but the header example have valid data before the invalid record/bytes. No
`review-invalid-*` destination should be created. The tests explicitly verify the
no-output guarantee and unchanged input bytes, rather than treating every nonzero
status as an unexplained success.

The archive contains only this README, the command, the focused test file, the
exact supplied input, the valid edge input, five invalid inputs, and the two pairs
of generated valid output CSVs. No logs, histories, audit files, caches, dependencies,
or temporary test files are included.
