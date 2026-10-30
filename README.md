# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

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

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. The original parcel checks still cover counts 0, 1 and 3.
Planner tests spawn the real CLI and check DAG ordering, complete cycle/blocked
classification, real witnesses, a seeded independent reachability oracle,
literal IDs, malformed input, all bounds, 20,000-task deep graphs, help, paths,
I/O errors, output types and repeatability. They create only fresh exclusive
temporary fixtures, register teardown before setup, and assert original file
bytes and directory entries are preserved before normal teardown. Unexpectedly
changed or incompletely set-up fixtures are retained for inspection.

Syntax-only checks can also be run directly with the existing Node tooling:

```sh
node --check dependency-plan.js
node --check dependency-plan.test.js
node --check parcel-label.js
node --check parcel-label.test.js
```
