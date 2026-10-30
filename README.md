# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

Three independent, dependency-free Node.js 22+ CLIs complement the parcel helper:

- [File manifest](#file-manifest-cli): create and verify declared-file byte manifests.
- [Dependency planner](#dependency-planner): plan stages and classify cycles without executing tasks.
- [JSON comparison](#read-only-structural-json-comparison): report complete structural differences.

Run commands from the repository root. Each CLI retains its own input, path,
symlink, error and exit-status contract, documented below; they do not invoke
one another. No installation, package scripts or configuration are required.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively.

Manifest tests cover real CLI commands, byte preservation, deterministic output,
validation, containment, symlinks, and missing/changed/unreadable results. Their
bounded fixtures live in temporary directories and are removed after each test.

Planner tests spawn the real CLI and check DAG ordering, complete cycle/blocked
classification, real witnesses, a seeded independent reachability oracle,
literal IDs, malformed input, all bounds, 20,000-task deep graphs, help, paths,
I/O errors, output types and repeatability. They create only fresh exclusive
temporary fixtures, register teardown before setup, and assert original file
bytes and directory entries are preserved before normal teardown. Unexpectedly
changed or incompletely set-up fixtures are retained for inspection.

Syntax-only checks can also be run directly with the existing Node tooling:

```sh
node --check file-manifest.js
node --check file-manifest.test.js
node --check dependency-plan.js
node --check dependency-plan.test.js
node --check json-diff.js
node --check json-diff.test.js
node --check parcel-label.js
node --check parcel-label.test.js
```

## File manifest CLI

Dependency-free; uses only Node.js 22+ built-ins. From the repository root:

```sh
node file-manifest.js --help
node file-manifest.js create . README.md parcel-label.js > /tmp/declared-files.json
node file-manifest.js verify . /tmp/declared-files.json
node --test file-manifest.test.js parcel-label.test.js
node --check file-manifest.js
```

`create ROOT FILE [FILE ...]` hashes an explicit, nonempty set of regular files.
It writes JSON to stdout only after all files have been read successfully.
There is no recursion, glob expansion, directory enumeration, stdin mode, or
output-file option. Quote paths with spaces or shell metacharacters. Arguments
after ROOT are literal paths, including names beginning with `-`; no `--` is
needed. ROOT is relative to the working directory (or absolute). FILE is always
relative to ROOT. Shells may expand unquoted globs before the CLI sees them.

**Redirect output only to a separate, non-input file.** The shell opens/truncates
a redirection before Node runs; the CLI cannot protect an input from `> input`.
Avoid redirecting onto an existing file you need to keep. Neither command opens
inputs for writing or normalizes their bytes. Reads can update filesystem access
times; read-only here means no intentional filesystem writes, not zero metadata
effects. Hashing uses bounded 64 KiB chunks, including for binary and empty files.

### Manifest format and determinism

```json
{
  "version": 1,
  "algorithm": "sha256",
  "files": [
    {
      "path": "empty.txt",
      "size": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

The format has exactly these keys. Sizes are nonnegative safe integers, digests
are 64 lowercase hex characters, and file paths are unique. Imported manifests
may list entries in any order; the entire schema and every path are validated
before declared files are inspected. Manifests must be UTF-8 JSON without a BOM.
Manifest JSON is read into memory; use reasonably sized manifests.

Creation sorts paths by JavaScript UTF-16 code-unit order (not locale order),
uses two-space JSON indentation and a final LF, and includes no timestamps or
absolute root paths. Identical declared paths and bytes produce identical output
regardless of argument order, working directory, root location, or file mtime.
No Unicode normalization or filesystem case folding is performed; distinct
spellings may refer to the same file on case-insensitive/normalizing filesystems.

### Paths, symlinks, and unsupported inputs

Paths use `/` separators and well-formed Unicode. Reject absolute paths, empty
components, `.` or `..` components, backslashes, ASCII controls (U+0000–001F and
U+007F), and `< > : " | ? *`. Components must not end in a dot or space. Windows
device names CON, PRN, AUX, NUL, COM1–9, and LPT1–9 (including the Windows-recognized
superscript ¹, ², ³ variants) are rejected case-insensitively, with or without an
extension. This deliberately strict grammar also rejects drive paths, UNC paths,
and alternate data streams rather than rewriting ambiguous names.

ROOT is resolved once with `realpath` and must be a directory; a symlink selecting
ROOT (or in its ancestors) is allowed. Below that resolved root, **all symlinks
are rejected**, whether internal, external, dangling, or in a parent component.
Only regular files are hashed: directories, sockets, FIFOs, and devices are not
supported. Hard links are regular files and are accepted.

MANIFEST is an explicit path relative to the working directory (or absolute),
not to ROOT, and may be outside ROOT. It must itself be a regular, non-symlink
file; its parent directories may resolve through symlinks. Root selection and
manifest location are caller-trusted inputs; entries imported from a manifest
cannot lexically escape ROOT or traverse a detected symlink beneath it.

### Verification and exits

`verify ROOT MANIFEST` emits JSON `{ "ok": boolean, "files": [...] }`, sorted by
path, and attempts every declared file after validation:

- `ok`: byte size and SHA-256 both match. Includes `expected` and `actual`.
- `changed`: either differs, including same-size content changes. Includes both
  `{ "size", "sha256" }` values for diagnosis.
- `missing`: a file or parent component is absent (`ENOENT`). Includes `expected`
  and `code`. A dangling symlink is instead `unreadable` / `SYMLINK`.
- `unreadable`: a read/access failure or unsupported filesystem input. Includes
  `expected` and a stable CLI or OS `code`: for example `EACCES`, `SYMLINK`,
  `UNSUPPORTED_TYPE`, or `NOT_DIRECTORY` (a non-directory parent). It is not
  mislabeled as a content mismatch.

Exit **0**: create/help succeeded, or all declared files verified.
Exit **1**: verification found any missing, changed, or unreadable declared file.
Exit **2**: bad usage, malformed/unsafe manifest, inaccessible manifest, invalid
or inaccessible root, any creation failure, or output-delivery failure (including
a closed pipe). Fatal errors are JSON on stderr when it is writable (`error.code`,
`error.message`, and a declared `error.path` when available). Input/usage failures
produce no stdout manifest/report. A delivery failure may leave partial stdout;
the CLI does not retry the document. If stderr also fails, exit 2 is retained
without attempting another diagnostic. OS error messages can vary by platform.

### Limits of the claim

This is a **declared-file byte comparison**, not proof of directory completeness:
extra files are ignored. It does not prove authenticity (an attacker can change
both data and manifest), provide a filesystem snapshot, or guarantee safety
against hostile filesystem races. Files are read sequentially; concurrent writes
can produce a mixed-time view. Component checks and no-follow/nonblocking flags
where available are defense in depth, not race-proof traversal. Use a trusted,
quiescent root; do not treat this CLI as a sandbox for a hostile writable tree.

## Dependency planner

With Node.js 22 or newer, run:

```sh
node dependency-plan.js graph.json
node dependency-plan.js --help
```

This dependency-free CLI **only reads and plans**. It never executes tasks,
imports task modules, extracts files, or writes inputs. IDs that look like code,
module paths or shell commands are still just strings. The existing parcel label
utility is unchanged. No installation or package scripts are needed.

### Input contract

The file is a UTF-8 JSON array of **`[taskId, [dependencyId, ...]]` pairs**:

```json
[
  ["ship", ["build", "check"]],
  ["build", ["source"]],
  ["check", ["config"]],
  ["source", []],
  ["config", []],
  ["independent", []]
]
```

Each pair has exactly two elements; its second element must be an array. There
are no object keys, optional fields, task contents, or implicit tasks. An edge
`["build", ["source"]]` means **build depends on source**, not the reverse.
References may point forward or backward in the file.

- IDs must be nonempty strings of at most **256 UTF-16 code units**, including
  dependency IDs. Whitespace, case, Unicode composition and control characters
  are preserved, without trimming, case folding, coercion or normalization.
  For example, `"a"`, `" a"`, `"A"`, `"01"` and `"1"` are distinct.
- Equality is exact JavaScript string equality **after JSON decoding**:
  `"a"` and `"\u0061"` are the same ID. JSON-escaped lone surrogate code
  units are accepted as literal string data, as are `__proto__`, `constructor`
  and `toString`. IDs are stored in Maps/Sets, not used as object properties.
- Duplicate task IDs, duplicate dependencies within a task, and references to
  undeclared IDs are errors. Different tasks may share a dependency. A self-edge
  is valid input but is a cycle. `[]` is a valid empty graph.
- Invalid UTF-8, BOMs, malformed JSON, comments, trailing commas, wrong types,
  extra tuple elements and exceeded limits are errors; nothing is silently
  dropped or deduplicated. If several errors exist, only the first detected
  error is reported, not an exhaustive validation report.

Input is one regular file, not stdin; its extension is irrelevant. Symlinks to
regular files are followed. Keep the file stable while reading: this is not an
atomic snapshot of a concurrently edited file. Reads may update filesystem
access metadata, but the CLI never writes file bytes. For a filename beginning
with `-`, use `node dependency-plan.js -- -graph.json` (or `./-graph.json`).
`--help` and `-h` are accepted alone; other options or extra operands are errors.

### Output, ordering and cycles

Successfully delivered output is one compact JSON object plus a newline on
stdout, with these fields in this order:

```json
{"status":"dag","stages":[["source","config","independent"],["build","check"],["ship"]],"cycleWitness":[],"cycleTasks":[],"blockedTasks":[]}
```

`status` is `"dag"` or `"cyclic"`; `stages` is an array of arrays of string
IDs. The remaining fields are always arrays of string IDs, empty for a DAG.
Stage zero contains every dependency-free root, including isolated tasks. Each
other task is in its earliest possible stage: one greater than its latest
dependency's stage. Within each stage, tasks retain **input task order**, not
lexicographic order or incidental queue order. Every dependency is in an earlier
stage, and every DAG task appears exactly once. The empty graph has `stages: []`.

For example, this cyclic input:

```json
[["tail",["a"]],["a",["b"]],["b",["a"]],["self",["self"]],["free",[]]]
```

produces (with exit status 1):

```json
{"status":"cyclic","stages":[["free"]],"cycleWitness":["a","b","a"],"cycleTasks":["a","b","self"],"blockedTasks":["tail"]}
```

- `stages` contains only tasks whose dependencies can all be satisfied, even
  when other components are cyclic. It is not a plan for the entire graph.
- `cycleWitness` is **one closed cycle**, with the first ID repeated at the end.
  Each consecutive link is an actual **task-to-dependency** edge. A self-cycle
  is `["self","self"]`. Selection uses the first gray back-edge in iterative
  depth-first traversal of the unresolved graph, starting in input task order
  and following each task's dependency array order.
- `cycleTasks` lists **all** actual cycle participants, including multiple or
  disconnected cycles and participants not present in the selected witness.
  Classification uses strongly connected components, not just the witness or
  the unresolved-node set. A component is cyclic if it has multiple tasks or
  a self-edge.
- `blockedTasks` lists only **noncyclic** tasks transitively depending on a
  cycle. Dependencies upstream of cycles are not automatically blocked.
  Both classification arrays retain input task order.

Every task appears exactly once across stages, cycleTasks and blockedTasks; the
witness intentionally repeats some cycle IDs. Identical input gives identical
output bytes. Changing task order may change ordering; changing dependency order
may change the witness, but not earliest stages or cycle membership.

### Bounds, algorithm and exit status

Inclusive limits are **4,194,304 input bytes (4 MiB)**, **20,000 tasks**,
**200,000 dependency edges**, and **256 UTF-16 code units per ID occurrence**.
The file-size check is followed by a bounded read of at most 4 MiB + 1 byte to
detect growth beyond the limit. Parsing precedes structural validation; even
invalid JSON structures consume parser memory within the byte bound.

The planner uses cursor-based Kahn traversal for stage ranks, one input-order
pass to assemble stages, and iterative two-pass SCC traversal (Kosaraju) of any
unresolved subgraph. There are no recursive graph walks, shifted queues,
per-stage whole-graph scans or comparison sorts. Graph traversal is **O(V + E)**
time and space. Including reading, parsing, ID validation/hashing and output,
work is O(B + C + V + E + O) with normal amortized Map/Set operations: B is input
bytes, C is total decoded ID code units across occurrences, and O is serialized
output size. ID and input limits bound string work as well as graph work.

This is **not streaming or constant-memory**: it uses a fixed 4 MiB + 1 read
buffer and holds decoded/parsed input, adjacency in both directions, traversal
arrays, the result and its serialized JSON. Additional space is
O(B + V + E + O); JavaScript object/array overhead and garbage collection mean
the byte limit is not a process-RSS limit. Output omits edges: each task is
listed once in the partition plus at most once in the witness (and one closing
ID). JSON escaping and a deep graph's many stage arrays still increase output
size; output is O(V + L), where L is the sum of declared ID lengths.

| Exit | Meaning | stdout |
| --- | --- | --- |
| 0 | Valid DAG, including empty, or help | Plan JSON, or help text |
| 1 | Valid cyclic graph | Plan/classification JSON |
| 2 | Usage, invalid input, nonregular file, or exceeded limit | Empty |
| 3 | File or output I/O failure | Empty or possibly partial output |

Diagnostics go to stderr without a stack trace. An open/read failure (including
an unopenable nonregular path) is I/O status 3; an openable nonregular file is
rejected with status 2. A closed stdout pipe is an I/O failure, not success; if
stderr is also unavailable, a diagnostic cannot be guaranteed.

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

Run `node --test json-diff.test.js` for JSON comparison checks; `node --test`
runs all utility tests.
The JSON checks execute the real CLI, compare complete typed results, verify
input bytes are unchanged, and cover equal/order controls, literal keys, root
replacement, positional arrays, number semantics, invalid encoding/syntax,
exact resource boundaries, read errors, stdout input-alias rejection and stderr
alias suppression on validation/early-read failures, with independent-sink controls. POSIX
checks use ordinary `mkfifo`; write failure uses `/dev/full` when available
(and explicitly reports when that check cannot run). Synthetic test inputs are
created and retained under the OS temporary directory, never the source tree.
