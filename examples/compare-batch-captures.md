# Compare two saved batch captures

Dependency-free Node.js 22+ companion. Supply **before first, after second**:

```sh
node examples/compare-batch-captures.js runs/original runs/retry
node examples/compare-batch-captures.js --mapping line-mapping.json runs/original runs/retry
node examples/compare-batch-captures.js -- --before --after
node examples/compare-batch-captures.js --help
```

Each directory uses the existing capture layout:

- `stdout.jsonl` and `stderr.jsonl`: required, raw producer streams; stderr must
  use the existing opted-in version-1 JSONL diagnostics.
- `result.json`: required, the capture wrapper's version-1 `state: "observed"`
  process result. All of `exitCode`, `signal`, and `launchError` are checked.
- `attempt.json`: optional prepared-intent context. Missing, invalid or unreadable
  optional context is shown but does not itself fail comparison. It is never
  executed, used to open original orders, or substituted for a missing result.

There are exactly two positional directory arguments, no stdin or directory
discovery, and at most one `--mapping FILE` before `--`. Use `./` for dash-leading
mapping filenames. Paths are relative to the caller, including mapping paths.
The reader is located beside the companion, not in the caller's working directory.
Filesystem symlink/`..` traversal is preserved rather than lexically simplified.

The command launches the **existing unchanged stream reader**, once per side,
and retains its actual process status and complete report. It does not run or
import the producer, capture wrapper, packing engine or HTML renderer. It reads
only the explicitly selected capture files and optional mapping, never original
order inputs or paths mentioned in metadata. It creates no files and never writes
inside either input directory. No capture or producer is retried.

## Optional explicit correspondence

There is no automatic identity, including when physical line numbers coincide.
Without a mapping, all observations stay in separate before/after unmatched sets.
A mapping file has exactly this shape:

```json
{
  "version": 1,
  "pairs": [
    { "before": 2, "after": 1 },
    { "before": 3, "after": 2 }
  ]
}
```

Every line is a positive safe-integer JSON number. Each before line and each
after line may occur **at most once**; duplicate pairs, one-to-many and many-to-one
mappings are rejected, as are unknown fields/versions. An empty mapping is valid.
Mapping pairs retain caller order, and can reference lines with no captured
outcome. Invalid or unreadable mapping data makes comparison unresolved/nonzero;
no subset is applied, and both complete observation sets remain unmatched.

For the example above, original line 1 remains unmatched. If original line 3
has no outcome and retry line 2 has a summary, the pair says `not-observed`,
not added, recovered, deleted or unchanged. The mapping asserts correspondence;
the command cannot verify order identity or which input fields changed.

## JSON output

One compact JSON object plus LF, with deterministic ordering for fixed inputs:

- `version: 1` and `state`: `compared` or `unresolved`, describing the comparison
  operation's evidence checks, **not batch success or full-input completeness**.
- `processOutcomes`: separate before/after validated result records (or unresolved
  problems) and `change: "changed" | "unchanged" | "unresolved"`. Normal exit,
  signal termination and launch failure remain different kinds. Missing process
  evidence never compares equal to another missing result.
- `orders.mapping`, `orders.pairs`, `orders.unmatched`: explicit correspondence,
  mapped observations and all remaining reader rows. Unmatched rows retain the
  reader's numeric line order. No fallback to result-array positions, equal line
  numbers, equal summaries, SKUs, filenames or business IDs.
- `evidence.before` / `evidence.after`: directory labels, optional intent, actual
  **reader** status (`exitCode`, `signal`, `error`, `stderr`), unchanged reader
  reports, blocking `problems` and nonblocking cross-check `notes`. Reader reports
  retain all rows/outcomes, terminal events, counts, issues and original limits.
- `limits`: interpretation, memory, provenance and output-status boundaries.

Each mapped side has its line, `state` and every original outcome with stream/frame
location. States are `summary`, `rejection`, `not-observed`, or `ambiguous`.
Multiple outcomes (even identical duplicates), summary/rejection overlap, or
internally disagreeing policy summaries are ambiguous: no last-wins value,
deduplication, occurrence pairing or field comparison is produced.

Unambiguous observed pairs distinguish `unchanged`, `summary-changed`,
`rejection-changed`, and `outcome-changed` (summary ↔ rejection). Field differences
contain exact before/after values; policy fields are ordered by policy then field
name. Decimal-string `unusedItemSlots` is never converted to Number or recomputed.
Rejection messages are compared as exact strings, not parsed into an error taxonomy.
Input lines and stream frames are locations, not summary fields. JSON whitespace
and member order do not create summary changes.

An ambiguous or absent side yields `ambiguous` or `not-observed`, respectively,
with no synthetic field delta. Useful mapped observations can coexist with an
unresolved comparison; **they do not establish a whole-batch unchanged verdict**.

## Failures and exit status

- **0:** comparison and report output completed, including ordinary differences
  and recorded producer failures. This is never a producer-success certificate.
- **1:** required file read/JSON/schema errors, malformed/inconsistent stream
  evidence, invalid/unreadable mapping, reader execution failure, contradictory
  process evidence, or comparison/report-output failure. Useful partial JSON may
  still be emitted. Always retain the actual command status, not just its output.
- **2:** argument misuse, usage on stderr, no input reads or JSON report. Failure
  to write usage instead returns 1. Standalone help returns 0 if its write succeeds.

All reader issues except `missing-completion` and `fatal-observed` are blocking.
This includes blank/malformed/unsupported frames, unterminated fragments (even
parseable JSON), read errors, duplicates, conflicts, ordering contradictions and
completion/rejection evidence gaps. CRLF works; bare CR is not a frame boundary.
These rules come from the existing reader, not a second stream interpreter.

Missing completion or a captured fatal alone does **not** make comparison fail
when a valid failed process result is present: fail-fast, signals, launch failure
and fatal transport errors can legitimately lack completion. The reader issue
remains visible and completeness remains unproved. A claimed normal exit 0
without exactly one zero completion and no observed rejections/fatals is blocking.
A recorded launch failure with stream content is also contradictory/blocking.

A nonzero exit or signal never becomes success because completion bytes exist.
A mismatching completion is noted as `completion-not-confirmed-by-process`.
Complete-then-fatal is supported failure evidence, not automatically malformed
ordering. Even `complete(1)` plus normal exit 1 cannot distinguish rejection-only
completion from a completion-diagnostic write that delivered bytes before failing.

The capture wrapper's own historical exit status is **not stored** in the result
sidecar. This companion does not infer it, or recreate result files from handoff
notes. A reader exit 1 with valid report JSON stays a failed reader and produces
comparison exit 1. Reader exit 0 with malformed capture evidence also produces
comparison exit 1. Neither report existence nor HTML existence overrides failure.

## Safe output and limits

To save output, select a new file **outside both capture directories** and retain
the status separately. Never redirect onto an input: the shell can truncate it
before the companion starts. For example, from a trusted parent directory:

```sh
if (set -C; node examples/compare-batch-captures.js --mapping line-mapping.json \
    runs/original runs/retry > comparison-001.json); then
  comparison_status=0
else
  comparison_status=$?
fi
printf 'comparison/output status: %s\n' "$comparison_status"
```

No-clobber/redirection refusal is not a comparison result. Output failure can
leave partial or even complete-looking JSON; the actual command status wins.
Reports can contain paths, diagnostic messages and raw rejected frame text.
Review before sharing. Nothing is published or sent by this command.

This is a **whole-capture, trusted-local-evidence** example. The unchanged reader
loads both streams in memory; the companion buffers reader output and the combined
report, with repeated observations in mapped/unmatched presentation. There is no
bounded-memory guarantee, hostile duplicate-JSON-member audit, strict UTF-8 decoder,
atomic snapshot, authentication, input-identity verification, durability check or
physical packing/delivery claim. Keep files stable during inspection. Reader UTF-8
replacement decoding and `JSON.parse` behavior remain unchanged.

## Checks

```sh
node --test examples/compare-batch-captures.test.js
```

Tests exercise the real companion and unchanged reader, including partial reports
with failed reads, mapping validation/absence, exact strings, duplicate/conflicting
evidence, process states, optional context, input-byte preservation and Linux
descriptor failures. Most test captures are synthetic; they do not establish
historical provenance. No existing producer, reader or renderer behavior is changed.
