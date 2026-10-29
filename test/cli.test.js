"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync, existsSync, openSync, closeSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createManifest, readJsonFile, formatReport, ManifestError } = require("..");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "bin/dispatch-manifest.js");
const cataloguePath = path.join(root, "examples/catalogue.json");
const ordersPath = path.join(root, "examples/orders.json");
const args = ["--catalogue", cataloguePath, "--orders", ordersPath];

function run(extra = args, options = {}) {
  return spawnSync(process.execPath, [cli, ...extra], {
    encoding: "utf8", timeout: 10000, cwd: root, ...options,
  });
}

function temporaryFile(t, contents, name = "input with spaces.json") {
  const directory = mkdtempSync(path.join(tmpdir(), "dispatch-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, name);
  writeFileSync(filename, contents);
  return filename;
}

function assertFailure(result, status, code) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.startsWith("dispatch-manifest: " + code + ":"), result.stderr);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
}

test("real CLI text report uses the synthetic batch and expected totals", () => {
  const result = run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.includes("Orders: 3 | Cartons: 3 | SKUs: 3 | Total: 14 items"));
  assert.ok(result.stdout.includes("6 x SOCK-ADULT"));
  assert.ok(result.stdout.includes("6 x HYGIENE-KIT"));
  assert.ok(result.stdout.includes("2 x BLANKET-FLEECE"));
  assert.equal(result.stdout.match(/Carton: 1 of 1/g).length, 3);
  assert.ok(result.stdout.includes("Total: 1 item\n"));
  const manifest = createManifest(readJsonFile(cataloguePath), readJsonFile(ordersPath));
  assert.equal(result.stdout, formatReport(manifest));
});

test("real CLI JSON is clean, repeatable, and matches the public library", () => {
  const result = run([...args, "--format", "json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), createManifest(readJsonFile(cataloguePath), readJsonFile(ordersPath)));
  assert.equal(result.stdout, run([...args, "--format=json"]).stdout);
});

test("CLI works outside the repository with absolute input paths", () => {
  const result = run([...args, "--format", "json"], { cwd: tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).totals.units, 14);
});

test("help succeeds without input files", () => {
  for (const flag of ["--help", "-h"]) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /Exit codes:/);
  }
});

test("usage errors have exit code 2, stderr only and no stack", async (t) => {
  for (const badArgs of [[], ["--catalogue", cataloguePath], ["--orders"], ["--wat"], ["positional"], [...args, "--format", "xml"], [...args, "--orders", ordersPath], [...args, "--format", "json", "--format", "text"], ["--catalogue=", "--orders", ordersPath]]) {
    await t.test(JSON.stringify(badArgs), () => assertFailure(run(badArgs), 2, "USAGE"));
  }
});

test("unreadable input and directory paths are input errors, not crashes", (t) => {
  const existing = temporaryFile(t, "{}");
  assertFailure(run(["--catalogue", existing + ".missing", "--orders", ordersPath]), 3, "INPUT_READ_FAILED");
  assertFailure(run(["--catalogue", path.dirname(existing), "--orders", ordersPath]), 3, "INPUT_READ_FAILED");
});

test("JSON syntax errors identify the file without leaking contents", (t) => {
  const file = temporaryFile(t, '{"secret-recipient": "PRIVATE-SAMPLE",}');
  const result = run(["--catalogue", cataloguePath, "--orders", file, "--format", "json"]);
  assertFailure(result, 3, "INVALID_JSON");
  assert.ok(result.stderr.includes(file));
  assert.ok(!result.stderr.includes("PRIVATE-SAMPLE"));
  assert.throws(() => readJsonFile(file), (error) => error instanceof ManifestError && error.code === "INVALID_JSON");
});

test("UTF-8 BOM input and file paths with spaces work", (t) => {
  const file = temporaryFile(t, "\uFEFF" + JSON.stringify({ orders: [] }));
  const result = run(["--catalogue", cataloguePath, "--orders", file, "--format", "json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).totals.orders, 0);
  assert.deepEqual(readJsonFile(file), { orders: [] });
});

test("corrupt UTF-8 is rejected instead of changing a recipient's name", (t) => {
  const orders = readJsonFile(ordersPath);
  orders.orders[0].recipient = "CORRUPT_BYTE";
  const [before, after] = JSON.stringify(orders).split("CORRUPT_BYTE");
  const file = temporaryFile(t, Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]));
  assertFailure(run(["--catalogue", cataloguePath, "--orders", file]), 3, "INVALID_JSON");
  assert.throws(() => readJsonFile(file), /not valid UTF-8 JSON/);
});

test("escaped lone surrogates fail without output; valid Unicode reaches stdout intact", (t) => {
  for (const value of ["DON-\ud800", "DON-\udc00"]) {
    const orders = readJsonFile(ordersPath);
    orders.orders[2].id = value;
    const file = temporaryFile(t, JSON.stringify(orders));
    for (const format of ["text", "json"]) {
      const result = run(["--catalogue", cataloguePath, "--orders", file, "--format", format]);
      assertFailure(result, 3, "INVALID_INPUT");
      assert.match(result.stderr, /unpaired surrogates/);
    }
  }
  const orders = readJsonFile(ordersPath);
  orders.orders[0].recipient = "Example Pantry \ud83e\udde3";
  const file = temporaryFile(t, JSON.stringify(orders));
  for (const format of ["text", "json"]) {
    const result = run(["--catalogue", cataloguePath, "--orders", file, "--format", format]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(orders.orders[0].recipient));
  }
});

test("schema errors and late invalid lines never emit a partial result", async (t) => {
  const quantity = readJsonFile(ordersPath);
  quantity.orders[2].items[0].quantity = 1.25;
  const unknown = readJsonFile(ordersPath);
  unknown.orders[2].items[0].sku = "UNKNOWN";
  for (const document of [null, [], {}, { orders: {} }, quantity, unknown]) {
    const file = temporaryFile(t, JSON.stringify(document));
    for (const format of ["text", "json"]) {
      assertFailure(run(["--catalogue", cataloguePath, "--orders", file, "--format", format]), 3, "INVALID_INPUT");
    }
  }
});

test("output write failures exit 1 with a concise error", { skip: !existsSync("/dev/full") }, () => {
  const fd = openSync("/dev/full", "w");
  try {
    const result = run(args, { stdio: ["ignore", fd, "pipe"] });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OUTPUT_WRITE_FAILED/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    closeSync(fd);
  }
});
