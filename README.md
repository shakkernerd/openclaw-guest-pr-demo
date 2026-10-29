# E10 Dispatch Desk — packing quality

A dependency-free Node.js CLI for checking a dispatch file before parcels leave
the desk. This repository contains synthetic, disposable fixtures; the example
names and addresses are fictional, not real delivery destinations.

The checklist follows [packing-guide.md](packing-guide.md),
[label-checks.md](label-checks.md) and [delivery-checks.md](delivery-checks.md).
It reuses `parcelLabel` from [parcel-label.js](parcel-label.js) for item labels.
Only Node built-ins are needed: no install, package manager or network access.
The CLI reads the input without modifying it.
Nothing is uploaded or dispatched.

## Quick start

Use **Node.js 22 or newer**, from the repository root:

```sh
node packing-quality.js --help
node packing-quality.js examples/dispatch.json
echo $?  # 0 (POSIX shell)
```

The synthetic sample has **2 ready parcels and 4 ready-to-dispatch items**.
For your own dispatch, copy [the sample JSON](examples/dispatch.json), record the
physical checks, then run the CLI on that file. Follow the
[dispatch schema](packing-reference.md#dispatch-format-and-validation); these are
recorded checks, not proof of physical packing or postal deliverability.

## Choose an output

All three outputs use one validation report. Select at most one output flag:

| Choice | Handoff |
| --- | --- |
| Default text | Checklist, counted/ready item totals and full corrective actions |
| `--csv` | One row per input parcel, separate address fields and concise anomalies |
| `--html` | Standalone printable sheet; no server, JavaScript or external assets |

Regenerate the supplied synthetic exports (never redirect onto the source JSON):

```sh
node packing-quality.js --csv examples/dispatch.json > examples/packing-handoff.csv
echo $?  # 0
```

```sh
node packing-quality.js --html examples/dispatch.json > examples/packing-handoff.html
echo $?  # 0
```

Open the [HTML example](examples/packing-handoff.html) locally, or import the
[CSV example](examples/packing-handoff.csv) using the
[Text-column instructions](packing-reference.md#import-id-and-postcode-as-text-preserve-leading-zeros).
See [print guidance](packing-reference.md#printable-html-handoff) before printing.

### CSV output example

```csv
id,recipient,street,city,region,postcode,country,itemCount,readiness,anomalies
"E10-001","Zoë O’Example","12 Example Lane, Flat #4-B","London","","E10 0ZZ","United Kingdom",3,"READY",""
"E10-002","山田・サンプル","見本町 1-2-3, 例示ビル #5","東京都","","000-0000","日本",1,"READY",""
```

## Exit codes

| Code | Meaning | Output |
| --- | --- | --- |
| 0 | All recorded checks pass, or help requested | Text, CSV, HTML or help to stdout |
| 1 | Valid JSON with schema, field or confirmation anomalies | Selected report to stdout; CSV dispatch-level errors also go to stderr |
| 2 | Usage, input/JSON or output I/O error | Diagnostic to stderr; no report for input errors; output-write failures may leave a partial report |

Capture the status immediately; a report file or a successful downstream command
is not proof of success. Follow the [error and safe-output reference](packing-reference.md#error-examples-and-exit-codes),
including [pipe previews](packing-reference.md#previewing-through-a-pipe).
Resolve anomalies and obtain physical sign-off before dispatch; treat reports as
delivery data, not public artifacts.

## Next steps

- **New operators:** work through the [mixed-to-cleared training handoff](examples/packing-training.md).
- **Reference:** [schema and totals](packing-reference.md#dispatch-format-and-validation),
  [CSV/import/formula handling](packing-reference.md#csv-warehouse-handoff),
  [printing](packing-reference.md#printable-html-handoff) and [error examples](packing-reference.md#error-examples-and-exit-codes).
- **Contributors:** [test commands and verification coverage](packing-reference.md#tests).
