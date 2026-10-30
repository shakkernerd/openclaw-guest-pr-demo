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
