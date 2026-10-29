# E11 Dispatch Desk

A small, dependency-free Node.js dispatch planner for a delivery team. Give it a
JSON batch of deliveries and available couriers; get a readable dispatch report
or a machine-readable plan. Requires **Node.js 22 or newer**. No install, network
access, API keys, or external services are needed.

This repository also retains its original `parcelLabel` helper and tests.

## Run the command

```sh
# Readable report
node dispatch.js examples/morning-dispatch.json

# JSON for another tool or an operator's saved plan
node dispatch.js examples/morning-dispatch.json --json

# Read a batch from stdin
node dispatch.js --json - < examples/morning-dispatch.json

node dispatch.js --help
```

Run these commands from the repository root. You can also invoke the script by
absolute path; input file paths are relative to your current directory. `--json`
may appear before or after the file. Use `--` to end options for a file name starting
with a dash, for example `node dispatch.js --json -- -batch.json`.

### Synthetic morning shift

`examples/morning-dispatch.json` contains six fictional Leytonstone deliveries
(two urgent), two bike couriers, and one van courier with five available stops.
All names, addresses, postcodes, and notes are synthetic, not live dispatch data.
The input is deliberately unsorted. The result is:

- `bike-01` / Alex: `E11-101` (urgent), then `E11-104` — 2/2 stops.
- `bike-02` / Morgan: `E11-102` (urgent), then `E11-105` — 2/2 stops.
- `van-01` / Sam: `E11-103` — 1/1 stop.
- **Unassigned:** `E11-106` — no courier capacity available.

The report includes each delivery's address, priority, and notes, courier usage
and remaining capacity, and an explicit unassigned section (even when empty).

## Input format

Supply one UTF-8 JSON object containing both arrays. Invalid UTF-8 bytes are
rejected before decoding, never silently replaced in IDs, addresses, or other text:

```json
{
  "deliveries": [
    {
      "id": "E11-101",
      "address": "8 Birch Court, Leytonstone, London E11 1DD, UK",
      "priority": "urgent",
      "notes": "Repair part for community kitchen"
    }
  ],
  "couriers": [
    { "id": "bike-01", "name": "Alex", "capacity": 2 }
  ]
}
```

- Delivery: required `id`, `address`, and `priority`; optional `notes`.
  Priority must be exactly `"urgent"` or `"normal"`; it is never guessed/defaulted.
- Courier: required `id` and `capacity`; optional `name`. Only list available
  couriers. Capacity is the number of **additional delivery stops for this batch**,
  not parcels, weight, volume, minutes, or total shift capacity. Each delivery
  consumes one stop, even if two deliveries have the same address.
- Capacity must be a JSON number: an integer from 0 through 9007199254740991
  (`Number.MAX_SAFE_INTEGER`). Zero-capacity couriers remain in the report but
  receive no work. Numeric strings and fractional/negative capacities are errors.
- All text fields must be non-empty strings without surrounding whitespace,
  line breaks, or control characters. IDs must be unique within each array;
  they are case-sensitive. Text is validated, not silently trimmed or coerced.
- Both arrays may be empty. With no couriers or no capacity, every delivery is
  returned unassigned. An empty delivery batch produces a valid empty plan.
- Unknown fields are rejected to catch typos and unsupported constraints instead
  of ignoring them. Duplicate JSON object keys are also rejected, rather than
  silently overwriting an earlier deliveries list or priority. A single invalid
  record rejects the **whole batch** before any report is written.

Address text is required but is not geocoded or checked for postal validity.
Continue using the existing [delivery checks](delivery-checks.md),
[label checks](label-checks.md), and [packing guide](packing-guide.md).

## Assignment rules

1. Sort deliveries by priority: urgent first, then normal.
2. Within each priority, sort by delivery ID in ascending, case-sensitive UTF-16
   code-unit order (not locale or natural-number order: `D10` sorts before `D2`).
3. For each delivery, choose a courier with remaining capacity and the fewest
   deliveries assigned in this batch. If loads tie, the smallest courier ID wins
   using the same comparison. Capacity is never exceeded.
4. If no courier has room, retain the complete delivery in `unassigned` with
   `reason: "capacity_exhausted"`. No delivery is dropped or assigned twice.

Output couriers are ID-sorted. Each courier's deliveries and the unassigned list
retain dispatch-priority order. Reordering either input array does not change
assignments. There are no random choices, clock reads, or locale-dependent ties.

This is a **stop-count allocation**, not a route optimizer. Listed order is not
travel order. It does not model distance, traffic, time windows, courier skills,
vehicle type, weight, or prior assignments. Review unassigned work and arrange
extra capacity or a later batch; do not assume a successful run means all work fit.

## JSON and exit status

`--json` writes one complete JSON object to stdout, with no report mixed in:

- `summary`: `totalDeliveries`, `assignedDeliveries`, `unassignedDeliveries`.
- `couriers`: every input courier (including idle couriers), plus `assignedCount`,
  `remainingCapacity`, and `deliveries` containing the original delivery fields.
- `unassigned`: the remaining complete deliveries, each with the reason above.

**Exit 0:** help or a valid plan, including a plan with unassigned deliveries.
Automation must inspect `summary.unassignedDeliveries` to detect overflow.
**Exit 1:** bad arguments, unreadable input, invalid UTF-8, malformed JSON, or an invalid batch.
Errors go to stderr; stdout stays empty and no partial plan is emitted. For example:

```text
Error: couriers[0].capacity: must be a non-negative safe integer (delivery stops)
```

The command only reads input and writes output; it does not contact couriers,
change input files, or save assignments between runs.

## Tests and existing behavior

```sh
node --test
```

Tests use only the built-in `node:test` runner and `node:assert/strict`. They launch
the actual command for file/stdin input, readable/JSON output, help, argument and
schema errors, and exit codes. Rule tests cover urgency, deterministic ties,
capacity, overflow, empty inputs, unchanged input objects, and conservation across
192 generated batches.

The original `parcelLabel(count)` export in `parcel-label.js` remains unchanged.
Its tests still cover 0, 1, and 3, expecting `0 items`, `1 item`, and `3 items`.
