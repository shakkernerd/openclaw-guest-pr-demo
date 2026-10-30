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

## Record Desk: offline JSON/CSV record review

Open **index.html** in the repository's Files preview, or open the file directly
in a modern browser. It is self-contained: no server, installation, network,
account, or build step is required to use it. Click **Try sample records** for a
four-record walkthrough.

1. Use **Choose JSON file** for a records array or saved review. To paste, select
   **JSON records array or saved review** (the default), paste the content, and
   click **Import & replace**:

   ```json
   [
     { "id": "R-101", "title": "Verify delivery address", "postcode": "Missing" },
     { "id": "R-102", "title": "Confirm parcel count", "items": 3 }
   ]
   ```

   CSV is an alternative for records: use **Or choose CSV records file**, or
   select **CSV records (header row required)** before pasting and clicking
   **Import & replace**. File selection imports immediately. The chosen control
   or paste format determines the parser, not the filename, MIME type, or content;
   there is no auto-detection or fallback to another format. For example:

   ```csv
   id,title,items
   R-101,"Verify address, including postcode",
   R-102,Confirm parcel count,003
   ```

   Here `items` is `""` or `"003"`, not a number. CSV imports records only; use JSON
   to restore or compare a saved review. See the exact CSV rules below.

2. Open a record by its title; mark it **Approve**, **Reject**, **Needs follow-up**,
   or return it to **Unreviewed**. Notes apply as you type. Expand **Original record** to see
   every field. Search titles, IDs, and review notes (case-insensitive), combined
   with the selected decision filter. For example, `signed count` finds a record
   with the review note `Inventory matches the signed count.`. Leaving the notes
   field refreshes the matching list/count without interrupting typing. If that
   note no longer matches, the same record stays open with a notice; subsequent
   edits still belong to it, not another matching record. All buttons and
   disclosure summaries share one note-exit path: the completed click finishes
   the note before the action, so targets cannot shift away between pointer
   press and release. This includes record selection, decisions, export/copy,
   download, and record details. Dragging off cancels the action; keyboard focus
   changes still refresh immediately.
3. Use **Export full review** for a versioned JSON snapshot containing **all** records,
   decisions, and notes, regardless of filters. Download it or select/copy the
   JSON into a UTF-8 text file. Import that export to restore the exact snapshot.
   Use **Export selected records (N)** for a handoff of only explicitly selected
   IDs, as described below. Both use the same version-1 snapshot and JSON import.

### Selected-record handoff

- Use the existing row **Select** toggles or **Select visible** to choose exact
  IDs. **Export selected records (N)** prepares exactly that set, including IDs
  hidden by search or decision filters. The selection count shows currently
  hidden IDs; the export panel reports the number included that were hidden
  **when prepared**. There is no additional decision-status restriction:
  unreviewed, approved, rejected and follow-up records are all eligible.
- Complete original record values and current decisions/notes are preserved.
  Records keep their original working-array order, not selection-click order.
  The result is an ordinary `record-review` version-1 snapshot with precisely
  one review per included ID; no selection metadata or new schema is added.
- No selection disables the selected-export button and explains why. It
  produces no selected file and never falls back to all records.
- The existing export panel serves both scopes. Its summary, scope notice,
  download/copy controls and feedback distinguish full from selected output.
  Suggested filenames are `record-review.json` for full and
  `record-review-selected.json` for selected. **Export full review** explicitly
  switches to all records and retains its live updates, regardless of filters.
- Selected output is prepared at activation, after the existing note-exit
  ordering. It stays identical across filter/search changes and panel
  close/reopen. Changing selection or working data (notes, decisions, bulk
  undo, or an accepted import) clears the prepared output and disables
  download/copy with an explanation. Use **Export selected records (N)** again
  to prepare current values. Rejected, unreadable and superseded imports do
  not invalidate it. Opening/selecting JSON never silently switches scopes.
- Preparing, selecting or requesting a download writes no working data or
  storage. It preserves selected and unselected records/reviews, the selected
  set, pending bulk undo, editor and fixed compared snapshot. Prepared output
  and export scope are transient and are not restored on reload.
- Downloads remain **requested, not confirmed**: embedded previews may block
  them silently. Selecting JSON is a manual-copy fallback, not proof of
  clipboard fidelity or a successful file. For decisive client verification,
  use an **actual downloaded file**, then **Choose JSON file** in an isolated
  recipient state. Check exact included IDs, order, full fields and reviews.
  Normal snapshot import **replaces** the recipient list; it does not merge.
  To bring a teammate’s returned decisions/notes into your existing dataset, use
  **Preview returned review**, not **Import & replace**, as described next.

### Returned review: preview, then apply review updates

1. Keep your working dataset open. Choose **Preview returned review**, then
   **Choose returned review to preview** for the teammate’s version-1 snapshot.
   Alternatively paste its JSON and use **Preview pasted review updates**.
   A selected handoff is an ordinary version-1 snapshot; full snapshots also
   work. Raw arrays, CSV, unsupported versions and malformed snapshots are
   rejected. No new file format, schema, storage key or dependency is involved.
2. Inspect the separate **read-only preview**, with counts and expandable
   entries for every returned ID, in returned-snapshot order:
   - **Eligible update:** the exact ID exists and its complete original record
     still matches, but the decision and/or notes differ.
   - **Unchanged review:** the record, decision and notes already match; no write
     is needed.
   - **Unknown ID:** absent from the current dataset; unapplied, never created.
   - **Changed-record conflict:** the ID exists but any original record field or
     value differs; unapplied, with the current record **and review** kept.
   Each entry shows full current/returned records and reviews as literal JSON
   text, not interpreted HTML. Equality compares all values and types recursively:
   missing differs from null/empty, numbers differ from strings, array order
   matters and object key order does not. IDs are case-sensitive and untrimmed.
   There is no source coercion, automatic winner, field merge or replacement
   record. The existing JSON numeric-precision/serialization limits still apply.
3. Use **Apply review updates** deliberately. It parses and validates the
   **complete incoming snapshot again**, including unknown/conflicting entries,
   then derives eligibility from current working state. Only eligible decision
   and note pairs are applied in one validated batch. Empty notes and Unreviewed
   are real returned intent, not missing values. Any invalid entry rejects the
   whole action before writes. A fresh preview with no eligible updates disables
   Apply and performs no writes. Export a full backup before applying.

Preview, rejection, closing and a stale Apply do not change working records,
reviews, selected IDs (including hidden selections), prepared output, saved-review
comparison or bulk undo. Preview does not save or replace the working dataset.
On successful Apply, every original record, field, type and working-array order
is retained; reviews outside the eligible set stay intact. Selection and filters
never limit or retarget the proposal. Full export remains live, and a previously
prepared selected export is invalidated with the existing working-data-change
explanation. The existing comparison’s saved side stays fixed and read-only;
its current side follows applied updates.

**Freshness:** a preview holds the immutable working-state identity, not a future
replacement state. If data or reviews change after preview—even an unrelated
note, an accepted import, an undo, or edits later reverted—the next Apply only
refreshes the proposal and reports **nothing applied**. Inspect that current
proposal and deliberately Apply again. Another edit requires another refresh.
This also lets a formerly unknown/conflicting entry be reconsidered without a
silent write. Search/filter, selection, comparison and rejected imports do not
change the working state or require a refresh. Same-value single-record review
actions conservatively require a refresh too.

**Existing bulk undo:** any successful nonempty returned-review batch clears the
previous decision-only bulk undo, including notes-only updates or updates outside
that older bulk set. Otherwise an old undo could reverse newer returned intent.
The UI explains the invalidation. Preview, rejected/stale actions and zero-update
proposals leave the previous bulk undo intact. Later ordinary bulk actions can
create their usual decision-only undo. Returned recovery never resurrects an
older bulk undo entry.

**One-step returned recovery (new capability):** after a real Apply, choose
**Undo last returned-review updates** to restore the exact prior decisions **and
notes** of that actual batch. All records, fields, types, order and other reviews
stay unchanged. Selection (including hidden IDs), search/filter and the fixed
compared snapshot stay intact. The comparison’s working side and full export
follow Undo; a prepared selected export is invalidated, just as on any working
data change. Undo leaves a retained proposal stale: inspect its refreshed preview
before deliberately applying again.

Only the last actually applied batch is recoverable, once. A new nonempty Apply
replaces the entry; any later successful working-value mutation (including a note
edit anywhere, decision edit or bulk action/undo) or accepted dataset replacement
invalidates it, even if values are later reverted. Rejected/unreadable/superseded
imports, rejected or zero-update applies, stale preview refresh, same-value
scalar edits and no-effect bulk actions preserve it. Query/filter/selection,
comparison, exports, and preview changes/closure also preserve it. Same-value
scalar actions still retain the existing conservative preview-refresh behavior.
The disabled Undo control and its status explain availability; reopening the
returned panel does not discard recovery. There is no redo, history stack or
persisted recovery; reload restores only the working snapshot. This extends the
previous intentional no-undo boundary, rather than correcting an apply defect.

Returned file reads have their own latest-started-wins order, independent of
import and comparison. A newer preview attempt (even rejected), editing the
paste input, or closing the panel clears the old proposal and cancels pending
success/failure. File reads build the preview from working state at completion.
Closing clears only the returned preview, not the working review or comparison.
The proposal, source text and freshness guard are transient; reload restores only
the existing version-1 working snapshot.

### Returned reviews from the terminal

With Node.js 22 or newer, run from the repository root (no installation, package
script, browser, or service required):

```sh
node review-return.js working.json returned.json
node review-return.js working.json returned.json --plan
cat returned.json | node review-return.js working.json - --plan
cat working.json | node review-return.js - returned.json --plan
node review-return.js working.json returned.json --apply result.json
node review-return.js --help
```

Both inputs must be complete version-1 `record-review` snapshots, including one
valid review for each record in that input. A returned snapshot may contain only
selected records; empty snapshots are valid, but raw record arrays and CSV are
not accepted. Quote paths with spaces; prefix a filename beginning with `-` with
`./` (including `./-` for a file literally named `-`). Relative paths resolve
from the current directory, and absolute paths work too.

#### Read-only intake and proposed-application plan

Use `--plan` after the two inputs for a complete machine-readable report, rather
than the existing counts-only default. This extends the existing CLI; it is not
a second policy engine or the separate multi-return analysis report below.

- For `--plan` or default counts, **one** input may be `-`: read UTF-8 standard
  input through EOF. Either the working or returned input can be piped/redirected.
  Two `-` inputs are rejected before reading; concatenate neither snapshots nor
  JSON Lines. Without `-`, stdin is ignored. Interactive stdin waits for EOF.
  There is no streaming/partial plan: complete inputs are held in memory.
- `--plan` writes only the existing `previewReviewUpdates` result to stdout:
  two-space-indented JSON followed by one LF, with no summary, filenames,
  timestamps, replacement snapshot or additional envelope. Top-level fields
  are `counts` and `entries`. Counts are `total`, `eligible`, `unchanged`,
  `unknown`, `conflict`; entries are `{ id, kind, before, after }` in **returned
  record order**, including every returned record. Each side contains the full
  `record` and normalized `review: { decision, notes }`; `before` is `null`
  for unknown IDs. Working-only records are not proposals and are not listed.
- `eligible` proposes the returned decision/notes pair; `unchanged` needs no
  update. `unknown` IDs and changed-record `conflict` entries remain visible
  with their complete values, never silently applied or discarded. A mismatch
  **does not establish which input is older**. There is no age, winner, merge
  or stale-input inference. The command never calls apply, makes a candidate
  state, writes a file, or modifies either input in plan mode.
- The shared owner alone parses, normalizes and classifies. It accepts a leading
  BOM, preserves record fields/values, exact untrimmed case-sensitive IDs,
  decision/notes text, nested array order and types, and ignores object member
  order for equality. Missing, null and empty are distinct. Extra snapshot/review
  metadata is normalized away by the existing owner, not emitted by a new schema.
  JSON/JavaScript numeric-precision and serialization limits still apply.
  Output is deterministic for the same input bytes; it is not key-sorted or
  a byte-preserving copy of input formatting.
- Both complete snapshots must pass validation, even reviews on unknown or
  conflicting records. Malformed/empty JSON, invalid shape/version/reviews and
  duplicate record IDs reject the **entire** plan. Owner diagnostics are retained,
  prefixed with the working/returned role and filename or `(stdin)`. A duplicate
  record reports its one-based position and exact ID; it is not deduplicated.
- Success (including conflicts, unknown IDs or no entries) exits **0**, with only
  the JSON report on stdout and empty stderr. Help exits 0 with usage on stdout.
  Usage, read or validation failure exits **1**, with a diagnostic and usage on
  stderr and **empty stdout**, never a partial validation report. A detected
  `--plan` stdout write failure exits **1** with a `Could not write plan to stdout`
  diagnostic and usage on stderr. Output may be partial on a write failure; check
  the exit status and complete captured output. No output file option is added. If redirecting
  stdout, use a separate report path: the **shell** can truncate an input before
  Node starts, and can leave an empty report when validation fails.
- `--plan` and `--apply` are mutually exclusive; all combinations are rejected.
  `--apply` still requires two file paths and does not accept stdin. The plan is
  not a saved approval token or apply input; every invocation rereads its inputs.
  There is no file locking or concurrent-edit detection. Keep real input/report
  data private and outside Git.

#### Existing counts and explicit fresh-file apply

- The default remains a **read-only preview**: it prints eligible, unchanged,
  changed-record-conflict and unknown-ID counts, without writing a file.
- `--apply result.json` explicitly creates **one fresh full snapshot**, even
  when there are zero eligible updates. It applies only eligible decisions and
  notes through the shared owner. Every original working record, field, JSON
  value/type and array order remains; other reviews and conflicts stay unchanged.
  Unknown IDs are not added. Object key order is irrelevant to eligibility;
  array order, exact IDs and value types are significant, just as in the UI.
- Both complete inputs are read and validated before any output-file effect;
  invalid entries on unknown or conflicting IDs reject the whole operation.
  The existing version-1 JSON parsing/serialization limits still apply. This is
  a canonical JSON export, not preservation of input whitespace or byte layout.
- Output uses exclusive fresh creation (`wx`) at the write boundary, **not an
  existence precheck**. An existing destination, either input, a path alias,
  symlink (including a dangling link), or hard link is refused without overwrite.
  Parent directories must already exist. Inputs are opened only for reading.
- Success/help exit 0; usage, validation, read and write errors exit 1 with a
  diagnostic and usage. A write failure can leave an empty or partial **new**
  output file; inspect it and choose a fresh path before retrying. There is no
  atomic-disk-write, crash-durability, rollback, or automatic cleanup promise.
- Each invocation rereads both files and derives eligibility from that invocation's
  working snapshot. A preview is not a saved plan or approval token: changes
  between commands are considered afresh by Apply. There is no cross-invocation
  stale-plan protection, file locking, or detection of concurrent input edits.

The terminal adapter reuses the exported `parseSnapshotJSON`,
`previewReviewUpdates`, `applyReviewUpdates` and `exportJSON` APIs from
`review-state.js`. The existing private validator and recursive comparison stay
behind those owners. There is no second merge policy or change to the UI, scalar
APIs, format, persistence or schema.

### Reconcile a baseline, working review and return (read-only)

With the existing Node.js 22+ tooling:

~~~sh
node review-reconcile.js baseline.json current.json returned.json
node review-reconcile.js baseline.json current.json -
node review-reconcile.js --help
~~~

This **separate** command emits a UTF-8 JSON plan to stdout. There is **no apply
mode, output-file option, input overwrite or source-data merge**. The existing
two-way command and browser preview/apply behavior are unchanged. Use this
planner when you have explicitly selected a baseline, current working snapshot
and returned snapshot; their roles do not prove chronology, real reviewer
identity, independence or actual human approval. Even an `approved` decision is
only stored review metadata, not an attestation.

All inputs must be complete version-1 `record-review` snapshots. Selected subsets
and empty snapshots are valid; raw arrays and CSV are not. Every record and
review is validated, including excluded/conflicting entries. At most one input
may be `-` (UTF-8 stdin through EOF); otherwise stdin is ignored. Quote paths with
spaces and prefix filenames beginning with `-` with `./`. Success/help exit 0;
usage, read, validation, serialization and stdout delivery errors exit 1 with
diagnostics on stderr. Invalid input or a non-finite number retained in the plan
produces no stdout. A delivery failure may leave partial stdout, so check both
status and complete captured output. The command
only opens input paths for reading. **Do not redirect stdout onto an input**:
the shell can truncate it before Node starts. Reports contain source data and
notes; keep them private and outside Git. There is no file locking or detection
of concurrent edits during reads; each invocation rereads its inputs.

The real owner API is
`require("./review-state.js").planReviewReconciliation(baseline, current, returned)`.
It accepts snapshot objects, validates/normalizes all three with the existing
private `validateSnapshot`, and compares with the existing private `equalJSON`.
It returns a pure projection without modifying inputs, storage or working state;
record values are retained by reference, as in existing comparison APIs. Treat
those values as read-only. The CLI uses `parseSnapshotJSON` and this API, with no
second reconciliation policy or exported validation/comparison seam.

The JSON result has `kind: "record-review-reconciliation"`, `counts` and `entries`.
It is **not an importable snapshot, approval token or apply input**:

- Each entry is `{ id, kind, issues, baseline, current, returned, proposed }`.
  Each snapshot side is the complete `{ record, review }` or `null` when absent.
  Reviews normalize to exactly `{ decision, notes }`, as in existing exports;
  extra envelope/review metadata is ignored, while all source fields remain.
  `proposed` contains **only** the returned decision/notes pair for a `proposed`
  entry, otherwise `null`. No source record is ever proposed for application.
- For IDs present in all three snapshots, **any** source record change from the
  baseline on current or returned produces `conflict`, even when both changed
  sources match, reviews match, or reviews have not changed. Issues identify
  `current-source-changed` and/or `returned-source-changed`.
- With unchanged source records: neither review changed → `unchanged`;
  returned only changed → `proposed`; current only changed → `preserved`;
  both changed identically → `converged`; both changed differently → `conflict`
  with `review-diverged`. Decision and notes are an indivisible pair: disjoint
  decision/note edits on different sides are not combined. Preservation and
  convergence require no proposed update and never write anything.
- The union of all exact IDs is reported once. IDs absent from baseline are
  `unknown`, even if current and returned match. Baseline IDs absent from current
  and/or returned are `missing`; absence is not deletion intent. Issues retain
  `unknown-baseline`, `missing-current` and `missing-returned` as applicable.
  A source change on an available baseline/side pair takes precedence as
  `conflict` even if the other side is missing; absence issues remain visible.
  Otherwise unknown takes precedence over missing. These entries never propose
  changes. A missing/blank/non-string ID **inside a record**, duplicate ID or
  missing/unknown review-map key instead fails existing whole-snapshot validation.
- Entry order is returned record order, then IDs without a returned occurrence
  in current record order, then remaining baseline-only IDs in baseline order.
  No ID sorting, renaming, trimming or numeric conversion occurs. Issues are
  ordered unknown-baseline, missing-current, missing-returned, current-source-
  changed, returned-source-changed, review-diverged, omitting inapplicable items.
  `counts.total` is the union size; each other count (`proposed`, `preserved`,
  `unchanged`, `converged`, `conflict`, `unknown`, `missing`) counts entry kinds,
  not issue occurrences.

Object member order is irrelevant to comparison; array order, field membership
and exact types/strings matter. Zero, empty string, null and missing fields are
distinct. Notes retain whitespace, CRLF/LF and Unicode without normalization.
Prototype-like IDs/fields are literal own keys; large ID **strings** remain exact.
The CLI uses native JSON serialization (two-space indentation plus a trailing
newline), retaining negative zero with `JSON.rawJSON`. If a number retained in
the plan is non-finite after JSON parsing (for example, `1e400` becomes
`Infinity`), serialization is refused with exit 1 and empty stdout, rather than
emitting `null`. This is a serialization boundary, not a change to snapshot
validation/normalization or the owner API. Finite numbers, negative zero and
literal strings are preserved as parsed values. Existing JavaScript parsing
may already round numbers or underflow them to zero; original number spelling
and arbitrary precision are not preserved. This is not a lossless number parser
or a byte-layout copy of inputs. Input bytes stay intact.

Focused checks (no browser process, installs or unrelated suites):

~~~sh
node --test --test-timeout=15000 review-reconcile.test.js
node --test --test-timeout=15000 --test-name-pattern='returned|comparison' review-state.test.js
node --test --test-timeout=15000 --test-name-pattern='returned|accepted replacements reclassify' review-app.test.js
node build-review.js --check
~~~

The new tests exercise the real owner and bounded, joined CLI children using
fresh synthetic committed fixtures in `test-fixtures/review-reconcile/`. They cover
the three-way matrix, source changes on both sides, missing/unknown identities,
exact values, complete validation, normalization, deterministic order, stdin,
read-only input bytes, non-finite serialization refusal with finite/negative-zero
controls, failed stdout and existing two-way CLI controls. Each test
registers teardown immediately for its own newly created temporary directory,
so cleanup runs on success or failure. Existing adapter tests check browser logic in
Node, not native browser/file-picker/layout behavior. Because the shared owner is
inlined into both offline pages, regenerate them with `node build-review.js` when
changing it; no browser adapter/template or two-way policy change is required.

### Analyze multiple returned snapshots (read-only)

With Node.js 22 or newer, use the separate analysis command:

```sh
node review-return-analysis.js working.json first.json second.json --output report.json
node review-return-analysis.js --help
```

One working snapshot and **one or more** returned snapshots are required, followed
by an explicit `--output` and fresh report path. Each input must be a complete
version-1 `record-review` snapshot, including valid reviews for unknown IDs
and changed records. Selected-record snapshots and empty snapshots are valid;
raw arrays, CSV and malformed snapshots are not. Paths may be relative or
absolute; quote spaces and prefix names beginning with `-` with `./`.
Filenames in the report are the original argument **basenames**, not full paths.

This command only analyzes: it does not apply reviews, select winners, vote,
infer approval or reviewer independence, merge records, or create a replacement
review snapshot. An unchanged review is still a proposal. Repeated input files
and duplicate basenames remain separate sources identified by one-based ordinal
in returned-argument order; repetition does not establish independent reviewers.

The UTF-8, indented JSON report has exactly these top-level fields (no
`format`, `version`, `records` or `reviews` snapshot envelope):

- `kind`: `"record-review-return-analysis"`. This is an analysis report,
  **not an importable version-1 review** or an apply plan.
- `working`: `{ filename, recordCount }` for the working input.
- `sources`: entries `{ ordinal, filename, counts, issues }` in returned-input
  order. `counts` reuses the canonical `total`, `eligible`, `unchanged`,
  `conflict` and `unknown` fields, each measured against the same working
  snapshot. `issues` contains only `{ id, kind }` entries: changed-record
  `conflict` issues first in working-record order, then `unknown` IDs in
  that returned file's record order. These counts/issues are not votes.
- `overlaps`: entries `{ id, status, proposals }` in working-record order,
  only for working IDs with matching complete original record data in at least
  two input sources. **Both eligible and unchanged proposals participate**;
  unknown IDs and changed-record conflicts are excluded from proposals, even
  when several returned files share them. Each proposal contains exactly
  `{ sourceOrdinal, filename, decision, notes }` in returned-input order,
  preserving the exact decision and notes (including whitespace, CRLF/LF,
  Unicode, empty notes and `unreviewed`). `status` is `"identical"` only
  when **all** decision-and-notes pairs match exactly; otherwise it is
  `"disagreement"`. Neither status chooses or approves anything. A single
  returned input produces per-file analysis with no overlap rows.

The adapter calls the existing exported `parseSnapshotJSON` and
`previewReviewUpdates` APIs. Version-1 validation, recursive record equality
(object member order irrelevant; array order and types significant) and preview
classifications remain owned by `review-state.js`. It adds no validator,
merge policy, state owner, v1 schema change or change to existing UI/scalar APIs.
The existing JSON numeric-precision and parsing limits still apply.

Every complete input is read and validated, and the report serialized, **before
any output-file effect**. Inputs are read only and their bytes are not rewritten.
Output uses exclusive fresh creation (`wx`), not an existence precheck: existing
destinations, any input, path aliases, hard links and symlinks (even dangling
links) are refused without overwrite. Parent directories must already exist.
Success/help exit 0; usage, read, validation and write errors exit 1 with a
diagnostic and usage. A write failure may leave an empty or partial new file;
inspect it and use a fresh path for a retry. There is no atomic-disk-write,
crash-durability, rollback or automatic cleanup promise. Each invocation rereads
all inputs; no saved plan, file locking, concurrent-input-edit detection or
cross-invocation stale-plan protection is provided. Keep real input files,
reports and command receipts private and outside Git.

### Explicit selected-record decisions and one-step undo

Use a row's **Select** toggle to include that exact ID in a bulk set. Its pressed
state and **Selected** text identify membership; opening a record by its title
only changes the editor, not the set. Select buttons support Tab and Enter/Space.

- The bulk panel shows the total selected and how many are hidden by the current
  search/decision filter. Filtering never retargets or drops selections. **Select
  visible** adds all currently matching IDs, retaining hidden selections; it is
  disabled with no matches or when all matches are already selected. When leaving
  notes, visibility is evaluated after note completion, just like the list.
- **Clear selection** removes the whole set, including hidden IDs, without
  changing the editor or any review. It is disabled when the set is empty.
- Choose any existing decision and use **Apply to N selected**. This applies to
  exactly those IDs, including hidden ones—not the open editor or all filtered
  records. Apply is disabled for an empty set. Selection remains after applying.
  Original fields, every note and all unselected decisions remain untouched.
- The result reports **changed** versus selected counts. Already-matching
  decisions are not counted as changes. One validated batch in the existing
  state owner copies the review map once, rather than once per selected ID.
- **Undo last bulk action (N)** restores only those N changed decisions, keeping
  later notes and all other data. There is one transient undo entry, not a
  history or redo stack. Search/filter, selection, editor navigation, notes and
  comparison and export do not consume it. Undo does not restore an earlier selection.
- Any later single-record decision clears undo, even a same-decision click on an
  unrelated record. A later bulk action replaces it; a nonempty but no-op bulk
  action clears it and reports zero changes, without writing storage. Empty
  actions create no undo work. Choosing a dropdown value alone is not an action.
- Successful **Apply review updates** also clears this old decision-only undo,
  even when only returned notes change; the UI explains why. Preview and stale
  refresh do not consume it. Returned-review updates create only their separate
  exact-decision-and-note recovery, never a decision-only bulk undo entry.
- Accepted JSON arrays, CSV (including empty/header-only datasets), saved-review
  restores and sample data clear selection and undo. Rejected/unreadable or
  superseded imports leave both intact. Reload starts with neither. They are
  never exported or persisted; the version-1 format and storage key are unchanged.
- New selection, apply, clear and undo buttons use the existing note-exit click
  ordering: a completed click keeps the note and acts on its intended ID/set,
  even if note changes remove a row from the results. Dragging off cancels the
  action. The fixed compared snapshot stays fixed; its current side follows
  accepted bulk decisions and undo, as it follows single-record edits.

### Compare a saved review without replacing your work

Use **Compare saved review**, then choose a saved JSON file or paste its contents
and activate **Compare pasted review**. Comparison accepts the same version 1
Record Desk snapshot that Export produces, validated by the existing state
owner. Raw record arrays and CSV are deliberately not accepted for comparison; the
import/export contract and format/version are unchanged.

- The comparison is **read-only**. It does not import, merge, write storage,
  replace records/decisions/notes, change the selected record or search/filter,
  or reset the notes editor's native Undo history. There is no Apply action.
  Export/import remain separate, explicit actions.
- Summary counts show current and compared totals, added/removed IDs, and shared
  IDs that are changed or unchanged. Among shared IDs, record-field changes are
  counted separately from decision/note changes, with decision and note counts
  also shown. These categories can overlap; a record can change in both ways.
- IDs match exactly and case-sensitively. Changed/removed current IDs appear in
  current record order, followed by added IDs in the incoming snapshot's order.
  Records are aligned by ID, not position. Object key order is ignored, including
  nested objects; array-valued fields retain order and JSON value types matter.
- Expand each changed entry to see **Current working review (before)** and
  **Compared snapshot (after)**, with complete records and decision/note values.
  Values are rendered as JSON text, never HTML. Empty strings appear as `""`,
  missing records are explicitly marked, and Unicode/HTML-looking text is kept.
  The sides stack at narrow widths. Tab reaches native controls and entry
  summaries; Enter/Space activates buttons and opens/closes summaries.
- The current side follows subsequent working edits and imports, regardless of
  search/filter, while the compared snapshot stays fixed. Expanded changed
  entries stay expanded as you edit. Neither snapshot is merged into the other.
- **Close & clear comparison** clears the comparison and returns focus to its
  opening button. Collapsing the comparison panel also clears it. Nothing from
  comparison is stored or restored on reload.
- Starting another comparison clears the previous results while the file is
  read/JSON is validated. Invalid snapshots and unreadable files leave no stale
  comparison results and do not affect working data. Newer attempts (including
  rejected ones) and closing the panel supersede earlier pending reads. Import
  and comparison have independent read ordering.

### Import and saving rules

- IDs and titles must be non-empty strings; IDs must be unique. Convert numeric
  IDs to strings. IDs are exact and case-sensitive, with no trimming/coercion.
  Use stable IDs for the same entities, not row numbers. Additional fields stay
  in the original records and exports; review metadata is stored separately.
- Every import action, including sample data, **replaces the record list**.
  JSON record arrays and CSV retain reviews for matching IDs, even if titles
  change. New IDs start unreviewed; omitted IDs and their reviews are removed.
  An empty array clears
  the list; a valid header-only CSV does the same. Accepted CSV uses the same
  replacement transition as arrays: the editor resets to the first record, bulk
  selection and undo clear, search clears, the decision filter returns to All
  records, and the new state is saved when storage permits. Export before replacing data you may want later.
- A Record Desk export has `format: "record-review"`, `version: 1`, `records`,
  and `reviews` keyed by ID. It restores its own reviews, not a merge. Unsupported
  versions, missing/extra reviews, invalid decisions, duplicate IDs, malformed
  JSON/CSV, and unreadable files are rejected without changing accepted data,
  decisions, notes, selection, search/filter, or storage. JSON and CSV files,
  pasted content, and sample imports share one latest-started-wins order: a newer
  import supersedes an earlier pending file read, even if the newer import is
  rejected. Merely changing the paste selector does not start an import or change
  the parser of a pending file read. Saved-review comparison keeps its independent
  read order and fixed compared snapshot; its current side follows accepted CSV
  just as it follows accepted JSON.
- When available, localStorage holds one review under `record-review:v1`.
  Reloading the same browser location restores it. Access/write failures leave
  the app usable in memory and display a warning. Corrupt/unsupported saved data
  is not overwritten on startup or rejected imports; the next accepted change
  replaces it. Browser storage is not encrypted, shared across tabs at the same
  origin, and last write wins; use one review tab and export important work.
- The embedded **Files preview may block browser storage and downloads**. Its
  sandbox is unchanged. A download click cannot prove that a file was saved, so
  the app says “requested, not confirmed.” If nothing downloads, select the
  displayed full/selected JSON, then Ctrl/Cmd+C, and save the text yourself.
  Clipboard fidelity is not verified. Export **before closing
  or reloading** a memory-only preview. Direct-file storage also varies by browser;
  moving the HTML file may change its storage location.
- Intended for modest datasets that fit in browser memory; the entire input is
  parsed/rendered locally. No data is uploaded. JSON numbers use JavaScript's
  normal numeric precision; keep exact large identifiers/values as strings.

### CSV parser contract

The small, dependency-free parser in the existing state owner supports comma-
separated records, not spreadsheet dialect detection or a separate record schema.

- The first row is a header. Decoded names must be unique, case-sensitive and
  non-blank (empty or whitespace-only names are rejected), and must include exact
  `id` and `title`. Names are not trimmed: `ID` or ` title` cannot replace those
  required names, and `extra` and ` extra ` are distinct ordinary fields. Quoted
  headers follow the same quoting rules as data cells.
- All decoded cells are source **strings**, including empty strings, leading
  zeroes, large numbers, whitespace and Unicode. No trimming, type conversion,
  formula evaluation or source priority is applied. Extra columns become ordinary
  record fields, including `notes`, `decision`, `__proto__` and `constructor`;
  none imports review metadata. The existing JSON-array record validation then
  requires non-whitespace IDs/titles and unique exact IDs.
- CSV preserves decoded strings, not original file bytes. For file imports,
  `File.text()` first decodes UTF-8, consuming a leading UTF-8 BOM and replacing
  malformed UTF-8 with U+FFFD. The parser then removes one leading U+FEFF from
  its supplied string; other U+FEFF characters in that string are preserved.
  Thus two consecutive leading encoded BOMs can both disappear during file
  import: one during decoding and one during parsing. Direct string input skips
  file decoding and loses only one leading U+FEFF. Other encodings are not
  detected; file import does not provide strict UTF-8 validation or byte preservation.
- Outside quotes, LF, CRLF and CR separate rows (mixed endings are accepted).
  Inside quotes, commas and line endings are literal cell content, with line
  endings preserved as supplied to the parser. A browser textarea normalizes
  pasted CR/CRLF to LF; use file import when those distinctions matter.
- A quoted cell must start with `"` as its first character. Inside it, `""`
  represents one literal `"`. A closing quote must be followed immediately by a
  comma, row ending or end of input: even trailing spaces are rejected. Quotes
  within unquoted cells and unclosed quotes are errors; nothing is repaired.
- Every data row must have exactly as many cells as the header. Empty extra-field
  cells are kept, including a final empty cell after a comma. Blank rows are not
  skipped. One final row ending is optional and adds no extra row; another ending
  creates a blank row and is rejected. Error row numbers count logical CSV rows
  (including the header), not physical lines inside quoted cells.
- Empty input (including BOM-only input), whitespace-only input, blank/duplicate
  headers, missing required columns, malformed quotes, inconsistent row lengths
  and invalid records are rejected atomically. A valid header without data rows
  is an intentional empty dataset and **clears the list**, like JSON `[]`.

CSV import does not change version-1 JSON export, restoration or comparison.
Exports remain JSON so all record fields and separately owned reviews round-trip.

### Small source layout

- `review-state.js`: JSON/CSV parsing, pure validation, identity-based state
  transitions, snapshot comparison, returned-review eligibility/batch apply,
  filtering, export, and guarded storage;
  also usable in Node tests.
- `review-reconcile.js`: separate read-only three-way stdout planner, backed by
  `planReviewReconciliation` in the shared owner; `review-reconcile.test.js` tests
  the real owner/CLI with fresh synthetic fixtures.
- `review-return.js`: thin Node terminal/file/stdin adapter for returned-review
  counts, read-only JSON plans and exclusive fresh-output apply;
  `review-return.test.js` executes the real command.
- `review-return-analysis.js`: read-only multi-return report adapter;
  `review-return-analysis.test.js` exercises the real command and complete reports.
- `review-app.js`: DOM events, independent async import/comparison/returned-read
  ordering, transient selection/undo/preview freshness, rendering and download UI.
- `review-template.html`: accessible, responsive markup and inline CSS.
- `build-review.js`: built-in Node APIs only; inlines those sources into the
  delivered `index.html` so restrictive previews need no relative asset access.

Returned updates extend the existing owners rather than introducing a merge
framework: `validateSnapshot`/`parseSnapshotJSON` own the version-1 boundary;
`equalJSON` owns recursive comparison for both saved and returned snapshots;
`previewReviewUpdates` and `applyReviewUpdates` own pure review-only transitions.
`undoReviewUpdates` guards recovery by the actual applied immutable identity; the
adapter retains just before/after identities, not copied snapshot stores. Its
validated same-value scalar path carries recovery forward to the new identity
without changing scalar transition or preview-freshness contracts.
`importJSON`/`importCSV`/`replaceRecords` still own replacement imports, unchanged.
The adapter’s `selectedIds`, `bulkUndo`, `save`/`invalidateSelectedExport` and
fixed `comparedSnapshot` keep their existing responsibilities. No returned
metadata enters persistence or export.

After editing those sources, run:

```sh
node build-review.js
node build-review.js --check
node --test review-state.test.js review-app.test.js review-analysis.test.js review-analysis-app.test.js review-return.test.js review-return-analysis.test.js parcel-label.test.js
git diff --check
```

Terminal tests use real Node subprocesses and temporary synthetic files to check
preview, full-output preservation, complete invalid-input rejection, help/errors,
zero-update output, rereading between invocations and exclusive-output protection
(including aliases, links and competing writers). Plan tests assert complete ordered
output values/bytes from files and either stdin input, BOM/whitespace and input-byte
preservation, normalization, malformed/duplicate rejection with empty stdout, and
mutually exclusive modes. A real-CLI regression pairs complete successful output
with a verified read-only stdout descriptor, requiring nonzero exit and a diagnostic
on failed delivery while input bytes remain unchanged. A source harness forbids
apply/export/file-path writes, permitting only stdout with frozen owner states.
No production test seam is used.
Multi-return command tests also cover unchanged proposals, exact decision/notes
pairs, identical/disagreeing overlaps, source/record order, excluded issues,
duplicate basenames/repeated inputs, and rejection of any invalid complete input
before report creation.
For CLI-only changes, run the named Node tests and `node build-review.js --check`;
no page rebuild or browser run is needed. Keep real handoff inputs, outputs and
command receipts private and outside Git, separate from synthetic test fixtures.

The existing parcel helper and its three tests are unchanged. The additional
Node checks cover atomic rejection, stable-ID reconciliation, special object-key
IDs, decisions, title/ID/notes search with decision filters, export round trips,
corrupt/blocked storage, and freshness of the shipped preview. Comparison state
tests cover validation, exact IDs, semantic JSON equality, categories/counts,
ordering, empty snapshots, and immutable inputs. `review-app.test.js` runs the
actual DOM adapter against a small Node harness for complete text rendering,
working/editor/storage isolation, live updates, and deterministic file-read
success/failure/supersession races. This harness does not test browser layout or
native keyboard/Undo behavior.
Returned-review checks cover the four categories, nested values/types and special
keys, complete validation before writes, unchanged record identity/order, excluded
review preservation, state freshness after edits/imports/undo, repeated deliberate
Apply, no-op behavior, notes-only undo invalidation, hidden selection, prepared
export invalidation, full round trips, fixed comparison, text-only rendering,
note-exit ordering and independent file-read cancellation/races. These are source
and Node-harness checks, not actual returned-file or client/media acceptance.
Returned Undo checks additionally cover exact decisions/notes and state identity,
one-step consumption/replacement, newer edits/imports/reload, no-effect/rejected
operations, view-only preservation, and independent later-note-preserving bulk
Undo. The retained actual apply oracle and complete pre-apply recovery are checked
privately without committing handoff inputs or outputs. Actual file → preview →
Apply → Undo → full-export equality and focused changed-UI media remain separate
acceptance work in the requester’s retained approved browser.
For this contribution, run only the named Node files: do not launch a browser,
run the optional browser suite, or enable its browser/sandbox switches. UI client/media acceptance is separate from these Node checks. For terminal-only
work, execute the command on the actual supplied snapshots and retain its output
for comparison with existing UI evidence; do not replay the UI or browser suite.
Selected-handoff Node checks cover exact membership and original order, all
decision statuses, complete nested/special-key values and notes, empty/invalid
selection, hidden selections, explicit scope switching and invalidation,
download Blob contents/filenames, normal JSON file-control recipient import,
working/undo/comparison isolation and unchanged live full export. Blob requests
in this harness are not proof of an actual browser download; client file proof
remains separate. Run only the named Node files with browser-launch opt-ins
unset for this contribution; do not launch the optional browser/baseline suite.
CSV checks cover lossless string/quote/line-ending handling, strict header and row
errors, shared JSON-array validation/reconciliation, ordinary metadata-like column
names, atomic UI/storage rejection, explicit format routing, mixed-format pending
read ordering, header-only clearing, JSON snapshot restoration, and live comparison.

Bulk tests cover exact/prototype-like IDs, atomic late rejection, one review-map
copy, mixed/no-op decisions, later-note-preserving undo, later decision intent,
selection/editor/filter isolation, hidden counts, transient replacement/rejection
and reload behavior, full exports and fixed comparison updates. Physical browser
checks cover row selection (including a disappearing current row), select-visible,
clear, apply and undo while notes are focused, drag cancellation, native keyboard
activation, and narrow layout.

The twelve optional real-browser scenarios in `review-browser.test.js` are
skipped unless `RECORD_REVIEW_BROWSER` points to an already installed Chromium.
Leave browser-launch opt-ins unset for the default Node checks; no browser
installation is required.

To exercise those checks with an existing browser (no download or installation):

```sh
RECORD_REVIEW_BROWSER=/path/to/chromium node --test review-browser.test.js
```

## Read-only multi-return analysis page

Open **review-analysis.html** directly as a self-contained offline file. This is
separate from Record Desk: it does not edit the working snapshot or choose a
winning proposal.

The **Report workflow** control offers **Analyze input files** (below) and
**View saved report**. To read a CLI-produced or downloaded analysis, select **View
saved report**, choose its JSON file, then click **View saved report**. No working
or returned snapshot is needed, and no original filename in the report is opened.
The result stays labeled **SAVED report data**, including its counts, overlap
classifications and page status. These are recorded claims, not a fresh comparison
or revalidation of original records. Multiple sources do not establish independent
reviewers; a synthetic alternative is still synthetic. No winners are chosen.

Saved input must match the existing unversioned
`record-review-return-analysis` producer shape: working filename/count, ordered
sources with ordinals/counts/issues, and ordered overlaps with status and complete
proposals. The shared analysis owner validates the entire structure, required and
allowed fields, types, decision/status vocabulary, count/issue summaries, source
references and proposal ordering before the page accepts it. It does not recompute
saved classifications or claim the report is authentic. There is no new format
version. Strings and array order are retained unchanged, including empty notes,
Unicode, CR/CRLF, markup-like text, duplicate filenames and prototype-like IDs.
The same literal renderer, filters and 10-overlap pages serve both workflows.
Saved-report mode remains a reader only: no download or re-export action, even
after switching from a completed fresh analysis.

**Search overlap IDs and proposal notes** accepts one literal, case-insensitive
substring. It matches an overlap ID or any of its proposal notes, then intersects
with **All**, **Disagreements**, or **Identical** before the existing ten-row
paging. Only case is folded: spaces, punctuation, Unicode and markup-like text
are literal, with no trimming, normalization, regex or query language. An empty
query includes all overlaps allowed by the status filter. All proposals in a
matching overlap retain their original values and source order, not just the
matching note. Changing the query or using **Clear search** returns to page one;
Clear search keeps the status filter and returns focus to the search input.
Matching/whole-report totals and no-match feedback reflect the combined view.

Lookup is view-only in the existing report/render owner: it does not reread files,
reanalyze, revalidate, mutate the accepted report or change source readiness. The
working summary, source counts and issues remain whole-report information outside
the overlap lookup. SAVED labels remain recorded claims. A FRESH download still
exports the entire accepted report when the query matches one row or none; SAVED
mode remains non-exportable. Every existing source-file, workflow and new-analysis
(or saved reread) invalidation clears the query and page with the prior result.
There is no extra index/cache, persistence, dependency or production test API.

1. Choose one complete version-1 working review file.
2. Add one or more complete returned review files. Each selection appends to the
   visible ordered list. **Move up**, **Move down**, and **Remove** are keyboard
   buttons; source numbers always follow this list. Duplicate filenames and
   repeated files remain separate sources. Source count is not reviewer count:
   a synthetic variant must not be treated as an independent reviewer.
3. Click **Analyze** explicitly. The page reads and validates every complete
   snapshot, including reviews on conflicting and unknown records. Errors are
   visible; there is no partial accepted analysis.
4. Inspect each source's total, eligible, unchanged, changed-record-conflict and
   unknown-ID counts and its complete issue list. Overlapping proposals require
   at least two eligible or unchanged proposals. **All**, **Disagreements**, and
   **Identical** filter these overlaps without changing their order. Pagination
   shows at most 10 overlaps per page, with matching/total counts and disabled
   bounds. Every proposal on the page is shown in full, in source order.
5. Once the current **FRESH** analysis succeeds, **Download analysis report**
   appears beside Analyze. It requests `record-review-return-analysis.json`,
   containing the entire accepted report, not just the current filter or page.
   Hand the actual downloaded JSON to the recipient; they can open it with
   **View saved report**, without your original snapshots.

The explicit download serializes the existing report exactly as the CLI does:
`JSON.stringify(report, null, 2) + "\n"` (UTF-8 JSON, two-space indentation and a
trailing newline). It preserves all report values, field/source/proposal order
and literal strings, with no new fields or version. It does not reread files,
reanalyze snapshots, choose winners or apply reviews. This report contains
filenames, IDs and proposal notes: share it only with the intended recipient.

Readiness and download guidance are visible status messages. A download request
is **not confirmation of a saved file**; check your browser downloads before
handoff. An embedded preview may silently block downloads. If needed, open the
self-contained HTML directly and analyze the chosen files there. Browser filename
collision/overwrite behavior is not asserted; the CLI's exclusive-new-file guarantee
does not extend to browser downloads. No clipboard fallback or permission is added.

Filenames, IDs and notes render as literal text, including whitespace and
markup-like content. Empty notes have a separate label; **Exact note string
(JSON escapes)** makes otherwise invisible CR/LF, tabs and trailing spaces
inspectable. The primary notes retain their exact text. Record order comes from
the working snapshot. Equality is exact, not trimmed or normalized.

In **Analyze input files**, adding, replacing, reordering or removing any working
or returned input invalidates prior results and download readiness immediately;
click Analyze again. Starting a new analysis also removes the download action
while reads are pending. Failed or stale analysis cannot offer an earlier report.
Older asynchronous read successes and failures cannot replace newer choices or
results or unlock a newer pending download. Download readiness uses the existing
report/revision/workflow owner, not a separate export state. The page has no
persistence, network submission, clipboard access or apply action. Reloading
starts empty. It never loads the Record Desk editing app.

Replacing or removing a saved report, rereading it, or switching workflow also
clears the prior result immediately. A failed read or invalid report leaves no
partial or stale result. Late successes and failures cannot overwrite newer
choices, labels or errors, or unlock a newer pending read. Switching workflows
keeps file choices only in page memory; results must be explicitly loaded again.

### Shared analysis and checks

The real CLI, **review-return-analysis.js**, retains its arguments, diagnostics,
exclusive new-file output, report schema and serialization. It and the browser
adapter **review-analysis-app.js** both call the pure **review-analysis.js** owner.
The owner delegates complete version-1 validation and record comparison to
**review-state.js**; the adapters do not duplicate classification policy.
Its **parseReportJSON** boundary accepts saved analysis text without calling
snapshot analysis. Both entry points feed the same adapter state and renderer.

Focused analysis/download and saved-viewer checks (ordinary Node only, no CLI
replay or browser):

~~~sh
node --test review-analysis.test.js review-analysis-app.test.js
node build-review.js --check
~~~

These cover producer-output compatibility using synthetic in-memory inputs,
invalid report rejection, literal fields, saved/fresh labels, workflow changes,
filters/paging, and asynchronous success/failure races across both workflows.
The actual source and generated-page handlers also exercise FRESH-only readiness,
every input invalidation, pending/late success/error behavior, saved-mode exclusion,
whole-report Blob bytes, repeat requests and link/object-URL cleanup. Lookup checks
exercise the same renderer and handlers in source and generated-page form: literal
ID/note matching, status intersection before paging, later-page reset/clear,
unchanged values/order/whole-source summaries, invalidation and full FRESH download
bytes for one/zero matches with saved exclusion. No production
test API is added. These are not proof of native file selection, a saved download,
keyboard dispatch or layout; those remain client acceptance work in the retained
approved browser. The decisive handoff uses the real chosen snapshots, captures
the actual downloaded file and opens that exact file in the immutable recipient
saved viewer, comparing every value with the retained report oracle. Do not
substitute a fabricated report or serializer-only test for that acceptance. Keep
private inputs, reports, command receipts and media outside Git. Reuse unchanged
producer and fresh-mode proof; the actual retained browser reports are saved-view
inputs, not replacement oracles or peer exports to regenerate. Focus new client
acceptance on lookup and whole-report downloads for one/zero query matches using
the retained original snapshots. For this download/lookup contribution, do not
launch a native browser, enable optional browser/sandbox switches, export
histories/transcripts, or replay the unchanged CLI producer; reuse its existing
valid proof.

The existing standard build now produces both self-contained pages:

~~~sh
node build-review.js
node build-review.js --check
~~~

The existing `build()` API and unaffected **index.html** output are preserved;
`build("analysis")` supplies the separate analysis page. No dependencies or
package scripts are added. For this contribution, use the focused checks above
and the unchanged canonical owner checks without replaying either terminal adapter:

~~~sh
node --test review-state.test.js
~~~

The new adapter harness executes the actual source and bundled scripts with
controlled asynchronous file reads and forbidden side-effect guards. It covers
invalidation, stale success/error races, literal values, source controls/focus,
complete proposals, filtering/paging and empty states. Existing child-process CLI
proof covers shared-owner delegation and exact report output; it is not replayed
for this unchanged producer. These checks do
not claim native Files, layout or visual proof; those require a separately
approved browser review. Do not set the optional browser-test switches for a
source-only check.
