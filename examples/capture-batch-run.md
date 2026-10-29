# Save one batch run

From the repository root, with Node.js 22 or newer (no installation needed):

```sh
node examples/capture-batch-run.js orders.jsonl runs/attempt-001
node examples/read-batch-captures.js runs/attempt-001/stdout.jsonl runs/attempt-001/stderr.jsonl
```

The parent `runs` directory must already exist; `attempt-001` must **not** exist.
Supply one file containing one order per LF-delimited line, not a pretty-printed
single-order JSON document. Paths are relative to the caller's working directory;
the producer is located relative to the command, so other working directories work.
Quote paths containing spaces. Use `--` (or `./`) for dash-leading filenames.
There is no stdin mode; a literal file named `-` can be supplied as `./-`.
Input is resolved with native filesystem realpath **before** capture setup or
child output redirection. This follows ordinary symlinks and symlink/`..` traversal;
a resolvable descriptor alias to a named file selects that file in the observer.
If resolution fails, the original input spelling is passed unchanged to the
producer, so missing/unreadable input remains a producer-owned error. In particular,
`missing/../orders` is not simplified to a different, valid `orders` file.
The supplied output path is used for exclusive directory creation first; only
then is its realpath used for artifact joins. Existing outputs are refused even
through symlink/`..` traversal. Relative paths and ordinary symlinks are supported.

An input that becomes present only during setup (for example, a dangling alias
to a new capture file) is refused before launch; the partial attempt is retained
as unfinished. An input still missing after setup is left to the producer.

```sh
node examples/capture-batch-run.js --fail-fast orders.jsonl runs/attempt-002
node examples/capture-batch-run.js -- --orders.jsonl runs/attempt-003
node examples/capture-batch-run.js --help
```

The command invokes the existing batch producer **once** using the current Node
executable, `--diagnostics=jsonl`, and optionally its existing `--fail-fast` flag.
It does not validate order contents, copy input, reinterpret diagnostics, retry,
or change default continuation after invalid records. Other missing/unreadable
input is left to the producer. Standard input is disconnected; cwd and environment
are inherited.
There are no timeouts, extra producer flags, dependencies, or configuration.

## Files and process result

- `attempt.json`: version 1, `state: "prepared"`, executable, exact argument array,
  and cwd. Written before launch, it describes intent, **not proof of launch**.
- `stdout.jsonl` and `stderr.jsonl`: separate, raw producer output. The child writes
  directly to newly opened file descriptors, with no decoding, re-encoding, line
  normalization, concatenation, or wrapper messages in either file.
- `result.json`: version 1, `state: "observed"`, `exitCode`, `signal`, `launchError`.
  For a launched child, written after its observed `close` event and the observer's
  descriptor closes. An asynchronous launch error is recorded after the child
  handle closes. If `spawn` throws synchronously, **no child close event exists**:
  that launch error is recorded after closing the already opened capture files.
  Normal exits have an integer code and null signal/error; a signal has null exit
  code and its observed signal name. Either launch-failure path has null code/signal
  and an error object (`code`, `message`), not an invented producer exit code.

The wrapper returns the observed normal producer exit code. It returns **1** for
a producer signal, launch failure, or wrapper filesystem error, and **2** for
argument misuse; help returns **0**. Normal capture runs print nothing themselves;
wrapper errors use the wrapper's stderr, never the saved producer stderr. A wrapper
failure can occur after producer success, so its status and `result.json` are
different evidence. A missing or invalid result is **unfinished/unresolved**,
including an empty or partially prepared directory, never successful completion.
`state: "observed"` alone does not mean success: inspect all three result fields.

Directory creation is exclusive and non-recursive. Any existing path (including
an empty directory, file, or symlink) is refused before launching the producer.
Files use exclusive creation too. No attempt is overwritten, resumed, removed,
or automatically retried, even after setup or metadata-writing failure. Choose a
new directory for a deliberate subsequent run.

## Limits

These are local observations, not a transaction, backup, or crash-durability
protocol: there is no fsync, atomic multi-file publication, input snapshot,
content authentication, or protection against concurrent external tampering.
Use a trusted parent directory. Partial metadata or captures can survive an error.
Realpath selects a pathname, not a snapshot or a retained input descriptor. The
producer reopens that name; renames, content changes, and special aliases without
a usable canonical filename are not a stable-input guarantee.
Signals terminating the observer can leave no result even if the producer later
finishes; **the child may continue**. There is no signal forwarding, process-tree
supervision, automatic cancellation, or guaranteed interrupt-time finalization.

The unchanged reader consumes only the two stream files; it does not read these
sidecars. Its exit 0 only means a report was produced. JSONL completion is not an
OS process result, and `complete(1)` plus normal exit 1 still cannot exclude a
completion-diagnostic write that delivered its bytes before failing. Captures do
not establish cross-stream chronology, immutable/intended input completeness,
power-loss persistence, or physical packing/shipment results.

## Maintained checks

```sh
node --test examples/capture-batch-run.test.js
```

The tests create their own temporary inputs and run the real command for success,
mixed-validity failure, fail-fast, existing-path refusal, and input/output overlap.
They compare captured Buffers against separate direct producer reference runs
and pass saved files to the unchanged reader. Focused path regressions cover
symlink/.. input and output traversal, existing-output refusal, missing traversal,
ordinary symlinks, producer read errors, and Linux fd-1 aliases backed only by
small, newly owned regular files. Test-only Node preload fixtures observe child
starts and exercise signal, interrupted-observer, and OS launch-failure boundaries;
the command has no injectable executable, environment switch, or test-only option.
