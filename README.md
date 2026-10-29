# Donation stockroom dispatch manifest

A small, dependency-free Node.js tool for turning a SKU catalogue and a batch of
donation orders into a combined pick list and a carton label for each order.
An optional stock-on-hand snapshot checks the whole batch for shortages before packing.
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
Use a saved result for packing only after exit code 0 and no error. With optional
stock checking, exit code 4 also returns a complete report, but it is for shortage
resolution only: do not pack from it. Without stock, exit 0 does not check availability.
Keep the input files unchanged between these two commands. Reports and JSON both
contain delivery details; store and print them only where authorised volunteers
can access them. The default report filenames above are ignored by Git; give any
other saved reports the same care before committing changes.

Copy the sample files to prepare a real batch, edit them with a text editor, then
substitute your filenames in the commands. Quote paths containing spaces.
Run `node bin/dispatch-manifest.js --help` for all options.

**Packing rule:** this version assumes **one carton per order**. It does not
choose carton sizes, split orders, or reserve inventory. Stock availability is
checked only when you supply the optional snapshot described below.
Confirm everything fits before using the label; if an order needs multiple
cartons, follow your stockroom's manual split-and-labelling process instead.
These are contents/address labels, not postage or carrier shipping labels.
Use the [packing guide](packing-guide.md), [label checks](label-checks.md), and
[delivery checks](delivery-checks.md) before dispatch.

## Check stock before packing (optional)

Add `--stock` with a local stock-on-hand snapshot. These examples use the same
orders as the quick start:

```sh
# Enough stock: exit 0, with requested / available / missing counts.
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/orders.json --stock examples/stock-enough.json

# Shortages: exit 4, with a prominent DO NOT PACK warning.
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/orders.json --stock examples/stock-shortage.json

# The same shortage as complete machine-readable JSON: still exit 4.
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/orders.json --stock examples/stock-shortage.json --format json
```

The enough-stock sample has 3 blankets, 6 hygiene kits, and 10 pairs of socks;
all missing counts are zero. The shortage sample reports:

| SKU | Requested | Available | Missing |
| --- | ---: | ---: | ---: |
| BLANKET-FLEECE | 2 | 1 | 1 |
| HYGIENE-KIT | 6 | 4 | 2 |
| SOCK-ADULT | 6 | 0 | 6 |

An on-hand file has this shape (see both complete sample files in `examples/`):

```json
{
  "items": [
    { "sku": "BLANKET-FLEECE", "quantity": 3 },
    { "sku": "HYGIENE-KIT", "quantity": 6 },
    { "sku": "SOCK-ADULT", "quantity": 10 }
  ]
}
```

- Quantities are **non-negative safe whole numbers** (0 to 9007199254740991).
  Unlike order quantities, zero is allowed. Strings, fractions, negatives, and
  unsafe numbers are rejected. In files, use plain integer notation: `6`, not
  `6.0` or `6e0`. See the file-versus-library guarantees below.
  Use the same catalogue units as the orders.
- Every row must use a known, case-sensitive SKU. Duplicate rows are errors,
  not quantities to add; combine your shelf counts before creating the snapshot.
- **A SKU omitted from a supplied stock file counts as zero available.**
  `{ "items": [] }` is a valid snapshot with no stock. Do not supply a partial
  count expecting missing SKUs to be treated as unknown or assumed sufficient.
- Requested quantities are aggregated across all orders, including repeated
  order lines. Available is the full recorded count, not capped at demand.
  Missing is `max(0, requested - available)`. Only requested SKUs appear in the
  stock check; unused known SKUs are accepted but still validated.
- These are **read-only snapshot checks**, not reservations or live inventory.
  The tool never rewrites stock files, reduces orders, or chooses which recipient
  receives scarce stock. Totals, pick lists, and carton contents remain requested
  quantities even when stock is short.
- On shortage, stop and ask the stockroom coordinator to resolve the shortfall
  or explicitly revise the orders, then rerun. Carton labels in that report are
  planning-only, not permission to pack. Recheck counts before packing because
  another batch may have used stock since the snapshot was taken.

Exit 4 is an expected business result, **not malformed input**: automation must
retain and parse stdout while handling that exit code. Both formats produce a
complete report, with no stderr error for shortages. Omitting `--stock` keeps
the original commands and byte-for-byte no-stock text/JSON output unchanged.

## Input files

All input files are UTF-8 JSON objects, not CSV. JSON uses double quotes and cannot
contain comments or trailing commas. A leading UTF-8 BOM is accepted.

### Number spelling and duplicate member names

**For files read by the CLI or `readJsonFile`: write quantities as plain decimal
integer tokens.** This intentionally stricter input convention avoids relying on
rounding when deciding whether a count is a whole number:

| Written quantity | File behaviour |
| --- | --- |
| `1`, `12` | Accepted, subject to the schema and safe total limits |
| `0` | Accepted for stock; rejected for orders |
| `1.5`, `1.0000000000000001` | Rejected, even if JavaScript rounds the latter to 1 |
| `1.0`, `1e0`, `10e-1`, `1e-400` | Rejected: no decimal points or exponent notation, even for mathematically whole values |
| `"2"`, negative counts, counts above 9007199254740991 | Rejected by order/stock schema validation |

The spelling rule applies to every numeric member named `quantity`, including
escaped spellings of that name and otherwise ignored metadata. Sign/range/type
rules apply to the actual order and stock quantity fields. A leading minus is
recognised as integer notation, but negative counts are invalid; `-0` behaves
as zero (stock accepts and normalises it, orders reject it). Prefer writing `0`.
Other unused numeric metadata retains ordinary JavaScript Number semantics; it
can round and is not an arbitrary-precision decimal representation.

**Every object in every input file must have unique JSON member names**, including
objects in ignored metadata. Repeating `"orders"`, `"quantity"`, `"items"`, or
any other name in the same object is rejected, even when both values are equal.
There is no last-value-wins merging. Names are compared case-sensitively after
JSON escape decoding, so `"orders"` and `"\u006frders"` are duplicates. No Unicode
normalisation is applied. The same name in separate objects is fine; this does
not prohibit the ordinary `quantity` member on every line item. Duplicate member
names are distinct from duplicate SKU/order ID values, which have their own
schema rules below.

These file-level failures exit **3**, write a diagnostic to stderr, and emit
**no manifest on stdout**. Decimal/exponent quantity tokens use `INVALID_INPUT`;
duplicate names use `DUPLICATE_MEMBER`. Do not preprocess suspect files with
`JSON.parse`/`JSON.stringify` before checking: that can erase the evidence.

**Library limit:** `createManifest` receives already-parsed JavaScript objects.
It checks quantity values with `Number.isSafeInteger` and the documented sign
and total limits. It cannot recover a decimal spelling or duplicate members
already discarded by another parser. For example, native `JSON.parse` turns
`1.0000000000000001` into `1`, and keeps the last of two `orders` members;
passing those objects directly cannot expose their lost source information.
Use the CLI or `readJsonFile` on the original files for the stronger guarantees.
This is not arbitrary-precision arithmetic or a promise to detect every decimal
that was rounded upstream before the JSON file was written.

### Catalogue and orders

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
  File quantities must also follow the plain-integer spelling rule above.
  Individual quantities and all combined totals must be at most 9007199254740991.
- A quantity counts catalogue units: a pair of socks is one unit, not two socks.
- Repeated SKU lines within an order are added together. Repeated catalogue SKUs
  and repeated order IDs are errors, to avoid ambiguous or duplicate dispatches.
- All required text must be non-empty, well-formed Unicode, and single-line,
  without control characters or leading/trailing whitespace. Put each address
  line in a separate array entry. Escaped unpaired Unicode surrogates are rejected
  rather than silently replaced on printed labels.
- Extra properties are not copied into the result, but still undergo file-level
  duplicate-name and quantity-spelling checks. They are not a way to supply
  packing instructions, stock limits, or multiple-carton information.

Validation stops at the first error and never emits a partial manifest.
Schema errors name their field, for example
`orders.orders[0].items[0].quantity` (array positions start at zero).
File-level errors identify the filename and offending rule; duplicate-name
diagnostics also give an approximate character position.

### Reproduce the file-input checks

The files under `examples/input-checks/` are intentionally invalid synthetic
examples, not packing inputs. Each command below exits 3 with empty stdout:

```sh
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/input-checks/orders-rounded-fraction.json --format json
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/input-checks/orders-duplicate-member.json --format json
node bin/dispatch-manifest.js --catalogue examples/catalogue.json --orders examples/orders.json --stock examples/input-checks/stock-rounded-fraction.json --format json
```

The existing `examples/orders.json` still succeeds without stock or with
`stock-enough.json` (exit 0). `stock-shortage.json` still returns a complete
shortage report (exit 4). These are different from invalid-file failures.

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

- `createManifest(catalogue, orders, stock?)` is synchronous, performs no I/O, validates
  parsed documents, and returns a new plain object without mutating the inputs.
  Omit the third argument (or pass `undefined`) to keep the original result.
  Pass a parsed stock object to add the check; `null` is invalid, not an opt-out.
  A shortage returns a manifest rather than throwing: inspect `stockCheck.hasShortages`.
- `readJsonFile(path)` synchronously reads and parses a small local JSON file,
  enforcing the source-level quantity notation and duplicate-member rules above.
  Full catalogue/order/stock schema validation happens in `createManifest`.
- `formatReport(manifest)` formats a result from `createManifest` as text with
  a final newline. It is a renderer, not a validator for arbitrary objects.
- `ManifestError` is exported with stable `code`, human-readable `message`,
  and `exitCode` fields for expected failures.
- `require("./parcel-label.js").parcelLabel` remains unchanged, including its
  original permissive behaviour. The package root also re-exports that function.

The JSON result keeps `schemaVersion: 1` and these fields:

| Field | Meaning |
| --- | --- |
| `totals` | `orders`, `cartons`, `distinctSkus`, and `units` as numbers |
| `pickList[]` | `sku`, `name`, `location` (string or null), combined `quantity` |
| `orders[]` | `id`, `recipient`, copied `address` (`lines`, `postcode`, `country`), `items`, `totalUnits`, `carton` |
| `orders[].items[]` | Consolidated `sku`, catalogue `name`, `quantity` |
| `orders[].carton` | `number: 1`, `total: 1`, and a printable multiline `label` string |
| `stockCheck` (only with stock) | `hasShortages` boolean and `items` array |
| `stockCheck.items[]` | `sku`, numeric `requested`, `available`, and `missing`, sorted by SKU |

Without stock, `stockCheck` is absent, not null. With stock, it is an additive
extension: all existing fields, including order quantities and carton label
strings, are unchanged. For an empty batch the extension is
`{ "hasShortages": false, "items": [] }`. For the shortage example it is:

```json
{
  "hasShortages": true,
  "items": [
    { "sku": "BLANKET-FLEECE", "requested": 2, "available": 1, "missing": 1 },
    { "sku": "HYGIENE-KIT", "requested": 6, "available": 4, "missing": 2 },
    { "sku": "SOCK-ADULT", "requested": 6, "available": 0, "missing": 6 }
  ]
}
```

Pick lists and order contents use ascending, case-sensitive JavaScript code-unit
SKU order, independent of locale. Orders retain input order. No timestamps or
random IDs are added. Identical parsed input produces identical JSON output;
the CLI emits two-space indentation and a final newline. JSON includes the same
carton label strings as the readable report. Empty batches return zero totals
and empty arrays. Consumers should check `schemaVersion` before interpreting results.

## Errors and exit codes

Results, including shortages, go only to stdout; input/usage/output errors are
one concise line on stderr, including in JSON mode (there is no error JSON mixed
into stdout). A shortage is not an exception and does not suppress the report.

| Exit code | Meaning / error code |
| --- | --- |
| 0 | Success or help; with stock, no shortages |
| 2 | Incorrect flags, missing arguments, unsupported format, repeated options: `USAGE` |
| 3 | Unreadable file: `INPUT_READ_FAILED`; malformed JSON: `INVALID_JSON`; duplicate member: `DUPLICATE_MEMBER`; bad quantity spelling, data, or overflowing totals: `INVALID_INPUT` |
| 1 | Output cannot be written: `OUTPUT_WRITE_FAILED`; missing native parsing support: `UNSUPPORTED_RUNTIME`; unexpected failure: `INTERNAL_ERROR` |
| 4 | Stock shortage: complete text/JSON report on stdout; do not pack |

For exit 2, check `--help`. For exit 3, fix the named file or field and rerun
before picking anything. For exit 1, check the output destination/disk space;
if it persists, ask the project maintainer. Exit 1 takes precedence over exit 4
if the shortage report cannot be written. For exit 4, resolve the reported
shortages and rerun. Diagnostics do not dump input files.
For `UNSUPPORTED_RUNTIME`, use Node.js 22 or newer with native `JSON.parse`
source-context support. The loader refuses numeric quantities if that feature
is unavailable rather than silently falling back to rounded-value checks.

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
Stock tests cover sufficient/exact/zero/missing counts, whole-batch shortages,
non-allocation, validation, unchanged v1 fields and no-stock output hashes,
snapshot immutability, and shortage reports in both real CLI formats.
Raw-text input tests cover precision-losing decimals, exponents, duplicate members
at nested scopes, escaped names, punctuation inside strings, and the limits of
already-parsed library input. CLI regressions retain the original number tokens
instead of creating them with `JSON.stringify`, which would lose precision first.
The output-device failure test uses `/dev/full` where available and is skipped
on other platforms.

Modules: `lib/input.js` handles file loading; `lib/json-input.js` uses native
`JSON.parse` for syntax/values and numeric source context, followed by a small
scope/name scan of the original valid JSON solely to reject duplicate members.
It is not a replacement JSON grammar or numeric parser. `lib/validate.js` validates
documents and safe totals; `lib/manifest.js` aggregates; `lib/stock.js` compares
batch demand with the supplied snapshot; `lib/format.js` renders;
`lib/errors.js` defines expected errors; `lib/cli.js` handles arguments and
exit codes. `index.js` is the public library; `bin/dispatch-manifest.js` is the
command-line entry point. The project deliberately uses Node built-ins rather
than a framework or dependency, and `package.json` is marked private.
