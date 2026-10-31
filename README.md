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

## Read-only structural JSON comparison

With Node.js 22 or newer (no installation or dependencies):

```sh
node json-diff.js before.json after.json
```

Supply exactly two regular-file paths. Symlinks to regular files are allowed;
there are no flags, stdin mode, output-file option or configuration. The command
opens inputs read-only and writes one compact UTF-8 JSON report plus a newline
to stdout. Exit status **0** means equal, **1** means different, and **2** means
error (a short, data-free diagnostic when stderr is safe and writable). Treat 1 as a successful comparison,
not an operational failure. For example, comparing `{"a":1}` with `{"a":2,"b":null}`
prints the following and exits 1:

```json
{"added":[{"path":["b"],"value":null}],"removed":[],"changed":[{"path":["a"],"before":1,"after":2}]}
```

Equal documents produce `{"added":[],"removed":[],"changed":[]}` and exit 0.

### Meaning of the report

- Paths are segment arrays: **`[]` is the root**, strings are object keys, and
  numbers are array indices. Thus `["0"]`, `[0]`, and `[""]` are distinct.
  Keys containing slashes, dots, tildes, or literal `__proto__`, `constructor`
  and `toString` need no special escaping beyond normal JSON string encoding.
- Objects compare by their own keys, independently of input key order. Arrays
  compare by position, including additions/removals at the tail; an insertion
  can change subsequent positions. There is no move detection or patch application.
- A missing key/index reports one added or removed entry with its **entire value**.
  Different primitive values or different kinds (including object versus array)
  report one changed entry with **complete before and after values**. Containers
  of the same kind are traversed; missing/replaced subtrees are not also expanded
  into redundant leaf entries. Null, false, empty strings/arrays/objects stay typed.
- Entries within each category follow depth-first traversal: object keys sorted
  by JavaScript UTF-16 code-unit order, array indices increasing numerically.
  Contained object values are also ordered deterministically: JavaScript's
  integer-index keys first in numeric order, then other keys in code-unit order.
  This is not a canonical-JSON standard or a text-format comparison.

### Numbers, parsing and equality

The only parser is native **`JSON.parse`**. Numbers are IEEE-754 binary64 JavaScript
Numbers, not arbitrary-precision decimals. Each number retained in the parsed
tree must be finite and, when integral, a safe integer
(`-9007199254740991` through `9007199254740991`). Overflow such as `1e400` and
parsed unsafe integers such as `9007199254740992` fail, even in an otherwise
equal document or a whole added/removed subtree.

Accepted numbers compare by JavaScript numeric equality. **-0 and +0 are equal
and reported as 0.** Decimal rounding and underflow have already happened during
parsing: `0.10000000000000001` can equal `0.1`, `1e-4000` equals 0, and a
fractional lexeme can round to an integer before the safety check. This command
does **not** compare exact decimal lexemes. Reported numbers use `JSON.stringify`
and round-trip to the same accepted numeric values (with zero normalized).
Use JSON strings instead if exact decimal text matters.

Whitespace and equivalent string escapes are ignored. Duplicate object keys use
native last-key-wins semantics; validation and limits on values apply to that
retained tree, not overwritten values. Strings compare as JavaScript strings
without Unicode normalization; native handling of escaped lone surrogates is
retained. Invalid UTF-8 is rejected, not replaced. A leading UTF-8 BOM is rejected
as invalid JSON, as are empty files, trailing garbage and multiple documents.

### Fixed limits and failures

No limit is configurable. The following are inclusive:

| Resource | Limit | What is counted |
| --- | ---: | --- |
| Input | 131,072 bytes per file | Raw UTF-8 bytes, including whitespace |
| Depth | 64 per document | Root depth 0; each object member/array element adds 1 |
| Parsed values | 10,000 per document | Root, every container and every retained child value |
| Comparison work | 10,000 path visits total | Root and each compared/added/removed path, including equal paths |
| Complete report | 262,144 UTF-8 bytes | Framing, paths, complete values, separators and final newline |

Both documents are fully validated before comparison, including values that would
be in a whole reported subtree. Parsing is bounded by input bytes; traversal stops
at the first excessive depth/value count. Key collection/sorting and any single
entry serialization are bounded by the input/value/depth limits. Work is not an
unbounded search: only visited paths are compared, and missing/replaced subtrees
are serialized once. The report is accumulated privately under its byte budget;
no result is streamed while comparison is still underway.

Usage, read, decoding, parsing, number and resource-limit errors exit 2 with
**no stdout report**. Reads check both file size and actual bytes (at most the
limit plus one), close opened descriptors, and reject directories/devices/FIFOs
without consuming them. FIFOs are opened nonblocking. Diagnostics identify the
side or output, include an OS error code for I/O failures, and do not quote input
contents or file paths. There is no wall-clock timeout for OS I/O; these are
byte/structural bounds, not a guarantee against a stalled filesystem or pipe.

Write errors also exit 2. An OS failure can leave some bytes already written;
**only exit 0 or 1 certifies a complete report**. Before writing a diagnostic,
stderr is checked by device/inode against identities retained as inputs are opened
and against the input paths, including an input not yet opened when a read fails.
If stderr aliases an input, or a regular-file sink cannot be verified separate,
the diagnostic is suppressed and exit 2 remains the signal. Failure to inspect or
write stderr also retains exit 2. Independent safe sinks still receive diagnostics.

Partial stdout writes are handled without splitting UTF-8 incorrectly. Do not
redirect stdout **or stderr** onto either input: `> input.json` or `2> input.json`
truncates the file in the shell before this command starts. The stdout alias
rejection and stderr diagnostic suppression cover append/hard-link aliases, but
cannot undo shell truncation or protect against concurrent writers/path changes.
Use stable local inputs; reads and sink identity checks are not an atomic snapshot.

### Core and checks

`require("./json-diff.js").compareJson(leftBuffer, rightBuffer)` accepts two UTF-8
Node Buffers, leaves them unchanged and returns `{ report, different }`, where
`report` is the complete newline-terminated JSON string. It applies the same
limits/semantics and throws on failure; importing the module performs no I/O.
There is no second comparison policy or parser.

Run `node --test` for the existing parcel tests and JSON comparison checks.
The JSON checks execute the real CLI, compare complete typed results, verify
input bytes are unchanged, and cover equal/order controls, literal keys, root
replacement, positional arrays, number semantics, invalid encoding/syntax,
exact resource boundaries, read errors, stdout input-alias rejection and stderr
alias suppression on validation/early-read failures, with independent-sink controls. POSIX
checks use ordinary `mkfifo`; write failure uses `/dev/full` when available
(and explicitly reports when that check cannot run). Synthetic test inputs are
created and retained under the OS temporary directory, never the source tree.

## Offline structural report viewer

Open [`json-diff-viewer.html`](json-diff-viewer.html) directly in a modern browser
with JavaScript enabled, then use **Choose a UTF-8 JSON report** to select retained
stdout from `json-diff.js`. The HTML contains all its CSS and JavaScript: no server,
installation, build step, dependency or external asset is required. Keep producer
exit status 0 or 1 with your report; the viewer cannot certify how a file was made.

- Added, removed and changed entries retain their original order within each
  category. The viewer groups categories in that order; it never sorts entries or
  performs another diff. Counts show both the whole report and filtered matches.
- Select any change for its complete before/after JSON. Top-level types are
  labeled; **absent** is explicitly different from JSON `null`. Empty strings,
  false, empty containers and literal prototype-like keys remain intact. Values
  wrap and scroll without truncation. Focus a value pane to scroll by keyboard.
- Paths show the complete JSON segment array and individual labeled segments:
  string object keys versus numeric array indices, with `[]` labeled as root.
  Markup-looking content is inert text. Unicode `Format` (`Cf`) controls, including
  U+180E, are shown as lowercase JSON `\uXXXX` escapes. The existing DEL/C1
  (U+007F–U+009F), line/paragraph separator (U+2028–U+2029) and U+2065 escapes are
  retained. Supplementary formatting controls use both UTF-16 surrogate escapes;
  parsing the displayed JSON recovers the complete value and exact code points.
  This is a bounded formatting-control policy, not Unicode normalization or a
  blanket rule for whitespace, variation selectors or other invisible characters.
- Filter by category and case-insensitive literal text in compact JSON paths and
  complete values (including values not currently displayed). Search uses the
  displayed escapes, not a regular expression; spaces are significant. Search
  lowercases both indexed text and the query, then folds final sigma `ς` to `σ`,
  so a query for `Σ` also finds `ΟΣ`. Only search keys change; displayed JSON and
  original values do not. This adds no locale, Unicode normalization, accent
  removal or full multi-character case folding. Reset filters to return to all
  entries.
- Use Tab/Shift+Tab, Enter/Space, Previous/Next change, or Go to match. In a change
  list button, Up/Down selects adjacent matches and Home/End selects first/last.
  Modified keys and ordinary Tab behavior are left to the browser. There are
  100 matches per page, not a 100-entry report limit. Previous/Next page selects
  the first match on that page. **Skip to selected change** is a native button:
  Enter/Space focuses and scrolls to the selected detail in the current document,
  without URI navigation or changing the report, filters or selection. This also
  avoids fragment-link navigation in hosted `srcdoc` previews whose base URL may
  belong to the host. At narrow widths the panels stack.
- Loading a new file immediately clears the old accepted data. Malformed,
  unreadable, zero-byte, valid empty, and no-filter-match states are distinct.
  A later file selection or Clear viewer wins over pending reads. The picker
  resets to allow selecting the same file again; its name is shown separately.

The viewer only reads the selected file. It has no persistence, network calls,
export, download, clipboard, editing, patch application or comparison behavior.
Clear viewer clears page memory, not files. Reloading/closing the page discards
the report. A restrictive inline Content Security Policy also disallows external
resources, connections and form submission.

### Viewer validation and checks

Validation is deliberately a bounded format check, not proof of provenance or
semantic consistency. It uses native `JSON.parse` (including last-key-wins), strict
UTF-8 decoding and the producer's finite/safe-integer number policy. A BOM, missing
fields, extra wrapper/entry fields and incorrectly typed paths are rejected.
Payload object keys are unrestricted, including `__proto__` and `constructor`.

The inclusive **262,144-byte complete-report** budget is checked before reading
and against the actual bytes read (at most the budget plus one). It includes
whitespace and the producer's final newline; the viewer also accepts a missing
final newline. It does not mistakenly apply the **131,072-byte input** limit to
reports. Paths have at most **64** string/nonnegative safe-integer segments. Each
reported value is checked at its absolute source depth (path length plus nested
depth, maximum **64**), excluding report wrappers. Reported subtrees are disjoint
on each side, so their value counts are bounded separately at **10,000 before**
and **10,000 after**. Entry count is bounded by the producer's **10,000 visits**.
These are conservative necessary bounds: equal/unreported values, original input
bytes, ancestor visits, path consistency and whether values really differ cannot
be certified from a report alone. No source documents are reconstructed.

Run just the new viewer checks with Node.js 22 or newer:

```sh
node --check json-diff-viewer.test.js
node --test json-diff-viewer.test.js
```

They compile and execute the maintained inline script in a small DOM double,
check asset/sink restrictions and labels, and exercise parsing, whole-value
rendering, typed paths, filtering, navigation handlers, invalid-state clearing,
read errors and out-of-order reads. The skip regression checks native button
markup and local focus/scroll calls with report/filter/selection preservation
under simulated file and HTTP-based `srcdoc` contexts; native activation and
scrolling still need browser-owner revalidation. Fresh synthetic reports from the unchanged
producer cover exact report bytes, depth, per-side value budgets and maximum
visits. Fixtures are in memory; there are no generated contribution files. These
checks do not run the existing producer/parcel suites.

The Node DOM double is **not native browser/Files, visual, accessibility-tree or
physical keyboard proof**. Consumer assessment still needs opening this exact
HTML offline in an approved browser, selecting real reports through native Files,
checking Tab/Shift+Tab, Enter/Space, list keys, jump/page controls, scrolling and
focus, and inspecting ordinary/narrow layouts (for example 1280px and 320px, plus
zoom). Include empty/invalid files, no matches, markup-looking values and rapid
file reselection. Independent source/UI review is a separate release gate.
