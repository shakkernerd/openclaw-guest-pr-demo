# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively.

## Delivery-address formatting

`delivery-address.js` exports the CommonJS helper `formatDeliveryAddress(lines)`.
Pass a nonempty array of nonblank, single-line strings in the exact order wanted
on the label, including the recipient. The helper joins them with LF (`\n`) and
adds no trailing newline. Accepted strings remain unchanged, including Unicode,
combining characters, capitalization, punctuation, surrounding whitespace, and
duplicate lines. It does not trim or normalize output or mutate the input.

Nonarrays, missing/sparse entries (including inherited-only entries), and
nonstring entries throw `TypeError`; an empty array, blank lines, or embedded
line breaks throw `RangeError`. Blank means empty or whitespace-only according to
JavaScript `String.prototype.trim()`; trimming is used only to check blankness.
Prohibited line breaks are LF (U+000A), CR (U+000D), vertical tab (U+000B), form
feed (U+000C), NEL (U+0085), line separator (U+2028), and paragraph separator
(U+2029). No values are coerced to strings.

Run this consumer example from the repository root:

```sh
node <<'NODE'
const { formatDeliveryAddress } = require("./delivery-address.js");

const label = formatDeliveryAddress([
  "Zoë Martin",
  "12 rue des Écoles",
  "75005 Paris",
  "France",
]);

console.log(label);
NODE
```

Output:

```text
Zoë Martin
12 rue des Écoles
75005 Paris
France
```

`console.log` adds a terminal newline; the returned label has none.

This formats plain caller-supplied text only, not verified or HTML-escaped
address data. It does not verify identity, completeness, postal correctness, or
deliverability, and does not authorize dispatch. Even one nonblank line is
accepted. Callers remain responsible for address verification, safe rendering
in their chosen output context, and dispatch decisions; the existing manual
checks still apply.

`delivery-address.test.js` covers this contract using the same `node --test`
command above.

## Offline line editor

Open `delivery-address.html` directly as a local file in a browser, keeping
`delivery-address.css`, `delivery-address.js`, `delivery-address-draft.js`,
and `delivery-address-editor.js`
beside it. No server, build, installation, or network connection is needed.
The page loads the canonical helper as a classic script, exposing the same
`formatDeliveryAddress` function globally; its CommonJS export is unchanged.

The editor starts with one empty draft textarea. Add line appends a blank row
and focuses it. Remove preserves the remaining values and order, focusing the
next row, the previous row if last, or Add line when none remain. Move up and
Move down relocate the existing row one position and focus its textarea,
preserving all draft values, controls, IDs, and text selections. Labels follow
the current order. Move up is disabled on the first row and Move down on the
last; both are disabled with one row. A boundary no-op changes nothing.
There is no required street/city/postcode schema.

Only Format address passes the browser-held textarea values, unchanged, to the
canonical formatter. Embedded line breaks remain draft data and cause its
normal errors, as do blank lines or removing every row. Errors preserve all
drafts and are announced in the status area. Any edit, addition, removal, or
real move immediately clears the old result and obsolete error without
revalidating. Moving never formats automatically: choose Format address to
format the current textarea order.
Draft controls are not rebuilt while typing. Browsers may normalize textarea
line endings; the editor does not transform the values they expose.

Successful output is read-only, selectable plain text, not HTML, with exact LF
separators and no final newline. Tab to the output and use the browser's normal
text-selection keys if needed. Formatting does not verify a postal address or
authorize dispatch. There is no printing, clipboard API, storage, network request, postal
verification, dispatch, or extra address field.

`delivery-address-editor.test.js` uses Node's built-in VM and a small DOM test
double to load the real HTML entry's scripts and exercise the event lifecycle.
It is not browser, rendering, accessibility, native Files, standalone, or narrow
viewport proof; those need separate checks in an approved browser. The PR43
base (`047eba34abd79b0af1f1d9caa0602d8f671b6bdd`) had only the helper and no
editor or browser UI. This new page's empty draft is not a pre-change UI.

### Explicit offline draft interchange

Choose a local file with **Import draft JSON file**. The interchange is UTF-8 JSON
containing an array of strings, including `[]`. It is **lossless-or-refuse for
parsed values**, not arbitrary-string roundtripping or preservation of original
JSON bytes, whitespace, escape spelling, or formatting. Blank strings, LF-multiline
drafts, Unicode (including combining sequences), surrounding whitespace,
duplicates, and order are preserved exactly. There is no trimming, coercion,
Unicode normalization, repair, or postal validation on import.

**Every CR (U+000D), including escaped `\r` and CR in CRLF, is refused for the
whole import**: native textarea values normalize CR and cannot preserve it.
A single leading UTF-8 encoding BOM is accepted and consumed by the fatal UTF-8
decoder; literal U+FEFF inside JSON strings remains unchanged. Malformed UTF-8,
malformed JSON, nonarrays, and nonstring entries are refused atomically. CR/CRLF
used only as JSON whitespace outside strings is fine, including after the encoding
BOM. Blank/LF drafts remain importable even though the unchanged canonical formatter
will reject them when you explicitly format.

Reading produces a validated, frozen staged snapshot and a read-only JSON preview.
Nothing is applied until **Replace draft**. That decision discards the then-current
draft, including edits made while reading or after staging. Replace uses only the
snapshot, not a reread of the file or editable preview text; it reuses the row,
label, invalidation, and focus owner. It clears formatted output and focuses the
first new textarea, or Add line for `[]`. **Cancel import** and any read/validation
error preserve the current controls, values, and formatted output. You may choose
another file or continue editing while reading. The editor's generation guard
ignores obsolete successes and failures after a new selection, Cancel, Replace,
or pagehide. Cancelling does not abort the underlying file read.

**Export draft JSON** explicitly snapshots the current ordered raw textarea
values, without formatting, using the same codec. It requests a standard Blob/URL
anchor download named `address-draft.json` and also displays read-only selectable
JSON. The download link remains available for retry; a download request is not
proof that a browser saved a file. If download creation fails, select the JSON
fallback. There is no File System Access API or automatic persistence.

The displayed export snapshot and object URL share the existing invalidation
lifecycle: any edit, Add, Remove, real Move, Replace, or Format clears them. A
boundary Move, import read/staging, Cancel, or import error does not. A new export
releases the previous URL; pagehide releases it and clears pending import state.
Already downloaded files remain unchanged. Export again to obtain current values.

The codec has one owner in `delivery-address-draft.js`, available as a classic
script for the editor and as the CommonJS export `{ addressDraftCodec }` for the
developer command below. Both codec surfaces are consumed in production (decode
for import/the command; encode for preview/export). There is no test-only branch
or exported UI seam. Entry-driven tests cover
independently specified accepted values, atomic refusals, delayed read settlement,
Replace/Cancel, export contents and URL lifetime, and existing editor behavior.
They use native Node TextDecoder/Blob/URL and the small existing DOM double.
Deterministic deferred promises exercise the **editor's generation owner**, not
native file scheduling, file dialogs, downloads, textarea normalization, browser
focus, accessibility, layout, or narrow viewports. Those proofs belong to the
retained approved browser; the Node suite does not claim them.

## Batch-format saved address drafts

With Node.js 22 or newer, run from the repository root:

```sh
node format-address-drafts.js path/to/first.json './draft with spaces.json' path/to/first.json
```

Every argument after the script is a literal file path, read relative to the
current working directory when relative. Supplied spelling, order, and duplicate
occurrences are retained; each occurrence is read and reported separately. There
are no options (even `--help`, `--`, and `-` are file names), stdin input, glob
expansion, directory discovery, or recursive traversal. Quote paths to prevent
shell expansion; the command does not expand them itself. It writes no input or
output files and does not repair, trim, normalize, verify, or persist addresses.
It uses no network or service.

The command passes raw file bytes to the existing draft decoder, then passes the
accepted values unchanged to `formatDeliveryAddress`. The codec and formatter
above remain the sole rule owners. An importable draft is **not necessarily
formattable**: `[]`, blank strings, and LF-multiline values decode successfully
but fail canonical formatting. CR in a value instead fails decoding. A leading
encoding BOM is accepted, and literal FEFF inside a value remains data.

With at least one argument, stdout is one complete JSON document followed by
exactly one LF:

```json
{"total":1,"succeeded":1,"failed":0,"results":[{"position":1,"file":"draft.json","ok":true,"formatted":"Recipient\nStreet"}]}
```

This example assumes `draft.json` contains `["Recipient", "Street"]`.
`total` equals the argument count and `succeeded + failed` equals `total`.
`results` has one record per argument in the same order, with 1-based `position`,
`file` exactly as supplied, and `ok`. Success adds `formatted`, the canonical
formatter's exact string (JSON escapes such as `\n` represent that string).
Failure adds only `error: { stage, name, message }` instead of `formatted`.
`stage` is `read`, `decode`, or `format`, identifying the owner that failed;
ordinary error names/messages are retained. Processing continues after ordinary
per-file failures. For example, `[]` produces a `format` error named `RangeError`
with message `lines must not be empty`. Native read-error wording is supplied by
Node/the operating system.

Exit status is **0** when every named file succeeds, **1** when any file fails,
or **2** with no arguments. With no arguments, stderr contains
`Usage: node format-address-drafts.js FILE...` and one LF; stdout is empty.
Per-file failures are in the JSON report, not stderr. Normal Node stream/exit
handling lets queued output drain; unexpected runtime or output-stream failures
remain native Node errors, not successful file records. Files are read one at a
time, but the complete report is held in memory; this is not a streaming or
unbounded-input tool. It provides no snapshot guarantee against another process
changing an input between occurrences.

Focused command tests:

```sh
node --test format-address-drafts.test.js
```

These use the real subprocess entry and materialize the four exact supplied
synthetic interchange byte sequences from escaped UTF-8 literals in test-owned
temporary files. Each run verifies their known sizes/SHA256 identities and
unchanged bytes afterward, then removes its temporary directory in a finally
block. Independent expected results cover duplicate paths, all three failure
stages, no-argument usage, and output larger than a pipe buffer. The real command
exercises the production CommonJS codec; directly relevant unchanged classic
HTML-entry tests cover its browser-script use without a duplicate codec-rule
suite or test-only production API. Those Node checks are not actual browser
compatibility proof. Browser behavior and interchange policy are unchanged;
actual client checks remain with the retained approved browser.

## Offline saved batch-report viewer

Open `saved-batch-report.html` directly as a local file, keeping
`saved-batch-report.css`, `saved-batch-report.js`, and
`saved-batch-report-viewer.js` beside it. No server, installation, dependency, or
network connection is needed. Choose one **saved report (UTF-8 JSON)**: the entire
stdout JSON document previously saved from the batch command, not an address
draft. The viewer never runs or imports the batch command, draft codec, or
formatter and never opens paths named by report occurrences. CSV export is an
explicit local download; there is no clipboard, printing, storage, automatic
persistence, network, or dispatch behavior. The saved JSON is never changed.

The input boundary decodes UTF-8 fatally, parses once, and validates the envelope,
counts, and result shapes once per current completed read. A leading UTF-8
encoding BOM is consumed; FEFF inside parsed strings remains data. It requires
safe nonnegative integer `total`, `succeeded`, and `failed`, matching the results
length and actual outcome counts. Results must have consecutive 1-based
`position`, string `file`, boolean `ok`, and either string `formatted` for success
or `error` with stage `read`/`decode`/`format` and string `name`/`message` for failure.
A zero-total report with `results: []` is valid. Unknown fields remain in the
parsed report but are not interpreted or displayed; there is no added schema or
version. Structural acceptance does not establish authenticity, freshness,
postal validity, or whether any saved success would format successfully now.

Every required string may be empty. Parsed values retain whitespace, FEFF,
Unicode, LF, CR, and CRLF without trimming, coercion, repair, or normalization.
This is preservation of **parsed strings**, not original JSON escape spelling or
byte formatting. The app does not modify the selected file. Read-only text nodes
in `pre` elements, not textarea values or HTML, present file names, formatted
output, and errors. Empty strings get a separate annotation. Browser layout may
render different whitespace/line-break characters alike; the underlying text
is not rewritten. Use normal browser text selection; literal fields are
keyboard-focusable, with visible focus styles. There is no custom selection or
clipboard handler.

The single file boundary owns the accepted report separately from latest-read
status. The page labels both the latest selection and the **displayed accepted
report**, with its file name, read byte count, and full original totals. Reading,
invalid data, read failure, and empty/cancelled selections leave accepted content
intact. Only a newer valid read replaces it atomically. Obsolete read successes
and errors cannot replace accepted data or newer status. Cancelling the native
picker (in browsers that emit its standard `cancel` event), an empty selection,
and leaving the page invalidate pending work without aborting its underlying
read. There is no persistence after closing/reloading. You can reselect the same
file; the picker resets after capturing each choice, independently of accepted
identity.

**All**, **Successes**, **All failures**, and **Read/Decode/Format failures**
combine with **Search occurrences** to project rows only. Search matches a
case-insensitive literal substring in each occurrence’s recorded filename, saved
successful output, or saved failure name/message. A match in any one of those
fields is enough, but the occurrence must also pass the outcome filter. Error
stages, positions, the selected report’s filename, and unknown fields are not
searched; matches never span fields. Matching uses JavaScript `toLowerCase()`
and `includes()`, not regex, tokenization, trimming, accent folding, or Unicode
normalization. This is a native **single-line search** field. Matching uses the
field’s actual displayed value, including supported spaces, tabs and punctuation;
a spaces-only query is not empty. Browsers may change line breaks entered into
this single-line field before matching. No escape sequences are interpreted.
Search does not rerun formatting or alter stored report text or input files.

An empty query shows everything allowed by the outcome filter. Both the exact
query and selected filter persist across all loads, including valid replacements,
invalid/read-failed files, and cancelled/empty selections (not page reloads).
**Clear search** clears only the query and returns focus to the labelled search
input; the native button is keyboard-usable. Choose **All** and clear the search
to see every occurrence again. Full totals, literal file spelling, original
positions, order, and duplicates remain unchanged. The live visible count shows
matching occurrences out of the full total, with the active outcome filter and
query. No accepted report, an accepted zero-result report, and no matches have
distinct messages; no-match guidance suggests clearing search or changing the
filter. Status-only updates leave the displayed accepted row elements in place.

### Export all occurrences as CSV

Choose **Export all occurrences CSV** to request a download named
`saved-batch-report.csv`. It snapshots **every occurrence in the displayed
accepted report**, regardless of the selected outcome filter or search, retaining
original order, positions, duplicate paths, and exact file spelling. It does not reread the
report, open any named draft, or run the batch command, draft codec, or formatter.
Without an accepted report export is unavailable; an accepted zero-result report
exports headers only. The saved JSON remains authoritative: CSV is a projection, not a
replacement or a report-import format.

Columns, in order:

| Column | Value |
| --- | --- |
| `position` | Original 1-based occurrence position |
| `file` | Exact recorded file path, including for failures |
| `status` | `success` or `failure`, derived from `ok` |
| `formatted` | Exact saved success text in one cell; empty for failures |
| `error_stage` | Recorded `read`, `decode`, or `format`; empty for successes |
| `error_name` | Exact recorded error name; empty for successes |
| `error_message` | Exact recorded error message; empty for successes |

Totals, viewer annotations, and unknown fields are not exported. Empty recorded
strings stay empty; status distinguishes an empty success from a failure.
The CSV is UTF-8 without an added encoding BOM, with comma delimiters and every
cell (including headers) double-quoted. Embedded quotes are doubled. Records end
with CRLF, including the final record. Inside cells, LF, CR, CRLF, whitespace,
FEFF, and Unicode remain unchanged: no flattening, trimming, normalization, or
address reformatting. This preserves parsed string values, not JSON escape
spelling or original JSON bytes. An exported field containing an unpaired
UTF-16 surrogate refuses the whole export with a clear error, because UTF-8
cannot encode it losslessly; report acceptance and viewing remain unchanged.

**Spreadsheet caution:** CSV quoting protects field boundaries, not cell types
or formula safety. Spreadsheet applications may interpret values beginning with
`=`, `+`, `-`, `@`, or certain whitespace/control characters as formulas, and may
coerce dates or leading-zero identifiers. Export does not silently add apostrophes,
tabs, or other protective prefixes. Prefer explicit import as UTF-8,
comma-separated, double-quote-delimited data with **all columns set to Text**, not
double-click opening. Import settings vary; CSV cannot enforce text types,
prevent formula interpretation, or guarantee exact values after spreadsheet
import and re-saving. Retain the authoritative JSON.

**Download CSV again** retries the same snapshot without changing the view.
The link and export survive search/filter changes, pending reads, invalid files,
read failures, and cancelled/empty selections. A new accepted report, another export,
or leaving the page releases the previous object URL and clears stale export
state; already downloaded files are unaffected. Download creation failures have
a separate status and can be retried with the export button. A download request
does not prove that the browser saved a file. No report, query, or filter state
is changed by export or retry.

### Viewer verification

Run the viewer’s focused native Node checks with:

```sh
node --test saved-batch-report.test.js saved-batch-report-viewer.test.js
```

The boundary tests load the actual production boundary through its classic-script
surface in a Node VM, rather than its CommonJS export or a fake browser. The two
small fixtures are retained saved stdout documents, consumed directly with independent
expected results and byte identities; they do not authorize reading any paths
inside them. Tests cover literal/empty strings, envelope/count/shape refusals,
search/filter intersection and duplicate order, literal spaces/punctuation and
case matching across the defined fields, atomic replacement, controlled
asynchronous success/error/empty selection races, and full-report CSV export. CSV
assertions use independently specified expected strings and native Blob bytes, including
quoting, mixed line endings, Unicode, empty/error fields, formula-like text,
and lossless export refusal. They also check that export does not reread inputs
or mutate accepted state. The deferred reads prove the boundary's generation
logic, **not native filesystem timing**. They never execute the batch command,
draft codec, formatter, or old tests. Native Files, standalone loading, actual UI
rendering, filter controls, narrow layout, and keyboard/accessibility behavior
require an available approved browser; these Node checks are not that proof.

`saved-batch-report-viewer.test.js` loads the actual HTML entry’s two production
scripts with a bounded DOM double, following the existing editor-test approach.
It exercises input/change/clear handlers, labels/live-count wiring, focus requests,
rendered text and empty states, query/filter persistence, accepted row identity
during read-status changes, and full CSV Blob bytes/object-URL lifetime through
search changes, retry, failed reads, replacement, re-export, and pagehide. These
are executable UI lifecycle checks, **not** browser rendering, native keyboard,
file-picker cancellation, actual download, accessibility, or screen-reader proof.

For browser verification, load a known saved report from the standalone page;
check the actual downloaded CSV bytes and parsed cells, not just its link or
status. Exercise filename/output/error searches with mixed case, literal spaces
and punctuation such as `[1]` and `.*`, in combination with outcome filters.
Check no matches, Clear search using Tab then Enter/Space, focus return, and
query/filter persistence across valid/invalid/cancelled/read-failed selections.
Exercise export with both search and an outcome filter active (including no
visible rows), retry after a later invalid/read-failed selection, replacement
and URL cleanup, zero results, lossless refusal, and download failure/recovery.
Check keyboard operation, live status, narrow layout, and the absence of
draft-file or network access. Browser checks do not establish
spreadsheet application compatibility or screen-reader behavior.

## Compare two saved batch reports offline

Open `saved-batch-comparison.html` directly as a local file, keeping
`saved-batch-report.js`, `saved-batch-report.css`, `saved-batch-comparison.js`,
`saved-batch-comparison.css`, and `saved-batch-comparison-viewer.js` beside it. The single-report viewer links to this separate page. No server,
installation, network, storage, or application dependency is needed. The browser
comparison has no CSV export; the read-only comparison CLI is described below.
The existing validator and single-report CSV contract are unchanged. It never
reads paths recorded in results or runs/imports the batch command, draft codec,
or formatter.

Choose **Original** and **Rerun** UTF-8 JSON reports. Both use the existing shared
report decoder, without a second schema or new report version. Each side has its
own accepted snapshot and asynchronous read generation. Pending, invalid,
read-failed, cancelled/empty, and obsolete reads do not replace accepted reports
or clear mappings. A newly accepted report on either side clears all explicit
mappings, even when it has the same name or contents; automatic matching is
recomputed from the accepted pair. Closing/reloading does not persist anything.
Read-status-only updates keep comparison row elements in place.

### Correspondence is separate from outcome

- Auto-pair only an **exact path appearing once in each full report**, labelled
  **unique exact-path convention, not proof of identity**. Filtering or explicitly
  mapping other rows never makes a duplicate path unique. No basename, UUID,
  position, case, slash, whitespace, or Unicode normalization is performed.
- Renamed/restaged inputs need explicit one-to-one mappings selected by occurrence
  positions in the accepted reports. This records a user's assertion, not a name
  inference. Explicit mappings take priority over automatic conventions. Duplicate
  original or rerun endpoints are refused atomically; remove a conflicting explicit
  mapping before changing it. Removing one recalculates automatic conventions.
- Duplicate-path groups remain ambiguous until explicitly mapped, including a
  lone leftover after another duplicate is mapped. Every occurrence is retained;
  one rerun occurrence cannot resolve multiple originals.
- Rows follow original occurrence order, followed by unpaired rerun occurrences
  in rerun order. Each row shows both report-local positions and exact paths.
  Original-only means **no established rerun counterpart; not reverified**. It
  does not mean fixed, deleted, or necessarily never rerun. Rerun-only does not
  prove a new input. Ambiguity is an additional flag on unpaired occurrences,
  not another count to add to the original-only/rerun-only totals.

Paired results distinguish recorded failure→success, recorded success→failure
(regression), success with same/changed output, and **still failed with same/changed
error**. A changed error remains a failure. Compare exact parsed `formatted`
strings or the entire `error.stage/name/message` tuple, including all whitespace,
line endings, empty strings, Unicode, and unpaired UTF-16 surrogates. Unknown fields
and JSON escape/byte formatting are not compared. Path and position changes are
separate from outcome/content changes. Literal text nodes retain saved strings.
Optional escaped-string disclosures show JSON escapes, including tabs, line endings, quotes, and lone surrogates. Other invisible Unicode characters remain literal; changed strings can still look identical in both displays.

Full original and rerun totals are separate. Comparison counts include paired,
original-only, rerun-only, ambiguous unpaired occurrences, and all six paired
outcome categories. Each pair uses one display row; every unpaired occurrence
uses one row. Filters affect only display, never matching or counts. No accepted
pair, two accepted empty reports, and no filter matches have distinct messages.
A smaller failure count across different populations is not a fix rate. Saved
successes and mapped transitions do not establish authenticity or current validity.

### Supplied failures-only example

The retained `saved-batch-report-fixtures/comparison-original.json` has five
occurrences (three successes, two failures); `comparison-rerun.json` has two
successes. Their paths do not match. Without explicit mappings, show five
original-only and two rerun-only occurrences, with no inferred transitions.

For these fixtures, the requester explicitly confirmed original **2 → rerun 1**
and original **4 → rerun 2**, and that only failures were rerun. Enter those two
mappings: the result is **two recorded failure→success transitions**, plus **three
original-only occurrences not reverified** (north twice, south once). Filenames
do not prove these mappings. The app deliberately does not prefill or generalize
them; the original reports remain unchanged.

### Read-only comparison command

With Node.js 22 or newer:

```sh
node compare-address-reports.js ORIGINAL RERUN
node compare-address-reports.js ORIGINAL RERUN --mappings MAPPING_FILE
node compare-address-reports.js saved-batch-report-fixtures/comparison-original.json saved-batch-report-fixtures/comparison-rerun.json
```

Supply either exactly two literal filenames, or exactly four arguments with
`--mappings` in the third position. Every filename position remains literal,
including `--mappings`, `--help`, `--`, `-`, spaces and glob characters. In the
two-argument form there are still no options. Relative paths resolve from the
current working directory; quote paths to prevent shell expansion. Other forms
(including a missing mapping filename, prefix options, `--mappings=FILE` and extra
arguments) are refused before any input read. There is no stdin input, application
glob expansion, directory discovery or recursive traversal. The command writes
no files and never opens paths recorded inside either report or a mapping. It
does not load or run the draft codec, formatter or batch command, or use a
network/service.

The command reads and fully decodes **original first, rerun second, and the
optional mapping file last**, stopping at the first failure. A failed original
prevents both later reads; a failed rerun prevents the mapping read. Reports use
`savedBatchReportCodec.decode` unchanged. The guarded CommonJS export
`{ compare }` in `saved-batch-comparison.js` references the existing pure
`SavedBatchComparison.compare` operation; it does not expose or instantiate
browser loading/mapping state. The CLI calls it once after all inputs are
accepted and emits only the completed result. The browser workflow is unchanged.

The mapping file is one UTF-8 JSON array of non-null, non-array objects, for
example (positions must be reviewed for the particular chosen report pair):

```json
[{"originalPosition":2,"rerunPosition":1},{"originalPosition":4,"rerunPosition":2}]
```

UTF-8 is decoded fatally, consuming one leading encoding BOM consistently with
the report decoder. Malformed UTF-8/JSON and invalid array/entry shapes refuse the
whole request. Unknown fields are ignored, not read as paths or provenance. No
coercion, sorting, deduplication, repair, report fingerprint binding or automatic
mapping-file generation is performed. `[]` is equivalent to no option; an empty
or whitespace-only file is invalid JSON. There is no wrapper or new report version.

The existing pure comparison owner alone validates positions: both must be safe
integers identifying 1-based occurrences in their respective full accepted
reports, not comparison-row indices. Missing, wrong-type and out-of-range
positions are refused. Reusing either endpoint, even repeating an identical
pair, refuses the whole request rather than choosing a winner or emitting a
partial result. Explicit mappings take priority over automatic conventions and
may connect different paths or outcomes. They are **reviewer assertions for the
chosen reports**, not proof of identity, authenticity, freshness, current
formattability, postal validity or permission to dispatch. Selecting the intended
report pair remains the reviewer’s responsibility.

Without mappings the automatic comparison is unchanged. Only paths appearing
exactly once in each **full report** pair automatically; explicit mappings never
make leftover duplicate paths unique. Unmapped duplicates remain ambiguous,
including a lone leftover on each side. Different spellings/restaged paths are
never inferred to match. An explicit row has `basis: "explicit"`; its
`ambiguous: false` records the selected counterpart, not verified identity.

On success, stdout is the existing comparison result as **one compact JSON
object plus one LF**, with `rows` and `counts`, and stderr is empty. Rows retain
original order followed by unpaired rerun order. Counts include paired,
originalOnly, rerunOnly, ambiguousOccurrences, and all six paired outcome kinds
listed above. Original-only means **not reverified**, not fixed/deleted;
rerun-only does not prove a new input. Parsed literal strings and recorded
outcome distinctions are preserved, including changed errors that remain
failures. Unknown occurrence fields survive in the result but do not influence
comparison; original JSON whitespace/escape spelling is not preserved.

- Exit **0**: comparison completed with accepted reports and optional mappings,
  including empty reports, recorded failures/regressions, duplicates and unmatched
  rows. Success has empty stderr and no added output fields or warnings.
- Exit **1**: read/decode failure or refused mapping; stdout is empty. Existing
  report diagnostics retain original/rerun, the quoted supplied filename, stage
  (`read` or `decode`) and error name/message. Mapping diagnostics are
  `mapping file "FILENAME" (STAGE): ErrorName: message` plus LF; the supplied
  filename is JSON-quoted and stage is `read`, `decode` or `compare`. The comparison
  owner’s position/conflict messages are preserved. Decode includes UTF-8, JSON
  and structural validation; native read wording depends on Node/the OS. No
  partial result or fallback automatic comparison is emitted on refusal.
- Exit **2**: invalid argument form, before input reads; stdout is empty and
  stderr is `Usage: node compare-address-reports.js ORIGINAL RERUN [--mappings MAPPING_FILE]` plus LF.

The checked-in example without a mapping file yields 0 pairs, 5 original-only, 2 rerun-only and 2
ambiguous occurrences (the duplicate north rows), with all paired outcome counts
zero. The reports record different `media/inbound/openclaw-staged-…/` directories
(`6a4c983b-…` versus `b37ab9bd-…`), and the rerun uses `.corrected` filenames with
different UUID suffixes. No exact path is shared, so the confirmed mappings
above cannot be assumed by this command: they must be supplied explicitly for
that particular pair. They must not be transferred to other saved batches. The
saved successes are merely reported, not reformatted or reverified.

Reports and the full result are held in memory, not streamed; reads are
sequential, not a cross-file atomic snapshot. Acceptance proves structure, not
authenticity, freshness, identity, postal validity or current formattability.
Unexpected runtime/output-stream errors remain native Node errors.

#### Mapping-file CLI checks

```sh
node --test compare-address-reports.test.js
```

The focused CLI suite retains the automatic-only cases and adds real-subprocess
checks for the exact grammar, literal filenames, empty/BOM mappings, boundary
refusals, owner error messages, explicit priority and conservative duplicate
leftovers. Expectations are independent rows/counts, not generated by calling the
comparison owner. A bounded test-only preload observes actual child reads for
ordering and no-later-read assertions; it does not replace their results or add
a production seam. The BOM/metadata case checks accepted input, ignored metadata
without opening its paths, and ambiguous duplicate leftovers; it does not prove
byte preservation through the comparison owner, which receives parsed objects.
Linux `/dev/full` exercises the observed output-sink failure only, not the
comparison classifier’s unrecognized-error rethrow branch. That branch is
source-reviewed. The narrow classifier recognizes the two current owner mapping
messages; a future owner-message change requires reviewing this adapter.

Each helper invocation creates its own test-owned temporary case root. It
captures child return values and read observations in memory for assertions,
checks unchanged input bytes and no CLI-created files, and removes that exact
root (including observer/log files) in `finally`, on success or failure. It does
not retain ordinary-run evidence or delete earlier campaign artifacts.
Decoder/comparison/browser rules and prior evidence are reused, not a claim of
a new browser run.

#### Prior automatic-only CLI verification (historical)

The following verification description is retained from before the mapping-file
addition; its cleanup description applies to that earlier test helper.

Bounded CLI/module-boundary checks (no formatter or browser run):

```sh
node --test compare-address-reports.test.js saved-batch-comparison.test.js
```

New real-subprocess cases cover outcomes, literal values/filenames, duplicate and
unmatched ordering, read/decode precedence, usage, unchanged inputs and no saved
output files. Tests remove only their own newly created fixtures in `finally`.
Decoder/viewer/CSV and actual-browser evidence in
`saved-batch-comparison-checks.md` is prior evidence, not reverified by this run.

### Focused comparison verification

```sh
node --test saved-batch-comparison.test.js saved-batch-report.test.js validate-address-report.test.js
```

These load the actual classic-script comparison model and shared decoder, retain
fixture byte identities, and cover conservative matching, duplicate leftovers,
one-to-one conflicts, all outcomes, exact text/error comparison, unknown fields,
empty inputs, snapshot immutability, and independent/stale read races. Deferred
reads prove generation behavior, not native filesystem timing.

An optional real-Chromium check is retained in
`saved-batch-comparison.browser-check.js`. Playwright is test-only; supply an
existing installation rather than adding any application dependency:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core \
BROWSER_EXECUTABLE=/path/to/chromium \
BROWSER_ARTIFACT_DIR=/path/to/local-evidence \
node saved-batch-comparison.browser-check.js
```

It opens the standalone pages via `file://` in an offline browser, uses native
file inputs, enters mappings, checks actual DOM values and narrow layout, and
compares downloaded single-report CSV bytes (not just a link/status). Controlled
read faults and cancel events supplement native reads; they are not native picker
cancellation or filesystem timing proof. It records screenshots, request/error
logs, and local CSV evidence. No draft paths or external URLs should be requested.
Keyboard checks and live-status attributes are not screen-reader proof; Chromium
checks do not establish other-browser or spreadsheet compatibility.

## Validate one saved address report

With Node.js 22 or newer, run from the repository root:

```sh
node validate-address-report.js path/to/report.json
```

Supply exactly one literal file path, relative to the current working directory
when relative. There are no options: `--help`, `--`, and `-` are filenames. There
is no stdin input, glob expansion, directory discovery, or recursive traversal;
quote paths to prevent shell expansion. The command reads the named report once
and writes no files. It never opens occurrence paths or imports/runs the draft
codec, formatter, or batch command. No dependencies, services, or network are
needed.

The viewer and command share `savedBatchReportCodec.decode(bytes)` in
`saved-batch-report.js`, exported for CommonJS as `{ savedBatchReportCodec }`.
Both entry points use the report validation rules above; there is no second
schema or new report version. CSV serialization belongs to the viewer boundary,
not this decoder or the CLI. CSV-only lossless-export refusals do not change
structural report acceptance. Raw bytes go directly to that decoder. The complete
report is held in memory, not streamed.

For one argument, stdout is one compact JSON verdict followed by exactly one LF;
`file` retains the supplied spelling. A structurally valid report produces:

```json
{"file":"report.json","ok":true,"total":6,"succeeded":2,"failed":4}
```

Exit **0** means the report is valid, even if some or all recorded occurrences
failed. A zero-result report is also valid. Totals are from the validated report;
occurrence contents are not repeated in the verdict. An unreadable or invalid
report exits **1**, for example:

```json
{"file":"report.json","ok":false,"error":{"stage":"decode","name":"TypeError","message":"total must be a safe nonnegative integer"}}
```

`stage` is `read` for filesystem errors or `decode` for UTF-8, JSON, and structural
validation errors. Error names/messages are retained; native read-error wording
depends on Node/the operating system. Ordinary failures are in stdout JSON, with
empty stderr. Zero or multiple arguments exit **2** before any report read, with
empty stdout and `Usage: node validate-address-report.js FILE` plus LF on stderr.
Normal Node stream/exit handling lets output drain; unexpected runtime or
output-stream failures remain native errors.

Acceptance checks structure only, not authenticity, freshness, postal validity,
or whether a recorded success would format successfully now. It never repairs
or rewrites the saved report.

Focused command and viewer checks:

```sh
node --test validate-address-report.test.js saved-batch-report.test.js
```

The new tests use the real subprocess entry, retained saved-report fixtures, and
test-owned temporary files. They check verdicts, exit codes, literal paths, ignored
stdin, unchanged input bytes, no output files, and representative decoder errors.
Valid empty, mixed, all-failure, and formatter-incompatible saved contents are
covered without reopening draft paths or rerunning the formatter. The existing
viewer suite retains comprehensive schema, preservation, filtering, and race
coverage; it is not duplicated in the command suite. These are Node boundary
checks, not new native-browser compatibility proof.
