# Donation stockroom dispatch manifest

A small, dependency-free Node.js tool for turning a SKU catalogue and a batch of
donation orders into a combined pick list and a carton label for each order.
It runs locally: no account, network connection, package installation, or paid
service is needed. Requires **Node.js 22 or newer**.

## Volunteer quick start

Open a terminal in this project folder. Check Node, then try the synthetic batch:

```sh
node --version
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/orders.json
```

The sample has **3 orders, 3 cartons, 3 picked SKUs, and 14 items**:
2 fleece blankets, 6 hygiene kits, and 6 pairs of socks. The spare mug SKU is not
ordered, so it does not appear on the pick list. All organisations, addresses,
and postcodes in the examples are fictional; **do not ship the sample orders**.

Save the readable report and the machine-readable result alongside it:

```sh
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/orders.json > dispatch-report.txt
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/orders.json --format json > dispatch-manifest.json
```

Use fresh output filenames: shell redirection replaces an existing file, and a
failed run may leave an empty output file. Never redirect over an input file.
Use a saved result only if the command succeeded (exit code 0 and no error).
Keep the input files unchanged between these two commands. Reports and JSON both
contain delivery details; store and print them only where authorised volunteers
can access them. The default report filenames above are ignored by Git; give any
other saved reports the same care before committing changes.

Copy the sample files to prepare a real batch, edit them with a text editor, then
substitute your filenames in the commands. Quote paths containing spaces.
Run `node bin/dispatch-manifest.js --help` for all options.

**Packing rule:** this version assumes **one carton per order**. It does not
choose carton sizes, split orders, check available stock, or reserve inventory.
Confirm everything fits before using the label; if an order needs multiple
cartons, follow your stockroom's manual split-and-labelling process instead.
These are contents/address labels, not postage or carrier shipping labels.
Use the [packing guide](packing-guide.md), [label checks](label-checks.md), and
[delivery checks](delivery-checks.md) before dispatch.

## Input files

Both files are UTF-8 JSON objects, not CSV. JSON uses double quotes and cannot
contain comments or trailing commas. A leading UTF-8 BOM is accepted.

Catalogue (`examples/catalogue.json`):

```json
{
  "items": [
    { "sku": "HYGIENE-KIT", "name": "Sealed personal hygiene kit", "location": "Essentials / A1" }
  ]
}
```

- `items` must be a non-empty array. Each entry needs a unique `sku` and a
  readable `name`. `location` is optional; omit it if unknown (do not use null).
- SKUs are case-sensitive and must match exactly between files.

Orders (`examples/orders.json`):

```json
{
  "orders": [
    {
      "id": "DON-1044",
      "recipient": "Example Welcome Desk",
      "address": {
        "lines": ["2 Training Square", "Sampleford"],
        "postcode": "ZZ1 3ZZ",
        "country": "United Kingdom"
      },
      "items": [{ "sku": "HYGIENE-KIT", "quantity": 1 }]
    }
  ]
}
```

- `orders` may be empty for a no-dispatch batch. Every order needs a unique
  `id`, recipient, address, and non-empty items array.
- Address lines are a non-empty array (street, town/city, and any extra routing
  details), followed by required postcode and country. The tool checks presence,
  not deliverability or postal formats; volunteers must verify the full address.
- Each item needs a known SKU and a **positive safe whole-number quantity**:
  `1` or `12`, not `0`, negatives, fractions, or quoted numbers such as `"2"`.
  Individual quantities and all combined totals must be at most 9007199254740991.
- A quantity counts catalogue units: a pair of socks is one unit, not two socks.
- Repeated SKU lines within an order are added together. Repeated catalogue SKUs
  and repeated order IDs are errors, to avoid ambiguous or duplicate dispatches.
- All required text must be non-empty, well-formed Unicode, and single-line,
  without control characters or leading/trailing whitespace. Put each address
  line in a separate array entry. Escaped unpaired Unicode surrogates are rejected
  rather than silently replaced on printed labels.
- Extra properties are ignored, not copied into the result. They are not a way
  to supply packing instructions, stock limits, or multiple-carton information.

Validation stops at the first error and never emits a partial manifest.
An error names its field, for example
`orders.orders[0].items[0].quantity` (array positions start at zero).

## Library API and stable JSON

```js
const { createManifest, readJsonFile, formatReport, parcelLabel } = require("./index.js");

const catalogue = readJsonFile("examples/catalogue.json");
const orders = readJsonFile("examples/orders.json");
const manifest = createManifest(catalogue, orders);
console.log(formatReport(manifest));
const json = JSON.stringify(manifest, null, 2);

parcelLabel(1); // "1 item"
parcelLabel(3); // "3 items"
```

- `createManifest(catalogue, orders)` is synchronous, performs no I/O, validates
  parsed documents, and returns a new plain object without mutating the inputs.
- `readJsonFile(path)` synchronously reads and parses a small local JSON file.
- `formatReport(manifest)` formats a result from `createManifest` as text with
  a final newline. It is a renderer, not a validator for arbitrary objects.
- `ManifestError` is exported with stable `code`, human-readable `message`,
  and `exitCode` fields for expected failures.
- `require("./parcel-label.js").parcelLabel` remains unchanged, including its
  original permissive behaviour. The package root also re-exports that function.

The JSON result has `schemaVersion: 1` and these fields:

| Field | Meaning |
| --- | --- |
| `totals` | `orders`, `cartons`, `distinctSkus`, and `units` as numbers |
| `pickList[]` | `sku`, `name`, `location` (string or null), combined `quantity` |
| `orders[]` | `id`, `recipient`, copied `address` (`lines`, `postcode`, `country`), `items`, `totalUnits`, `carton` |
| `orders[].items[]` | Consolidated `sku`, catalogue `name`, `quantity` |
| `orders[].carton` | `number: 1`, `total: 1`, and a printable multiline `label` string |

Pick lists and order contents use ascending, case-sensitive JavaScript code-unit
SKU order, independent of locale. Orders retain input order. No timestamps or
random IDs are added. Identical parsed input produces identical JSON output;
the CLI emits two-space indentation and a final newline. JSON includes the same
carton label strings as the readable report. Empty batches return zero totals
and empty arrays. Consumers should check `schemaVersion` before interpreting results.

## Errors and exit codes

Successful results go only to stdout; errors are one concise line on stderr,
including in JSON mode (there is no error JSON mixed into stdout).

| Exit code | Meaning / error code |
| --- | --- |
| 0 | Success or help |
| 2 | Incorrect flags, missing arguments, unsupported format, repeated options: `USAGE` |
| 3 | Unreadable file: `INPUT_READ_FAILED`; malformed JSON: `INVALID_JSON`; bad data or overflowing totals: `INVALID_INPUT` |
| 1 | Output cannot be written: `OUTPUT_WRITE_FAILED`; unexpected failure: `INTERNAL_ERROR` |

For exit 2, check `--help`. For exit 3, fix the named file or field and rerun
before picking anything. For exit 1, check the output destination/disk space;
if it persists, ask the project maintainer. Diagnostics do not dump input files.

## Development and review

```sh
node --test
# Equivalent if npm is available (no npm install required):
npm test
```

Tests use only `node:test` and built-in Node modules. They retain the original
parcel-label tests and cover result shape, sorting, repeated SKUs, independent
input/output data, singular/plural labels, empty batches, malformed shapes,
unknown SKUs, duplicate IDs, bad quantities, numeric overflow, unsafe label text,
BOM handling, corrupt UTF-8 rejection, and real CLI stdout/stderr/exit codes.
The output-device failure test uses `/dev/full` where available and is skipped
on other platforms.

Modules: `lib/input.js` handles file/JSON loading; `lib/validate.js` validates
documents and safe totals; `lib/manifest.js` aggregates; `lib/format.js` renders;
`lib/errors.js` defines expected errors; `lib/cli.js` handles arguments and
exit codes. `index.js` is the public library; `bin/dispatch-manifest.js` is the
command-line entry point. The project deliberately uses Node built-ins rather
than a framework or dependency, and `package.json` is marked private.
