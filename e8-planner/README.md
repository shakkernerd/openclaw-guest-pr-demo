# Community repair cafe shift planner

A small, offline command-line planner using **only built-in Node.js libraries**.
Requires Node.js 22 or newer. No install, package manager, network access, or
third-party dependencies. All planner code, tests, and examples live here; the
existing parcel-label project is unchanged.

## Try the Saturday example

From the repository root:

~~~sh
node e8-planner/cli.js --help
node e8-planner/cli.js \
  --volunteers e8-planner/sample/volunteers.csv \
  --shifts e8-planner/sample/shifts.csv \
  --out-dir e8-planner/output
~~~

This prints the report and writes:

- **e8-planner/output/assignments.csv**: one row per assigned volunteer/shift.
- **e8-planner/output/report.txt**: coverage of every shift, each uncovered slot's
  blockers, and every volunteer's total assigned hours (including unused people).

The fictional sample is **Saturday, 31 October 2026, 09:00–14:00, UTC (+00:00)**:
8 volunteers, 14 overlapping or adjacent shifts, and 16 requested person-slots.
It covers intake/setup, bicycles, electronics, textiles, refreshments, and close.
It deliberately includes staffing shortages: **12 slots filled, 4 uncovered**.
See the checked-in [sample assignments](sample-output/assignments.csv) and
[sample report](sample-output/report.txt) without running anything. Tests compare
these files against the allocator so they cannot silently drift.

**Outputs are never overwritten**, even if they are symlinks or inputs. On a
repeat run, choose a new output directory or move the two old output files first.
The output/ directory is ignored by Git; the inspectable sample-output/ is not.

## CLI

~~~text
node e8-planner/cli.js [options]

--volunteers FILE  Default: ./volunteers.csv
--shifts FILE      Default: ./shifts.csv
--out-dir DIR      Default: ./planner-output
--require-full     Exit 2 if coverage is incomplete; still produce both outputs
-h, --help        Show help without reading inputs
~~~

Paths are relative to the **current working directory**, not the script's folder.
Quote paths containing spaces. Unknown flags, positional arguments, missing
values, invalid input, and file errors fail with a diagnostic on stderr.

Exit codes:

- **0**: valid plan written (gaps are allowed by default).
- **1**: usage, validation, or I/O failure; do not treat this as a new plan.
- **2**: valid plan written with gaps when --require-full is enabled.

For a strict sample check, use a **fresh numbered output directory** (strict-001
below; use strict-002, strict-003, etc. for subsequent runs):

~~~sh
node e8-planner/cli.js \
  --volunteers e8-planner/sample/volunteers.csv \
  --shifts e8-planner/sample/shifts.csv \
  --out-dir e8-planner/output/strict-001 \
  --require-full
~~~

The sample intentionally exits **2** here. That is a coverage warning, not a
validation failure. The report is printed to stdout only after writing the files.

## CSV input contract

> **ONE RECORD PER PERSON: the coordinator must deduplicate the roster before
> running the planner.** Name case variants and aliases count as separate input
> people: Alice Chen, alice chen, and A. Chen are not automatically linked or
> merged. If they describe one human, multiple rows can double-book that human
> or bypass their real hour limit. Keep one consistent name and one row per
> person; do not use aliases to represent separate availability windows.
> Exact duplicate names after trimming are rejected, but that is not identity
> deduplication. The name-based identity schema is unchanged.

Both files must be UTF-8, with these exact column names (column order may vary):

**volunteers.csv**

~~~csv
name,skills,available_from,available_to,max_hours
Mei Chen,electronics;textiles,2026-10-31T09:00:00+00:00,2026-10-31T14:00:00+00:00,3.5
~~~

- **name**: unique, nonempty volunteer identifier. Use distinct names for different
  people who are namesakes, but never multiple names for the same person.
- **skills**: one or more nonempty, unique skill names, separated by **semicolons**.
- **available_from**, **available_to**: one continuous window, end after start.
- **max_hours**: nonnegative decimal, up to 3 decimal places (e.g. 0, 2, 3.5,
  1.001). Zero is allowed. No exponent notation, signs, or nonfinite numbers.
  This budget applies to **all shifts in the file**, not separately to each day.

**shifts.csv**

~~~csv
id,starts_at,ends_at,skill,people_needed
repair-am,2026-10-31T09:30:00+00:00,2026-10-31T11:30:00+00:00,electronics,2
~~~

- **id**: unique, nonempty shift identifier.
- **starts_at**, **ends_at**: positive-duration whole shift.
- **skill**: exactly one skill name; semicolons are not allowed here.
- **people_needed**: positive integer. Counts and their sum must be safe integers;
  hour budgets must be representable as safe integer milliseconds.

Names, IDs, and skills are **case-sensitive**, with surrounding whitespace
trimmed. Electronics does not match electronics. A skill absent from the roster
is valid and produces a coverage gap, not an input error. Missing, duplicate, or
unexpected headers, duplicate IDs/names, duplicate skills, blank required fields,
and wrong row lengths fail validation. Diagnostics identify the file and physical
line where applicable; fix the first error and rerun.

CSV supports a UTF-8 BOM, LF or CRLF, quoted commas, and doubled double-quotes:
~~~csv
"Chen, ""Mei"""
~~~
Truly blank lines are ignored; comma-only rows are not. The CSV reader understands
quoted newlines, but **all input fields must be single-line and contain no control
characters**. Do not put spaces outside closing CSV quotes. Header-only files are
valid empty rosters/schedules; a file without its header is not.

### Explicit times, not machine-local time

Use YYYY-MM-DDTHH:mm[:ss[.SSS]] followed by **Z or ±HH:MM**.
Z explicitly means UTC. Fractional seconds may have 1–3 digits, only after
seconds. Years are 0001–9999; offsets are limited to ±14:00. Unknown offset
-00:00, bare dates, local timestamps, impossible dates (including invalid leap
days), 24:00, and leap seconds are rejected rather than normalized.

All scheduling uses absolute instants and elapsed milliseconds; input offsets
are preserved in output. For example 10:00+01:00 equals 09:00Z. The machine's
timezone and locale do not affect the plan. Offsets alone do not identify a time
zone: **you supply the correct offsets**, including daylight-saving changes.
A shift across an offset change consumes its actual elapsed hours.

## Allocation rule and safety constraints

1. Sort shifts by start instant, then end instant, then ID.
2. For each shift, consider volunteers with the exact required skill, availability
   covering the entire shift, enough unused hour budget, and no overlapping
   assigned shift.
3. Rank eligible volunteers by **fewest listed skills**, then **least time already
   assigned**, then **name**. Take up to people_needed distinct volunteers.
4. Never revisit earlier decisions. Record why every volunteer was blocked if
   slots remain unfilled.

Text ties use JavaScript code-unit ordering, not locale-dependent collation.
Reordering input rows does not change assignments or report bytes. Sorting by
fewest skills modestly preserves multi-skilled volunteers for other roles;
workload balancing only breaks ties within the same skill-count group.

Intervals are half-open: **[start, end)**. A volunteer can finish one shift at
11:00 and start another at 11:00. No partial shifts, duplicate person-slots, work
outside availability, overlaps, or hour-budget overruns are allowed. Time
accounting is integer milliseconds; report hours are rounded to at most 9 decimals.

### What it does **not** promise

This is a transparent greedy rule, **not an optimizer**. It does not maximize
coverage, hours, or fairness. A name tie can choose a flexible volunteer early
and leave a later shift empty, even when another arrangement would cover both.
For example, with Alice available 09:00–11:00 and Ben only 09:00–10:00, each with
one hour of budget and the same skill, Alice wins the 09:00 shift by name and the
10:00 shift remains empty. Assigning Ben first would have filled both.

Uncovered-slot explanations describe the state **when the shift was processed**,
not a proof that no feasible solution exists. Already-assigned volunteers cannot
fill an extra slot. For matching-skill candidates, all applicable availability,
overlap, and budget blockers are listed; others are marked as missing the skill.
Remaining hours are explicitly the **amount at allocation time**, not final unused
hours after later shifts have been assigned.

**A change to solve one gap can move another. Review the whole rerun**, including
all assignments, gaps, and volunteer totals, rather than only the target shift.

There are no breaks/travel buffers, multiple availability windows, partial
coverage, skill proficiency or safety certification checks, preferences,
per-day budgets, or shift priorities. Adding unrelated skills can change ranking.
The tool reads the files into memory and is intended for small community rosters,
not large workforce scheduling. A coordinator must review the result, safety
qualifications, and rest arrangements before using it. Split availability around
breaks is not supported; adjust the inputs or plan manually where necessary.

## Output and file safety

assignments.csv columns:

~~~csv
shift_id,volunteer,starts_at,ends_at,skill
~~~

Only filled person-slots appear; there are no fake empty assignments. Use
report.txt for gaps and volunteer totals. Its opening **gap summary** shows each
uncovered shift's explicit start/end times, elapsed duration, missing slots, and
only matching-skill candidates' blockers (or an explicit no-match message). The
full shift coverage and detailed explanations for every volunteer remain below.
CSV values are quoted/escaped without
changing identifiers. **Import CSV columns as text in spreadsheet software**:
untrusted values beginning with formula characters are not neutralized.

Validation and allocation finish before output paths are touched. Output names
are reserved exclusively, using owner-only file permissions where supported.
Existing files are never replaced. If reserving or writing the pair fails, the
CLI attempts to remove only its own newly created files; an empty output directory
may remain. Use an output directory controlled by the coordinator, and do not
replace output paths concurrently while the CLI runs: cleanup assumes those
paths still refer to this run's files. This is not a two-file transaction across
power loss: on a crash,
inspect/move partial output and rerun into a fresh directory. Treat volunteer
names/availability as private; share only with the intended cafe coordinators.

## Tests and inspection

From the repository root:

~~~sh
node --test                              # planner + untouched parcel-label tests
node --test e8-planner/test/*.test.js     # planner only (shell expands the glob)
git diff --check
git diff --cached --check
~~~

Tests use node:test and node:assert/strict. They cover CSV and schema errors,
calendar/offset validation, exact budgets, adjacency and overlap, deterministic
ties, all gap reasons, greedy limitations, 100 seeded constraint scenarios, sample
output regression, real CLI subprocesses, error/exit codes, timezone independence,
UTF-8 rejection, input protection, symlink collisions, and output rollback.
Temporary test files are cleaned up. No external tools or fixtures are downloaded.

For review, start with this guide, then input.js (validation), planner.js
(allocation/report), cli.js (I/O), and csv.js (CSV grammar). See test/,
sample/, sample-output/, and [CHECKS.md](CHECKS.md) for reproducible evidence.
The requested tiny custom implementation uses built-in node:util.parseArgs
rather than a CLI framework; a dedicated strict CSV reader avoids a dependency.
The allocate() function expects records already validated by input.js.
