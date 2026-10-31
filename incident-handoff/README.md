# Offline incident handoff

Turn a fictional JSON incident snapshot into a deterministic Markdown handoff
using only Python's standard library. No packages, network access, services,
notifications or real incident actions are involved.

## Quick start

Use an existing Python 3 installation; verification used Python 3.11.2. Run these
commands from the repository root. The scripts and bundled fictional
inputs/incidents.json are sufficient; no pre-generated handoffs are needed.
Create the local output directory first, then choose **new output filenames**:

    python3 -B -c "from pathlib import Path; Path('incident-handoff/examples').mkdir(exist_ok=True)"
    python3 -B incident-handoff/handoff.py incident-handoff/inputs/incidents.json incident-handoff/examples/handoff.md
    python3 -B incident-handoff/handoff.py incident-handoff/inputs/incidents.json incident-handoff/examples/api-handoff.md --service api
    python3 -B incident-handoff/handoff.py incident-handoff/inputs/incidents.json incident-handoff/examples/all-handoff.md --include-resolved
    python3 -B incident-handoff/handoff.py incident-handoff/inputs/incidents.json incident-handoff/examples/worker-handoff.md --service worker --include-resolved
    python3 -B incident-handoff/handoff.py --help

An output's parent directory must already exist. Existing files, directories and
symlinks are refused, including using the input itself as the output. There is
no overwrite option. Repeating a command requires a new output filename.
Exit 0 means success (or help); exit 2 means an error, with details on stderr
and no success message on stdout.

## Selection and output

- Default: include open and monitoring incidents, exclude resolved incidents.
  --include-resolved includes all three statuses.
- --service matches the entire service string, case-sensitively, without
  trimming or prefix matching. API does not match api. No matches produces a
  successful, explicitly empty handoff with zero counts.
- Groups sort by exact service name; rows sort by high, medium, low severity,
  then exact incident ID. Strings use Unicode code-point order, not locale or
  natural numeric order: INC-10 precedes INC-2 at equal severity. Status is not
  an ordering key, and no timestamp is added.
- The handoff includes total incident/service counts, overall and per-service
  status counts, and each selected identifier, severity, status, owner and summary.
- Missing owner becomes (not provided); null becomes (explicitly unassigned);
  the empty string becomes (blank owner). Other strings are retained, including
  whitespace-only strings. Values are not trimmed or normalized. Markdown/HTML
  metacharacters are escaped; line feeds become HTML line breaks. A renderer may
  visually collapse repeated spaces, while the Markdown source retains them.

Expected counts for the bundled fictional input:

| Options | Incidents |
| --- | --- |
| none | 3 |
| --service api | 2 |
| --include-resolved | 4 |
| --service worker --include-resolved | 2 |
| --service API | 0 |

The default incident order is INC-007, INC-105, INC-042. Including resolved
incidents places INC-200 before INC-042 within the worker group.

## Input and validation

Supply a UTF-8 JSON object with an incidents array. Each incident needs nonblank
string id, service, severity, status and summary fields. Severity must be exactly
high/medium/low; status exactly open/monitoring/resolved. Owner may be absent,
null or any string, but not a number, boolean, array or object. Extra metadata
is accepted and ignored. An empty incidents array is valid.

Every record is validated **before filtering or creating output**. Duplicate IDs
are rejected across the entire input, even across services or excluded resolved
records. Malformed JSON, duplicate object keys, nonstandard numbers such as NaN,
invalid UTF-8 and invalid Unicode surrogates in displayed fields are rejected.
Errors identify a record/field or JSON line/column where available. Invalid input
creates no handoff and does not modify an existing output or the input.

## Tests

    python3 -B incident-handoff/test_handoff.py

No external test runner is needed. The test script reads the bundled fixture,
creates checks/ if absent, and launches the real CLI in subprocesses. Every run
gets a new checks/run-* directory; fixtures, outputs and command transcripts are
retained without replacing earlier runs. Tests cover filters, stable ordering,
owner states, counts, malformed and duplicate records, Markdown escaping,
input/output preservation, symlinks and competing output creators. The local
checks/ and examples/ directories are ignored by Git; they need not exist in
a clean checkout.

## Verification and limits

The previously completed Python 3.11.2 regression run passed all 25 tests,
covering 72 real CLI invocations. Five additional example runs produced the
counts above. The source, test script and fixture have not changed since that
verification; the documentation preparation did not rerun the CLI suite.

Verification covers one local runtime/filesystem, not cross-platform or remote
filesystem certification. The tests require permission to create symlinks.
Crash and disk-full behavior were not fault-injected. Exclusive output creation
prevents overwrites but is not crash-atomic: interruption or I/O failure after
creation can leave a partial new file. The tool does not delete it; inspect it
and choose another filename before retrying. Input is loaded into memory, so
this is a small offline utility rather than a streaming or production incident
management system.
