"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseBatchJson } = require("./fulfill.js");
const cli = join(__dirname, "fulfill.js");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000, cwd: tmpdir() });
}

function batchFile(t, content) {
  const directory = mkdtempSync(join(tmpdir(), "fulfillment-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "shipments with spaces.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

function shipment(id = "S-1", quantity = 1) {
  return { id, order: [{ sku: "MUG", quantity: 1 }], parcels: [{ id: `BOX-${id}`, items: [{ sku: "MUG", quantity }] }] };
}

test("CLI reads a JSON batch and prints ready shipments using existing item labels", (t) => {
  const file = batchFile(t, [shipment()]);
  const before = readFileSync(file, "utf8");
  const result = run([file]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /READY "S-1": 1 item packed \/ 1 item ordered; 1 parcel/);
  assert.match(result.stdout, /Summary: 1 ready, 0 blocked, 1 shipment\./);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("CLI reports all shipments and actionable missing/excess errors with exit 1", (t) => {
  const missing = shipment("MISSING");
  missing.parcels = [];
  const result = run([batchFile(t, [shipment(), missing, shipment("EXCESS", 3)])]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /READY "S-1"/);
  assert.match(result.stdout, /BLOCKED "MISSING": 0 items packed/);
  assert.match(result.stdout, /MISSING_QUANTITY.*shipments\[1\].*MUG.*pack 1 more/);
  assert.match(result.stdout, /EXCESS_QUANTITY.*shipments\[2\].*MUG.*remove 2/);
  assert.match(result.stdout, /Summary: 1 ready, 2 blocked, 3 shipments\./);
});

test("CLI blocks both shipments that share a parcel ID", (t) => {
  const first = shipment("FIRST");
  const second = shipment("SECOND");
  second.parcels[0].id = first.parcels[0].id;
  const result = run([batchFile(t, [first, second])]);
  assert.equal(result.status, 1);
  assert.equal((result.stdout.match(/DUPLICATE_PARCEL/g) || []).length, 2);
  assert.match(result.stdout, /Summary: 0 ready, 2 blocked, 2 shipments\./);
});

test("CLI handles schema failures, unknown counts, and empty batches", (t) => {
  const invalid = shipment();
  invalid.order[0].quantity = "1";
  const result = run([batchFile(t, [invalid, null])]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /1 item packed \/ unknown ordered/);
  assert.match(result.stdout, /INVALID_QUANTITY.*shipments\[0\]\.order\[0\]\.quantity/);
  assert.match(result.stdout, /INVALID_SHIPMENT.*shipments\[1\]/);
  const root = run([batchFile(t, {})]);
  assert.equal(root.status, 1);
  assert.match(root.stdout, /INVALID_BATCH.*JSON array/);
  const empty = run([batchFile(t, [])]);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /Summary: 0 ready, 0 blocked, 0 shipments\./);
});

test("CLI explains file and JSON errors without a stack trace and exits 2", (t) => {
  const malformed = run([batchFile(t, '{"broken":')]);
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /Cannot parse JSON.*shipments with spaces\.json/);
  assert.doesNotMatch(malformed.stderr, /\n\s+at /);
  const file = batchFile(t, []);
  const missing = run([`${file}.missing`]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Cannot read.*ENOENT/);
});

test("CLI has help and rejects missing or extra arguments", () => {
  for (const flag of ["--help", "-h"]) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: node fulfill\.js <shipments\.json>/);
  }
  for (const args of [[], ["one.json", "two.json"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});

test("CLI escapes shipment IDs so identifiers cannot forge summary lines", (t) => {
  const result = run([batchFile(t, [shipment("S-1\nREADY forged")])]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /S-1\\nREADY forged/);
  assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("READY")).length, 1);
});

test("documented example is executable and matches the README summary exactly", () => {
  const result = run([join(__dirname, "examples", "shipments.json")]);
  assert.equal(result.status, 1, result.stderr);
  const readme = readFileSync(join(__dirname, "README.md"), "utf8");
  const documentedOutput = readme.match(/```text\n(Shipment fulfillment summary[\s\S]*?)\n```/);
  assert.ok(documentedOutput, "README includes the complete example output");
  assert.equal(result.stdout.trimEnd(), documentedOutput[1]);
});

// Keep these as raw JSON: constructing JS numbers would hide the precision bug.
for (const side of ["order", "packed"]) {
  test("CLI rejects fractional JSON quantities rounded to integers on the " + side + " side", (t) => {
    const cases = [
      ["1.0000000000000001", "1"],
      ["0.99999999999999999", "1"],
      ["9007199254740991.1", "9007199254740991"],
      ["9007199254740990.5", "9007199254740990"],
      ["1.0000000000000001e1", "10"],
      ["10000000000000001e-16", "1"],
    ];
    for (const [fraction, rounded] of cases) {
      const ordered = side === "order" ? fraction : rounded;
      const packed = side === "packed" ? fraction : rounded;
      const input = '[{"id":"S","order":[{"sku":"A","quantity":' + ordered +
        '}],"parcels":[{"id":"P","items":[{"sku":"A","quantity":' + packed + '}]}]}]';
      const result = run([batchFile(t, input)]);
      assert.equal(result.status, 1, fraction + ": " + result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /BLOCKED "S"/);
      assert.match(result.stdout, /INVALID_QUANTITY.*positive safe integer/);
      assert.ok(result.stdout.includes(side === "order"
        ? "shipments[0].order[0].quantity" : "shipments[0].parcels[0].items[0].quantity"));
      assert.match(result.stdout, /Summary: 0 ready, 1 blocked, 1 shipment/);
    }
  });
}

test("CLI preserves exact integer decimal and exponent representations", (t) => {
  for (const token of ["1", "1.0", "1e0", "0.1e1", "100e-2", "1.01e2", "1e+2", "9007199254740991.0"]) {
    const input = '[{"id":"S","order":[{"sku":"A","quantity":' + token +
      '}],"parcels":[{"id":"P","items":[{"sku":"A","quantity":' + token + '}]}]}]';
    const result = run([batchFile(t, input)]);
    assert.equal(result.status, 0, token + ": " + result.stdout + result.stderr);
    assert.match(result.stdout, /READY "S"/);
  }
});

test("precision failures still block every duplicate assignment and preserve independent shipments", (t) => {
  const first = shipment("FIRST");
  const invalid = shipment("INVALID");
  invalid.order[0].quantity = "RAW_QUANTITY";
  invalid.parcels[0].id = first.parcels[0].id;
  const independent = shipment("INDEPENDENT");
  independent.metadata = { quantity: "RAW_QUANTITY" };
  const input = JSON.stringify([first, invalid, independent])
    .replaceAll('"RAW_QUANTITY"', "1.0000000000000001");
  const result = run([batchFile(t, input)]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /BLOCKED "FIRST"/);
  assert.match(result.stdout, /BLOCKED "INVALID"/);
  assert.match(result.stdout, /READY "INDEPENDENT"/);
  assert.equal((result.stdout.match(/DUPLICATE_PARCEL/g) || []).length, 2);
  assert.equal((result.stdout.match(/INVALID_QUANTITY/g) || []).length, 1);
  assert.match(result.stdout, /Summary: 1 ready, 2 blocked, 3 shipments/);
});

test("source-aware parsing preserves invalid quantities and bounds exponent expansion", () => {
  for (const token of ["0", "-0", "-1", "1.5", "1e309", "1e-9999", "9007199254740992", '"1"', "null", "true", "{}", "[]"]) {
    const result = parseBatchJson('{"quantity":' + token + '}');
    assert.deepEqual(result.quantity, JSON.parse(token));
  }
  assert.ok(Number.isNaN(parseBatchJson('{"quant\\u0069ty":1.0000000000000001}').quantity));
  // Long mantissas and exponents must not require constructing powers of ten.
  const token = "1" + "0".repeat(10000) + "e-10000";
  assert.equal(parseBatchJson('{"quantity":' + token + '}').quantity, 1);
  assert.equal(parseBatchJson('{"quantity":1e+' + "0".repeat(10000) + '}').quantity, 1);
});

test("documented corrections make both example shipments ready", (t) => {
  const input = parseBatchJson(readFileSync(join(__dirname, "examples", "shipments.json"), "utf8"));
  input[1].parcels[0].items[0].quantity = 2;
  input[1].parcels[0].items[1].quantity = 1;
  const result = run([batchFile(t, input)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Summary: 2 ready, 0 blocked, 2 shipments/);
});
