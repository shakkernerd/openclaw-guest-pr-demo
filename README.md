# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Dependency planner

With Node.js 22 or newer, run:

```sh
node dependency-plan.js graph.json
node dependency-plan.js --targets targets.json graph.json
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
  error is reported, not an exhaustive validation report. The target-selection
  array described below explicitly permits duplicate selections, not graph IDs
  or edges.

Graph input is one regular file, not stdin; its extension is irrelevant. Symlinks to
regular files are followed. Keep the file stable while reading: this is not an
atomic snapshot of a concurrently edited file. Reads may update filesystem
access metadata, but the CLI never writes file bytes. For a filename beginning
with `-`, use `node dependency-plan.js -- -graph.json` (or `./-graph.json`).
`--help` and `-h` are accepted alone. Apart from the target-selection prefix below,
other options or extra operands are errors.

### Target selection

Use exactly this optional prefix before the graph operand:

```sh
node dependency-plan.js --targets targets.json graph.json
node dependency-plan.js --targets -targets.json -- -graph.json
```

The operand immediately after `--targets` is a literal file path (even
if it starts with `-`), not an inline ID or JSON argument. The target
file uses the **same bounded UTF-8 JSON reader and regular-file rules** as the
graph file. It contains an array of exact existing task IDs, for example:

```json
["ship", "build", "check", "ship"]
```

- All target IDs use the existing 1–256 UTF-16 code-unit ID validation and exact
  decoded string equality. There is no trimming, coercion or normalization.
  JSON escapes can select every valid literal ID, including `"\u0000"`,
  `"\n"` or `"\ud800"`; prototype-like IDs remain ordinary strings.
- Duplicate selections are accepted and collapse in **first-selection order**,
  including equivalent JSON spellings such as `"a"` and `"\u0061"`.
  There may be at most **20,000 selection occurrences before deduplication**.
- An explicitly empty array `[]` selects **no tasks**: an empty DAG plan,
  not a fallback to whole-graph planning. Non-array selections and unknown IDs
  are input errors (exit 2, empty stdout). Unknown-ID diagnostics include the
  zero-based selection position and JSON-escaped ID; only the first error is reported.
- The **entire graph is read and validated first**, before reading the target
  file. Malformed tasks, duplicate IDs/edges, unknown dependencies and graph
  limits still fail even outside the required closure or with an empty selection.
  Selecting a small subset does not relax global validation.
- Planning includes only the selected tasks and their **transitive required
  dependencies**, each once. A selected target may itself be another target's
  dependency. Unrequested dependents and unrelated tasks are not included.

For the graph above, this selection produces:

```json
{"scope":"targets","targets":["ship","build","check"],"status":"dag","stages":[["source","config"],["build","check"],["ship"]],"cycleWitness":[],"cycleTasks":[],"blockedTasks":[]}
```

Target output prefixes the normal fields with `scope: "targets"` and
`targets` (unique requested IDs in first-selection order). **Every plan
field and the exit status apply only to the required closure**, not the whole
graph. Cycles wholly outside it do not make the selected plan cyclic. Within it,
the same real witness, complete cycle classification, blocked-task distinction
and earliest-stage rules apply. Output ordering follows graph input order, not
selection order; only the `targets` metadata follows selection order.

For example, with graph `[["tail",["loop"]],["loop",["loop"]],["free",[]]]`,
selecting `["free"]` returns a DAG with stages `[["free"]]` and no
cycle diagnostics. Selecting `["tail"]` returns exit 1, no runnable stages,
witness `["loop","loop"]`, cycleTasks `["loop"]` and blockedTasks
`["tail"]`. Selecting `["loop"]` omits the unrequested dependent `tail`.

Omitting `--targets` retains the original whole-graph invocation and exact
JSON field/byte contract: no new scope or target fields. The prefix may appear
only once; options after the graph operand and extra operands are usage errors.
Use `--` before a graph path starting with `-`, including a file
literally named `--targets`. Help flags remain standalone.

### Output, ordering and cycles

Successfully delivered output is one compact JSON object plus a newline on
stdout. Without target selection it has these fields in this order:

```json
{"status":"dag","stages":[["source","config","independent"],["build","check"],["ship"]],"cycleWitness":[],"cycleTasks":[],"blockedTasks":[]}
```

`status` is `"dag"` or `"cyclic"`; `stages` is an array of arrays of string
IDs. The remaining fields are always arrays of string IDs, empty for a DAG.
Within the plan's scope, stage zero contains every dependency-free root,
including isolated tasks. Each other task is in its earliest possible stage: one greater than its latest
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

Every task in scope appears exactly once across stages, cycleTasks and
blockedTasks; the witness intentionally repeats some cycle IDs. Identical input gives identical
output bytes. Changing task order may change ordering; changing dependency order
may change the witness, but not earliest stages or cycle membership.

### Bounds, algorithm and exit status

Inclusive limits are **4,194,304 input bytes (4 MiB) per file**, **20,000 graph tasks**,
**200,000 dependency edges**, and **256 UTF-16 code units per ID occurrence**.
Target files additionally allow at most **20,000 selections**, including duplicates.
The file-size check is followed by a bounded read of at most 4 MiB + 1 byte to
detect growth beyond the limit. Parsing precedes structural validation; even
invalid JSON structures consume parser memory within the byte bound.

The planner uses cursor-based Kahn traversal for stage ranks, one input-order
pass to assemble stages, and iterative two-pass SCC traversal (Kosaraju) of any
unresolved subgraph. Target closure uses an iterative stack over the existing
dependency adjacency, marking on insertion so each required task is visited
once even with overlapping targets. A membership mask scopes the same Kahn/SCC
planner; no second graph or planner is built. Constant input-order passes and
global validation still cover the whole graph. There are no recursive graph
walks, shifted queues, per-stage whole-graph scans or comparison sorts. Graph traversal is **O(V + E)**
time and space. Including reading, parsing, ID validation/hashing and output,
work is O(B + C + V + E + T + O) with normal amortized Map/Set operations: B is input
bytes across both files when selecting targets, C is total decoded ID code units
across occurrences, T is selection occurrences (zero in whole-graph mode), and O
is serialized output size. ID and input limits bound string work as well as graph work.

This is **not streaming or constant-memory**: it uses a fixed 4 MiB + 1 read
buffer and holds decoded/parsed input, adjacency in both directions, traversal
arrays, the result and its serialized JSON. Additional space is
O(B + V + E + T + O); JavaScript object/array overhead and garbage collection mean
the byte limit is not a process-RSS limit. Output omits edges: each task is
listed once in the partition plus at most once in the witness (and one closing
ID), and in target mode at most once more in the requested-target metadata.
JSON escaping and a deep graph's many stage arrays still increase output
size; output is O(V + L), where L is the sum of declared ID lengths.

| Exit | Meaning | stdout |
| --- | --- | --- |
| 0 | Valid DAG in plan scope, including empty, or help | Plan JSON, or help text |
| 1 | Valid cyclic graph in plan scope | Plan/classification JSON |
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
I/O errors, output types and repeatability. Target checks also cover overlapping
closures, dependency targets, exact escaped IDs, empty/duplicate/unknown selections,
global validation outside the closure, unrelated versus selected cycles, selection
bounds, deep closures, and whole-graph JSON byte controls. They create only fresh
exclusive temporary fixtures, register teardown before setup, and assert original file
bytes and directory entries are preserved before normal teardown. Unexpectedly
changed or incompletely set-up fixtures are retained for inspection.

Syntax-only checks can also be run directly with the existing Node tooling:

```sh
node --check dependency-plan.js
node --check dependency-plan.test.js
node --check parcel-label.js
node --check parcel-label.test.js
```
