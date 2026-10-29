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
draft. The viewer never runs or imports the command, codec, or formatter and
never opens paths named by report occurrences. It has no export, clipboard,
printing, storage, automatic persistence, network, or dispatch behavior.

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
project rows only. The selected filter persists across all loads and failures;
choose **All** to reset that projection. Full totals, literal file spelling,
original positions, order, and duplicate occurrences remain unchanged. Visible
count is labelled separately. No accepted report, an accepted zero-result report,
and a nonempty report with no filter matches have distinct messages. Status-only
updates leave the displayed accepted row elements in place.

Run only the viewer's focused native Node checks with:

```sh
node --test saved-batch-report.test.js
```

These load the actual production classic-script boundary in a Node VM, without
CommonJS/test exports or a fake browser. The two small fixtures are retained
saved stdout documents, consumed directly with independent expected results and
byte identities; they do not authorize reading any paths inside them. Tests
cover literal/empty strings, envelope/count/shape refusals, filters and duplicate
order, atomic replacement, and controlled asynchronous success/error/empty
selection races. The deferred reads prove the new boundary's generation logic,
**not native filesystem timing**. They never execute the command, codec,
formatter, or old tests. Native Files, standalone loading, actual UI rendering,
filter controls, narrow layout, and keyboard/accessibility behavior remain for
the retained approved browser; these Node checks are not that proof.
