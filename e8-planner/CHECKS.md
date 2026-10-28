# Verification notes

Checked with Node.js **v24.22.1**, using only built-in libraries.

## Executed checks

- `node --test`: **85 passed, 0 failed** (82 planner tests and all 3 existing parcel-label tests).
- `node --test e8-planner/test/cli.test.js e8-planner/test/input.test.js e8-planner/test/planner.test.js`: **82 passed, 0 failed**.
- `node --check` on each of `cli.js`, `csv.js`, `input.js`, and `planner.js`: passed.
- `git diff --check` and `git diff --cached --check`: passed. The staged change list contains only 14 new files under `e8-planner/`.
- `node e8-planner/cli.js --help`: passed; documents paths, output safety, and exit codes.
- Real sample CLI run: exit **0**, generated `sample-output/assignments.csv` and `sample-output/report.txt`.
- Real sample CLI with `--require-full`, writing to `output/strict`: expected exit **2**; both files produced.
- `cmp` of each strict-run output against its checked-in sample counterpart: byte-identical.
- 100 fixed-seed generated scheduling scenarios within the test suite: no skill, availability, overlap, duplicate-slot, or hour-budget violations; reversing input order leaves both outputs unchanged.
- CLI subprocess tests compare different timezones/locales, malformed inputs, missing files, existing output collisions, symlink/input protection, and rollback when the second output cannot be reserved.
- A fault-injected second output-write failure verifies removal of both newly created files, closed descriptors, preserved inputs, and the original error diagnostic.
- Header regression tests reject quoted LF/CRLF and trailing tabs before trimming.

Sample: **8 volunteers, 14 Saturday shifts, 16 person-slots, 12 filled, 4 uncovered**.
The report explains the four gaps; they are intentional, not failing tests.

## Scope preservation

The initial repository was clean. All new project files are under `e8-planner/`.
All seven pre-existing tracked files have the same SHA-256 hashes as before work,
and an explicit Git diff of those files is empty. In particular:

```text
4cacca0ac53b5ada2271047263c444ed185982abf73a97914b2866a5147a52ca  parcel-label.js
d86616306aa3c41274e8d972ee3a8f2eef12314bf45b8f9e9af5e4424aaa3114  parcel-label.test.js
```

## Independent review

A read-only review of a complete source/test/guide snapshot found no blocking
allocation or time-validation defects. Its non-blocking findings were handled:
raw header controls now fail validation, actual write-failure rollback has a
regression test, and the guide explicitly requires a trusted output directory
without concurrent pathname replacement. The reviewer did not execute tests or
inspect the repository directly; all runtime and scope checks above were run
in the implementation workspace.

## Review boundaries

- See README.md for the deliberately modest greedy rule and a concrete case where it misses a feasible complete plan.
- No optimizer, automatic rest breaks, proficiency checks, or local-timezone rule lookup is claimed.
- No dependency installation, network calls, build step, or third-party linter is required. Built-in syntax checks and real tests are the verification gates.
- Node 22 compatibility is based on the stable built-in APIs used; the executed runtime was Node 24, not a separate Node 22 installation.
- Changes are local and unpublished; no push or pull request was made.
