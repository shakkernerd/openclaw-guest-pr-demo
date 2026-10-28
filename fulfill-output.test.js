"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const cli = join(__dirname, "fulfill.js");

function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    input, encoding: "utf8", timeout: 5000, cwd: tmpdir(),
  });
}

function fixture(t, content, name = "batch with spaces.json") {
  const directory = mkdtempSync(join(tmpdir(), "fulfillment-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, name);
  writeFileSync(file, content);
  return file;
}

function shipment(id = "S-1", quantity = 1) {
  return { id, order: [{ sku: "MUG", quantity: 1 }], parcels: [{ id: "BOX-" + id, items: [{ sku: "MUG", quantity }] }] };
}

function inputRun(t, source, input, json = true) {
  const content = typeof input === "string" ? input : JSON.stringify(input);
  const file = source === "stdin" ? "-" : fixture(t, content);
  return run([...(json ? ["--json"] : []), file], source === "stdin" ? content : undefined);
}

function report(result, status) {
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout); // Also rejects extra human text or multiple JSON documents.
}

for (const source of ["file", "stdin"]) {
  test("JSON output reports ready batches from " + source, (t) => {
    assert.deepEqual(report(inputRun(t, source, [shipment()]), 0), {
      valid: true, total: 1, ready: 1, blocked: 0,
      shipments: [{ shipmentId: "S-1", valid: true, expectedQuantity: 1, packedQuantity: 1, parcelCount: 1, errors: [] }],
      errors: [],
    });
    assert.deepEqual(report(inputRun(t, source, []), 0), {
      valid: true, total: 0, ready: 0, blocked: 0, shipments: [], errors: [],
    });
  });

  test("JSON output reports every blocked shipment and actionable error from " + source, (t) => {
    const missing = shipment("MISSING");
    missing.parcels = [];
    const result = report(inputRun(t, source, [shipment(), missing, shipment("EXCESS", 3)]), 1);
    assert.equal(result.valid, false);
    assert.deepEqual([result.total, result.ready, result.blocked], [3, 1, 2]);
    assert.deepEqual(result.shipments.map(({ valid }) => valid), [true, false, false]);
    assert.deepEqual(result.errors, result.shipments.flatMap(({ errors }) => errors));
    assert.deepEqual(result.errors.map(({ code, path }) => ({ code, path })), [
      { code: "MISSING_QUANTITY", path: "shipments[1].parcels" },
      { code: "EXCESS_QUANTITY", path: "shipments[2].parcels" },
    ]);
    assert.match(result.errors[0].message, /MUG.*pack 1 more/);
    assert.match(result.errors[1].message, /MUG.*remove 2/);
  });

  test("JSON output distinguishes malformed data from malformed JSON for " + source, (t) => {
    const malformed = shipment();
    malformed.order[0].quantity = "1";
    const result = report(inputRun(t, source, [malformed, null]), 1);
    assert.deepEqual([result.total, result.ready, result.blocked], [2, 0, 2]);
    assert.equal(result.shipments[0].expectedQuantity, null);
    assert.equal(result.shipments[0].errors[0].path, "shipments[0].order[0].quantity");
    assert.equal(result.shipments[1].shipmentId, null);
    assert.equal(result.shipments[1].errors[0].code, "INVALID_SHIPMENT");
    for (const root of [null, {}, "not an array"]) {
      const invalid = report(inputRun(t, source, JSON.stringify(root)), 1);
      assert.deepEqual([invalid.valid, invalid.total, invalid.ready, invalid.blocked], [false, 0, 0, 0]);
      assert.deepEqual(invalid.shipments, []);
      assert.equal(invalid.errors[0].code, "INVALID_BATCH");
      assert.equal(invalid.errors[0].path, "shipments");
    }
    for (const raw of ["", "  ", '{"broken":', "[] []"]) {
      const invalid = inputRun(t, source, raw);
      assert.equal(invalid.status, 2);
      assert.equal(invalid.stdout, "");
      assert.match(invalid.stderr, /Cannot parse JSON/);
      if (source === "stdin") assert.match(invalid.stderr, /standard input/);
      assert.doesNotMatch(invalid.stderr, /\n\s+at /);
    }
  });

  test("JSON output preserves precision and duplicate-assignment protections for " + source, (t) => {
    for (const side of ["order", "packed"]) {
      const first = shipment("DUP");
      const second = shipment("DUP");
      (side === "order" ? second.order : second.parcels[0].items)[0].quantity = "RAW";
      const raw = JSON.stringify([first, second, shipment("INDEPENDENT")])
        .replace('"RAW"', "1.0000000000000001");
      const result = report(inputRun(t, source, raw), 1);
      assert.deepEqual([result.ready, result.blocked], [1, 2]);
      assert.deepEqual(result.shipments.map(({ valid }) => valid), [false, false, true]);
      for (const entry of result.shipments.slice(0, 2)) {
        assert.ok(entry.errors.some(({ code }) => code === "DUPLICATE_PARCEL"));
        assert.ok(entry.errors.some(({ code }) => code === "DUPLICATE_SHIPMENT"));
      }
      const precision = result.shipments[1].errors.find(({ code }) => code === "INVALID_QUANTITY");
      assert.ok(precision);
      assert.equal(precision.path, side === "order" ? "shipments[1].order[0].quantity" : "shipments[1].parcels[0].items[0].quantity");
      assert.equal(result.shipments[1][side === "order" ? "expectedQuantity" : "packedQuantity"], null);
    }
    for (const token of ["1.0", "100e-2", "1e+2", "9007199254740991"]) {
      const raw = '[{"id":"S","order":[{"sku":"A","quantity":' + token +
        '}],"parcels":[{"id":"P","items":[{"sku":"A","quantity":' + token + '}]}]}]';
      assert.equal(report(inputRun(t, source, raw), 0).ready, 1);
    }
  });
}

test("stdin text output is identical to default file output for ready and blocked batches", (t) => {
  for (const input of [[shipment()], [shipment("BLOCKED", 2)]]) {
    const fromFile = inputRun(t, "file", input, false);
    const piped = inputRun(t, "stdin", input, false);
    assert.equal(piped.status, fromFile.status);
    assert.equal(piped.stdout, fromFile.stdout);
    assert.equal(piped.stderr, "");
  }
  const raw = JSON.stringify([shipment()]).replace('"quantity":1', '"quantity":1.0000000000000001');
  const piped = inputRun(t, "stdin", raw, false);
  assert.equal(piped.status, 1);
  assert.match(piped.stdout, /INVALID_QUANTITY/);
  const malformed = inputRun(t, "stdin", "not JSON", false);
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /Cannot parse JSON in standard input/);
});

test("JSON flag works before or after input and leaves files unchanged", (t) => {
  const raw = JSON.stringify([shipment('S-1\n"quoted"')]);
  const file = fixture(t, raw);
  const first = run(["--json", file]);
  const last = run([file, "--json"]);
  assert.equal(first.stdout, last.stdout);
  assert.equal(report(last, 0).shipments[0].shipmentId, 'S-1\n"quoted"');
  assert.equal(readFileSync(file, "utf8"), raw);
  assert.deepEqual(report(run(["-", "--json"], raw), 0), report(first, 0));
});

test("JSON mode keeps usage and file failures on stderr with exit 2", (t) => {
  for (const args of [["--json"], ["--json", "--json", "-"], ["--unknown", "-"], ["--json", "a", "b"], ["--"], ["--json", "--unknown"]]) {
    const result = run(args, "[]");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/);
  }
  const missing = run(["--json", fixture(t, "[]") + ".missing"]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /Cannot read.*ENOENT/);
  const help = run(["--json", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--json/);
  assert.match(help.stdout, /standard input/);
  assert.equal(help.stderr, "");
});

test("option terminator allows filenames that look like flags", (t) => {
  const file = fixture(t, "[]", "--json");
  const result = spawnSync(process.execPath, [cli, "--json", "--", "--json"], {
    encoding: "utf8", timeout: 5000, cwd: join(file, ".."),
  });
  assert.equal(report(result, 0).total, 0);
});

test("documented JSON report matches both file and piped example output", () => {
  const file = join(__dirname, "examples", "shipments.json");
  const expected = readFileSync(join(__dirname, "examples", "shipments.report.json"), "utf8");
  const fromFile = run(["--json", file]);
  const piped = run(["--json", "-"], readFileSync(file, "utf8"));
  assert.equal(fromFile.status, 1);
  assert.equal(piped.status, 1);
  assert.equal(fromFile.stdout, expected);
  assert.equal(piped.stdout, expected);
});
