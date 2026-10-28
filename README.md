# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. The original tests cover parcel counts 0, 1, and 3, expecting
`0 items`, `1 item`, and `3 items`, respectively. The review handoff checks below
also run with the same command.


## Review handoff brief — local library and CLI

Turn an exported review selection plus its **exact comparison file bytes** into
Markdown or JSON. Dependency-free CommonJS, Node 22+. No installation, network,
source changes, evidence fetching, account access, or publication.

The concrete v1 contract was derived from the supplied files **before** building
this implementation: [input contract](docs/review-handoff-contract.md).

### CLI examples (from the repository root)

Display Markdown (default) or JSON:

~~~sh
node bin/review-handoff.js --selection examples/inputs/review-selection-dispatch-evidence.json --comparison examples/inputs/comparison.json
node bin/review-handoff.js --selection examples/inputs/review-selection-dispatch-evidence.json --comparison examples/inputs/comparison.json --format json
node bin/review-handoff.js --help
~~~

Write to a **new** output file, separate from inputs:

~~~sh
node bin/review-handoff.js --selection examples/inputs/review-selection-dispatch-evidence.json --comparison examples/inputs/comparison.json --format markdown --output examples/generated/my-follow-up.md
~~~

The output directory must exist. Existing output files, input paths, symlinks
(including dangling ones) and hardlinks are refused, never overwritten. Choose a
new name for another run. No output is emitted until validation succeeds. **Never
redirect stdout onto either input:** a shell can truncate it before Node starts.
A storage/write failure may leave an incomplete newly created output; it is not a
successful brief. The CLI exits 0 on success, 2 on usage errors, and 1 on input,
validation or output errors; diagnostics go to stderr, not brief stdout.
Options are explicit flag/value pairs; unknown/duplicate flags are errors. Prefix
filenames beginning with two hyphens with a relative directory such as ./.

### Library

~~~js
const { readFileSync } = require('node:fs');
const { createBrief, renderBrief, BriefError } = require('./lib/review-handoff.js');

const selectionBytes = readFileSync('examples/inputs/review-selection-dispatch-evidence.json');
const comparisonBytes = readFileSync('examples/inputs/comparison.json');

try {
  const brief = createBrief(selectionBytes, comparisonBytes);
  console.log(brief.reviewContext.purposeLabel); // Dispatch evidence follow-up
  console.log(brief.records[0].reportRecord.current.note); // exact source note
  console.log(brief.records[1].incomingPresent); // false
  console.log(brief.records[1].reportRecord.incoming); // null, not a deletion
  const markdown = renderBrief(selectionBytes, comparisonBytes); // validated again
  const json = renderBrief(selectionBytes, comparisonBytes, 'json');
} catch (error) {
  if (!(error instanceof BriefError)) throw error;
  console.error(error.code, error.message);
}
~~~

- createBrief(selectionBytes, comparisonBytes) returns a fresh plain JSON-compatible
  brief. Both arguments must be Buffer or Uint8Array; no parsed-object shortcut
  can bypass measurement of the original comparison bytes.
- renderBrief(selectionBytes, comparisonBytes, format = 'markdown') validates and
  returns a string ending in a newline. Supported formats: markdown and json.
- BriefError has a stable code plus a field/path-specific message. Important codes:
  COMPARISON_IDENTITY, SELECTION_POINTER, SELECTION_MISMATCH, SELECTION_COUNT,
  DUPLICATE_SELECTION, INVALID_CONTRACT, REPORT_METADATA, REPORT_COUNT,
  DUPLICATE_RECORD, INVALID_JSON, INVALID_UTF8,
  DUPLICATE_KEY, UNSAFE_NUMBER, JSON_DEPTH, INPUT_TYPE and OUTPUT_FORMAT.
- No input buffers are modified. Filesystem reads/writes are confined to the CLI;
  the library never opens paths or URLs, including paths embedded in evidence.
- Processing is synchronous and in-memory, intended for local exported reports.
  No streaming or authenticated provenance is claimed.

Runnable library examples, including an **explicitly derived in-memory empty
selection** that does not modify the real selection or recompute its fingerprint:

~~~sh
node examples/library-example.js
node examples/library-example.js --empty
~~~

### What the supplied pair produces

- Exact purpose label: **Dispatch evidence follow-up**.
- /records/3, id:MAR-014: changed; both snapshots present. The exact old/new notes
  and timestamps remain visible; status and revision remain unchanged.
- /records/4, id:MAR-015: missing incoming; current note stays an empty string,
  revision stays 0, updatedAt stays null, incoming stays null.
- The other 8 records are outside the requested scope, including changed MAR-DUP.
- Full selected report records are retained under records[].reportRecord, including
  both complete snapshots, evidence claims and reported changes. Markdown now
  leads with a skim-friendly brief and moves complete facts/provenance into a
  reference appendix. Inline JSON code spans and fenced JSON keep source text
  literal, including empty strings and nulls. Selection order is retained.

The byte-identical source copies live in [examples/inputs](examples/inputs/).
Generated outputs live separately:
[Skim-first Markdown brief](examples/generated/dispatch-brief-skim.md) ·
[Original Markdown example (preserved)](examples/generated/dispatch-brief.md) ·
[JSON brief (unchanged)](examples/generated/dispatch-brief.json).
Tests compare the revised Markdown and original JSON byte-for-byte with current
output, pin both original generated-file hashes, and check the source lengths and
SHA-256 digests recorded in the contract.

### Skim-first Markdown layout

The default Markdown layout starts with the exact purpose label, selected record
IDs, outside-scope count and a short review-only statement. Each selected record
shows its current/incoming status and note, reported changes, and compact source
filename/occurrence/physical-line references. Matching references are labeled
"Current & incoming"; differing references remain side-specific. Missing reference
metadata is marked "not supplied", never guessed. Incoming absence is prominently
marked **ABSENT**, with no deletion or approval implication.

The **Reference appendix — complete selected facts and provenance** follows the
brief. It preserves full selected records, exact purpose/context, comparison
identity and provenance limitations in literal JSON blocks. Inline source values
are JSON-quoted code spans: an empty note displays as `""`, not a missing value;
embedded newlines remain visible as escapes. Adaptive delimiters keep backticks,
HTML and Markdown in source data literal.

No new flag is needed; `--format markdown` (or the default) produces this layout:

~~~sh
node bin/review-handoff.js --selection examples/inputs/review-selection-dispatch-evidence.json --comparison examples/inputs/comparison.json --format markdown --output examples/generated/my-follow-up-skim.md
~~~

Choose a new output filename for each run. The supplied revised example was saved
as `examples/generated/dispatch-brief-skim.md`, without rewriting the original
Markdown or JSON example. The library uses the same layout via
`renderBrief(selectionBytes, comparisonBytes, "markdown")`. JSON serialization,
identity checks and file-safety behavior are unchanged. The supported validation
boundary is described below.

For a valid empty selection, Markdown retains its purpose, says no records were
selected (not that no differences exist), counts all report records outside scope,
and includes the comparison identity and provenance appendix without fabricated
record comparisons. Omitted and explicitly empty purpose labels remain distinct.

Focused presentation checks (including real CLI Markdown/JSON and empty runs):

~~~sh
node --test test/markdown.test.js
~~~

### Validation and meaning

Both measured byte length and SHA-256 must match, even for an empty selection.
Whitespace-only changes are stale bytes too. Then validate report version,
completeness, side validity and workspace labels; canonical pointer/index pairs;
exact keys, classifications and boolean presence flags; counts and duplicates.
No key-based fallback, coercion, silent deduplication, or stale-pointer repair.
An absent side must be explicit null; an omitted property or a falsey value is
not treated as absence. Invalid report structures are rejected even if unselected.

**Ownership boundary:** classifications, change flags, change-path labels and
delta values are producer-reported facts, not independently recomputed or
verified here. This consumer has no snapshot comparison engine and does not
resolve change paths, match evidence occurrences, or infer deltas from snapshots.
A `changes` entry requires a string path label and explicit current/incoming JSON
values; those values and repeated labels are preserved, even if they disagree
with the snapshots. Such acceptance is not a claim of semantic correctness.

Thus reports from the companion producer retain its order-insensitive
classifications and logical labels such as `/sourceEvidence/revised:15/sourcePath`
without duplicating its policy. Selected `/records/N` pointer/index/key checks
remain strictly positional and unchanged. Supported labels, required structure,
unique record/selection identities, explicit side presence and internal counts
are still checked. See the [contract](docs/review-handoff-contract.md).

UTF-8 JSON must be unambiguous. Duplicate decoded member names, BOM, depth over
128, negative zero, non-finite/underflowed numbers, unsafe integers, and decimal
values changed by the JavaScript number round trip are rejected rather than
silently rounded. Ordinary finite decimals such as 0.1 are supported if their
JSON decimal value round-trips unchanged. Whitespace, numeric spelling (1.0 vs 1)
and object-member order are not preserved in generated serialization; **source
files and accepted JSON values are preserved**. Source timestamps are strings,
not parsed into dates or used to choose a winner.

This is a **request for review only**, never an instruction to apply, merge,
approve, resolve, delete, or authorize anything. Omission implies no approval or
resolution. No incoming snapshot is invented. Empty selection means no requested
records—not that there are no differences. Byte identity is **not authentication,
trusted-source integrity, shared history, or authorization**. A mutually forged
selection and report cannot be detected by an untrusted fingerprint.

### Checks

~~~sh
node --test
~~~

Built-in node:test runs real-file library checks and actual Node subprocess CLI
checks: stale/same-length/whitespace-modified bytes; pointer/index/key/class/side
mismatches; malformed reports; exact values; duplicate JSON; unsafe numbers;
Unicode/Markdown literals; empty selection; CLI argument/errors; exclusive output
creation; and input preservation. Tests create and clean only their own temporary
fixtures. No mocks, dependency downloads, external services, or build step.
