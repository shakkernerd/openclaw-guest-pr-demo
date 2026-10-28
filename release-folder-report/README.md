# release-folder-report

Dependency-free Node.js **22+** batch review of received release folders. Uses
**the unchanged ../directory-manifest library**, not a second inventory engine
or subprocess per folder. Nothing to install; no services, network, repair,
configuration changes, or baseline regeneration.

## Files to hand off

Keep these sibling directories together, with their relative layout unchanged:

- directory-manifest: its unchanged source, package.json and README.md.
- release-folder-report: index.js, io.js, cli.js, package.json and this README.
- Include release-folder-report/test/ to run the focused checks.
- For the optional source-copy demonstration, include exercise.js **and
  release-folder-report/test/helpers.js**: the exercise imports that helper even
  when you are not running tests. Including all of test/ also satisfies this
  prerequisite. Include the manifest package's tests too if you want its full suite.

The runtime uses only Node built-ins and the sibling manifest library. The tests
and optional exercise use real source/docs from those two directories; no other
repository files, generated reports or local verification notes are required.

## Run

From the repository root (or use an absolute CLI path):

    node release-folder-report/cli.js received.json --out ./review-001
    node release-folder-report/cli.js received.json --out ./review-002
    node release-folder-report/cli.js --help

The output name is required and deliberate. Its parent must already exist.
**Every run needs a new directory**, even when the previous review found errors
or was cancelled. No force, overwrite, append, resume, or delete option exists.
Use -- to end options for an input filename beginning with a dash:

    node release-folder-report/cli.js --out ./review-003 -- -received.json

### Input format, version 1

Save UTF-8 JSON (without a BOM), with exactly these top-level fields:

    {
      "version": 1,
      "folders": [
        { "name": "Client café 世界", "root": "received/Client café 世界" },
        {
          "name": "Partner release",
          "root": "received/Partner release",
          "manifest": "baselines/partner.json"
        }
      ]
    }

- folders is a nonempty array, processed in its given order, one folder at a time.
- Each row has exactly name, root, and optionally manifest. Names must be unique,
  nonblank strings. Paths must be nonempty native path strings. NUL and unpaired
  Unicode surrogates are rejected. Spaces and Unicode are preserved; names are
  case-sensitive and are not normalized or used as output filenames.
- Both relative root and **explicit manifest paths are relative to the input
  list's directory**, NOT the working directory and NOT the root. Absolute paths
  are accepted. Without manifest, use ROOT/.directory-manifest.json.
- Output paths are relative to the **working directory**. A relative input-list
  path is also resolved from the working directory; a parent-directory alias
  does not change its logical relative-path base.
- Bad rows are independent errors, including non-objects, unknown fields, missing
  paths and wrong types. **All occurrences** of a duplicate name are errors;
  unrelated rows still run. The report retains each original input value and
  its one-based index so even malformed/duplicate rows can be identified.
- An unreadable/invalid JSON list, unsupported top-level version, empty list or
  wrong top-level shape is a whole-run input error: no trustworthy batch exists,
  so no report directory is created. Duplicate JSON *object keys* use Node's
  JSON.parse last-key-wins behavior; don't use them.
- Input list and baseline must be regular files, not final symlinks, directories,
  FIFOs or devices. UTF-8 decoding is strict. Explicitly selected parent-directory
  aliases are resolved by the OS, including baseline parent aliases. This wrapper
  does not duplicate the directory-manifest CLI's special in-tree baseline-parent
  restriction. It uses only that package's public library; inventory symlinks
  themselves are never followed. A final root symlink is an inspection error.
- Trust the saved baselines and their exact exclusions. The utility does not
  rewrite them, relocate them, guess exclusions or create a fresh baseline.

## Receiving-coordinator workflow

1. Retain the received folders and their saved baselines as delivered. Obtain a
   trusted baseline from the sender if it is missing; do not create a new baseline
   from a possibly damaged received folder just to make verification pass.
2. Write a new input list using the format above. For a nested saved baseline,
   explicitly set manifest (for example received/Client/metadata/baseline.json).
   Keep the list and report destinations outside all inspected folders.
3. Ensure the output parent exists, then run the CLI with an unused output name.
   Keep stdout's delivery acknowledgment and inspect the exit status: differences
   or inspection errors can still have a successfully delivered pair of reports.
4. Read **Attention needed** first. Content differences need review against the
   sender's intent. Unchecked/skipped folders need a successful later inspection;
   neither is a match. Follow the detailed table and per-entry evidence as needed.
   **A matching manifest is not release approval** or proof of baseline authenticity.
5. For a late arrival, keep earlier paths and reports untouched. Make an independent
   copy at a new path (not hard links), including empty directories and the saved
   baseline at its original relative location. Put that path in a new list and
   deliver into a new report directory. Compare checked counts and per-folder
   outcomes, not just totals: new coverage is not a repaired historical report.
6. Forward report.md, report.json and COMPLETE.json together. Validate the receipt
   as described below. Keep earlier partial/error reports for the audit trail.

## Reports and coverage

Every requested row appears, including errors and skipped rows:

| Status | Attempted | Checked | Meaning |
| --- | --- | --- | --- |
| match | true | true | Library completed; no differences. |
| different | true | true | Library completed; ordinary content/structure differences. |
| error (input) | false | false | Invalid row; no filesystem inspection attempted. |
| error (baseline/inspection) | true | false | Read/parse/scan failed; no complete comparison. |
| skipped | false | false | Cancellation prevented this row from starting. |

"Attempted" means filesystem inspection for that row began; "checked" means
verifyManifest returned a full comparison. A baseline can be read successfully
but the root scan still fail. Error rows have **null counts and null result**,
not reassuring zeroes. Partial inventories from a failed scan are never reported
as a content diff. The JSON error includes stage, native error code when present,
and message (no stack). Errors do not stop later rows.

Markdown begins with coverage and an **Attention needed** section, before the
detailed table. It separates content differences (per-folder entry counts) from
folders that could not be checked or were skipped (stage/code and concise reason).
Both groups retain input order within the group; the detailed table retains the
full input order. Incomplete coverage is explicit, including an all-skipped run.
No differences reported from completed checks is not an all-clear for unchecked
folders. A match is a baseline comparison, never release approval.

The detailed evidence still includes resolved paths, full errors, and every
changed/missing/extra path. Attention reasons longer than 160 Unicode characters
are abbreviated with an ellipsis; the detail and JSON retain the full text.
Changed files show size and/or SHA-256 reasons (including same-size edits), type
changes show both types, and symlink changes show old/new target text.

Names, paths and error text use **Markdown code spans, not HTML tags or entities**.
Inside each span the value is JSON-quoted; backticks, table pipes, HTML
metacharacters and Unicode line separators use JSON Unicode escapes (for example
\u0060, \u007c and \u003c). This keeps raw-HTML-literal viewers readable without
letting supplied text create links, images, markup or extra table cells. Ordinary
spaces and Unicode remain readable. JSON retains the exact original values;
the quoted code-span text also decodes losslessly with JSON.parse.
The attention section is presentation only: it adds no JSON fields and does not
change input order, library results, coverage calculation or exit statuses.

JSON report version 1 contains:

- runId, source, startedAt, finishedAt: identity, absolute input list and UTC times.
- state: completed (all rows considered, possibly with errors) or cancelled.
- coverage: complete only if **all requested folders were checked**; otherwise
  partial. This is independent of whether delivery succeeded.
- cancellation: null or {reason, exitCode}.
- summary: requested, attempted, checked, matched, different, errors, skipped,
  plus entries: {changed, missing, extra} across **completed checks only**.
- folders: input-order rows with index, name, original input, absolute root and
  manifest (or null for invalid path values), status, attempted, checked,
  startedAt/finishedAt, counts, result, error and skipReason. Unstarted timestamps
  are null. Checked results are the library's **unchanged {ok, changes} objects**,
  including full expected/actual entries, sizes and digests.
- exitCode: the review's status, excluding a later delivery failure or signal.

Counts are entries, not bytes or individual reasons. Empty directories count.
A missing directory and its descendants count separately. A file differing in
both size and hash counts once. Input order and library path order are stable;
run IDs and timestamps intentionally differ between invocations.

### Cancellation

SIGINT (Ctrl-C) and SIGTERM request **cooperative cancellation**. Because the
unchanged library has no AbortSignal API, the active comparison runs to completion
(or its normal error); subsequent rows become skipped. Earlier results survive,
and the normal new-directory delivery is attempted even on cancellation. A
signal received before the first check produces an all-skipped report, after
reading/validating the input list. A signal after the last check can produce a
cancelled run with complete coverage; coverage is factual, not inferred from
exit status. Repeated signals do not force termination.

A signal during delivery cannot retroactively change the finalized review
snapshot: the files still describe the completed review and the CLI exits with
the signal status. Delivery failures take precedence. SIGKILL, process crashes,
OS shutdown and a blocked filesystem call cannot be handled gracefully. There
is no periodic checkpoint and no promise of bounded cancellation latency.

## Explicit, non-overwriting delivery

A successful delivery creates exactly these files inside the requested NEW
output directory:

- report.md — consolidated human-readable report.
- report.json — full machine-readable report.
- COMPLETE.json — receipt written **last**, with version, matching runId and
  SHA-256/byte lengths for both files.

The output directory is exclusively reserved with non-recursive mkdir. Existing
files, directories, symlinks and dangling symlinks are all refused; two processes
racing for one name cannot both reserve it. Each file uses exclusive creation.
Output inside a configured root, at/above an input, or through a resolvable alias
into one is rejected. The location checks also consider missing roots and
baselines to avoid creating a supposedly missing input as part of reporting.
Use a sibling output directory outside all inspected trees. Unresolvable cyclic,
inaccessible or invalid input paths retain lexical overlap checks but do not veto
a safe delivery elsewhere; those paths could not be inspected. Unexpected storage
failures during location checking fail delivery conservatively.

**Only a valid, parseable receipt whose runId, byte lengths and hashes match both
files proves a complete delivery.** The receipt means both reports were written,
not that every folder matched or was checked. A cancelled/error review can be
fully delivered. A failure can leave a new partial directory/files; nothing is
removed, replaced or silently reused. Preserve that evidence, fix the cause,
and select a new output name. A truncated receipt is not a valid completion.
This is not an atomic multi-file transaction, nor an fsync/power-loss durability
guarantee. The checksums detect damage; they are not signatures/authentication.

On delivered results, stdout is **one JSON acknowledgment** with delivered,
directory, runId, reviewExitCode, commandExitCode, signalDuringDelivery and files,
even for review exits 1/2/130/143. signalDuringDelivery explicitly identifies a
late signal after the review snapshot was finalized (otherwise null).
Progress and a coverage summary go to stderr. Parse report.json for results;
stdout is not the report. On input/usage/delivery failure, stdout is empty and
stderr explains the failure. On delivery failure, completed results have not
been erased from the inputs: retry into a new path; any already-written report
files remain, but there is no fallback publication elsewhere.

## Exit statuses

| Code | Meaning |
| --- | --- |
| 0 | Every folder checked and matched, or --help. |
| 1 | At least one ordinary difference, no inspection/input errors. |
| 2 | Any row error, invalid list/CLI use, or report delivery failure. |
| 130 | SIGINT cancellation with successful delivery. |
| 143 | SIGTERM cancellation with successful delivery. |

Precedence: **delivery failure (2) > cancellation (130/143) > errors (2) >
differences (1) > all match (0)**. Invalid top-level input has no deliverable
batch and exits 2. Do not assume exit 2 means no report was written: consult the
acknowledgment and receipt. The exercise script below exits 0 when its assertions
pass, even though its intentionally mixed child review correctly exits 2.

## API (no writes until deliver)

    const { review, markdown, deliver } = require('./release-folder-report');
    const controller = new AbortController();
    const report = await review('received.json', {
      signal: controller.signal, // optional AbortSignal
      onProgress: (event) => console.error(event), // optional, may be async
    });
    const text = markdown(report);
    const directory = await deliver(report, './review-004');

Pass the returned report unchanged to markdown/deliver; these are not arbitrary
JSON-validation APIs. review rejects for whole-list failures; row errors are
returned. A throwing progress callback is a caller error and rejects the review,
not a folder inspection error. The callback receives checking and finished events;
skipped rows emit neither. Cancellation already requested at a checking event
still allows that active row to finish. deliver rejects on unsafe/existing paths
or write failures and never modifies input files.

## Real-source exercise and checks

    node release-folder-report/exercise.js /tmp/my-new-release-review
    node --test release-folder-report/test/*.test.js
    npm --prefix release-folder-report test
    node --test

The exercise requires a **new** destination with an existing parent and retains
all its artifacts. It copies real directory-manifest source, package metadata,
README (also copied under a Unicode documentation filename); adds empty directories and names with
spaces/Unicode; saves a nested baseline; then makes independent intact and
intentionally damaged copies. It creates an intact-only report, a mixed report
(with a genuine nonexistent-root error placed before the damaged folder), and
attempts a refused repeat delivery. It verifies both receipts and compares
content hashes, modes, inode identities, sizes, mtime and ctime for originals,
inspected inputs and both previous reports. It reverifies the intact trees and
saves evidence.json. Only the separate damage fixture is altered deliberately.

Tests use the built-in Node test runner, real files and child Node CLI processes.
They cover validation/isolation, baseline errors, defaults and path bases,
Unicode/empty directories, library-result identity, reasons/escaping, preservation,
output overlap/alias refusal, exclusive concurrent delivery, signals, and a real
FIFO via installed mkfifo on POSIX. A storage failure after the first report is
written is **injected with node:test mocks**, not claimed as a real full-disk test.
Test-only temporary fixtures are cleaned up; the explicit exercise is never
cleaned up. Always select a fresh destination to repeat the exercise. Tests also
cover the HTML-free attention summary, lossless escaping, cancellation/partial
coverage, and rendering without changing the JSON evidence. No pre-generated
reports are needed to run these checks.

## Scope and limits

Contents, modes and modification times are not intentionally changed by review.
Reading may update access times under OS policy; no portable guarantee prevents
that. Creation changes only the new report directory and its parent metadata.
Use quiescent inputs and output parents: the unchanged library detects many
common changes, but neither it nor this wrapper provides an atomic snapshot or
a security boundary against hostile ancestor-directory replacement races.
Portable Node lacks descriptor-relative traversal. Report path checks are also
subject to these races. Do not run against concurrently modified adversarial
trees or assume they are isolated from external writers.

Permissions, ownership and timestamps are not baseline content comparisons.
Manifest exclusions and symlink rules are those of directory-manifest. Baseline
JSON, inventories, changes and reports are held in memory; there is no streaming
report format, cache, concurrency pool, signature service or restore engine.
Platform path/case/Unicode restrictions still apply. Native signal behavior,
permissions and filesystem semantics differ across operating systems.
