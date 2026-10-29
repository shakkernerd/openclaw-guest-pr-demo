"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, closeSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createManifest, readJsonFile, formatReport, ManifestError } = require("..");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "bin/dispatch-manifest.js");
const cataloguePath = path.join(root, "examples/catalogue.json");
const ordersPath = path.join(root, "examples/orders.json");
const enoughPath = path.join(root, "examples/stock-enough.json");
const shortagePath = path.join(root, "examples/stock-shortage.json");
const args = ["--catalogue", cataloguePath, "--orders", ordersPath];

const enoughCheck = {
  hasShortages: false,
  items: [
    { sku: "BLANKET-FLEECE", requested: 2, available: 3, missing: 0 },
    { sku: "HYGIENE-KIT", requested: 6, available: 6, missing: 0 },
    { sku: "SOCK-ADULT", requested: 6, available: 10, missing: 0 },
  ],
};
const shortageCheck = {
  hasShortages: true,
  items: [
    { sku: "BLANKET-FLEECE", requested: 2, available: 1, missing: 1 },
    { sku: "HYGIENE-KIT", requested: 6, available: 4, missing: 2 },
    { sku: "SOCK-ADULT", requested: 6, available: 0, missing: 6 },
  ],
};

function manifest(stock) {
  return createManifest(readJsonFile(cataloguePath), readJsonFile(ordersPath), stock);
}

function run(extra = [], options = {}) {
  return spawnSync(process.execPath, [cli, ...args, ...extra], {
    encoding: "utf8", timeout: 10000, cwd: root, ...options,
  });
}

function temporaryFile(t, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), "dispatch-stock-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "stock with spaces.json");
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

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("no-stock CLI output remains byte-for-byte compatible with the original v1 sample", () => {
  // Captured from both real CLI formats before adding stock support.
  const hashes = {
    text: "068ab68da93ec9de34a614a034885cbea8bc9ea01d20f216a3c2aa4e3f3b24bd",
    json: "23be71d0f719a02a7f6c0925a02eb190c74a577cbe60df1cbafaf23b98246bda",
  };
  for (const format of ["text", "json"]) {
    const result = run(["--format", format]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(createHash("sha256").update(result.stdout).digest("hex"), hashes[format]);
  }
  assert.equal(Object.hasOwn(manifest(), "stockCheck"), false);
  assert.equal(Object.hasOwn(manifest(undefined), "stockCheck"), false);
});

test("enough stock adds only a stockCheck extension and leaves v1 fields unchanged", () => {
  const result = manifest(readJsonFile(enoughPath));
  const { stockCheck, ...originalFields } = result;
  assert.deepEqual(stockCheck, enoughCheck);
  assert.deepEqual(originalFields, manifest());
  assert.match(formatReport(result), /STOCK CHECK — ENOUGH STOCK/);
  assert.doesNotMatch(formatReport(result), /DO NOT PACK|\[SHORT\]/);
});

test("shortages compare whole-batch demand without allocating or reducing any orders", () => {
  const result = manifest(readJsonFile(shortagePath));
  const { stockCheck, ...originalFields } = result;
  assert.deepEqual(stockCheck, shortageCheck);
  assert.deepEqual(originalFields, manifest());
  const report = formatReport(result);
  assert.ok(report.indexOf("STOCK SHORTAGE — DO NOT PACK") < report.indexOf("PICK LIST"));
  assert.equal(report.match(/\[SHORT\]/g).length, 3);
  assert.ok(report.includes("SOCK-ADULT | Requested: 6 | Available: 0 | Missing: 6 [SHORT]"));
  assert.ok(report.includes("CARTON LABELS — PLANNING ONLY"));
  for (const order of result.orders) assert.ok(report.includes(order.carton.label));
});

test("one short SKU triggers a shortage even when other SKUs have a surplus", () => {
  const stock = readJsonFile(enoughPath);
  stock.items.find((item) => item.sku === "HYGIENE-KIT").quantity = 5;
  const result = manifest(stock).stockCheck;
  assert.equal(result.hasShortages, true);
  assert.deepEqual(result.items.map((item) => item.missing), [0, 1, 0]);
});

test("missing stock rows mean zero; empty snapshots are valid, not skipped", () => {
  const empty = manifest({ items: [] }).stockCheck;
  assert.equal(empty.hasShortages, true);
  assert.deepEqual(empty.items.map((item) => [item.requested, item.available, item.missing]), [[2, 0, 2], [6, 0, 6], [6, 0, 6]]);
  const sparse = manifest({ items: [{ sku: "SOCK-ADULT", quantity: 6 }] }).stockCheck;
  assert.deepEqual(sparse.items.map((item) => item.missing), [2, 6, 0]);
});

test("empty orders produce an empty successful stock check, while stock is still validated", () => {
  const catalogue = readJsonFile(cataloguePath);
  const result = createManifest(catalogue, { orders: [] }, { items: [] });
  assert.deepEqual(result.stockCheck, { hasShortages: false, items: [] });
  assert.match(formatReport(result), /No requested SKUs to check/);
  assert.throws(() => createManifest(catalogue, { orders: [] }, { items: [{ sku: "UNKNOWN", quantity: 0 }] }), /unknown SKU/);
});

test("stock checks are deterministic, independent of order priority, and do not mutate inputs", () => {
  const catalogue = freeze(readJsonFile(cataloguePath));
  const orders = freeze(readJsonFile(ordersPath));
  const stock = freeze(readJsonFile(shortagePath));
  const before = JSON.stringify({ catalogue, orders, stock });
  const result = createManifest(catalogue, orders, stock);
  const reversed = createManifest(catalogue, { orders: [...orders.orders].reverse() }, { items: [...stock.items].reverse() });
  assert.deepEqual(result.stockCheck, reversed.stockCheck);
  assert.deepEqual(result.orders, [...reversed.orders].reverse());
  result.stockCheck.items[0].available = 999;
  assert.equal(JSON.stringify({ catalogue, orders, stock }), before);
});

test("stock quantities accept zero and safe-integer boundaries without capping availability", () => {
  const catalogue = readJsonFile(cataloguePath);
  const orders = readJsonFile(ordersPath);
  orders.orders = [orders.orders[0]];
  orders.orders[0].items = [{ sku: "SOCK-ADULT", quantity: Number.MAX_SAFE_INTEGER }];
  const stock = { items: [{ sku: "SOCK-ADULT", quantity: Number.MAX_SAFE_INTEGER - 1 }] };
  assert.equal(createManifest(catalogue, orders, stock).stockCheck.items[0].missing, 1);
  stock.items[0].quantity = Number.MAX_SAFE_INTEGER;
  orders.orders[0].items[0].quantity = 1;
  assert.deepEqual(createManifest(catalogue, orders, stock).stockCheck.items[0], {
    sku: "SOCK-ADULT", requested: 1, available: Number.MAX_SAFE_INTEGER, missing: 0,
  });
  stock.items[0].quantity = -0;
  assert.equal(createManifest(catalogue, orders, stock).stockCheck.items[0].available, 0);
});

test("invalid stock quantities are rejected without coercion", async (t) => {
  for (const quantity of [-1, 0.5, "0", "6", "", true, null, undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(quantity), () => {
      assert.throws(() => manifest({ items: [{ sku: "SOCK-ADULT", quantity }] }), (error) => {
        assert.ok(error instanceof ManifestError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.equal(error.exitCode, 3);
        assert.match(error.message, /stock\.items\[0\]\.quantity: must be a non-negative safe whole number/);
        return true;
      });
    });
  }
});

test("invalid stock shapes, SKUs and duplicates are rejected, including unused rows", async (t) => {
  const cases = [
    [null, /stock: must be an object/],
    [[], /stock: must be an object/],
    ["stock", /stock: must be an object/],
    [{}, /stock.items: must be an array/],
    [{ items: null }, /stock.items: must be an array/],
    [{ items: {} }, /stock.items: must be an array/],
    [{ items: [null] }, /stock.items\[0\]: must be an object/],
    [{ items: [{}] }, /\.sku: must be a non-empty string/],
    [{ items: [{ sku: "UNKNOWN", quantity: 1 }] }, /unknown SKU/],
    [{ items: [{ sku: "sock-adult", quantity: 1 }] }, /unknown SKU/],
    [{ items: [{ sku: "SOCK-ADULT ", quantity: 1 }] }, /leading or trailing whitespace/],
    [{ items: [{ sku: "SOCK\nADULT", quantity: 1 }] }, /control characters/],
    [{ items: [{ sku: "\ud800", quantity: 1 }] }, /valid Unicode/],
    [{ items: [{ sku: "MUG-REUSABLE", quantity: -1 }] }, /\.quantity/],
    [{ items: [{ sku: "MUG-REUSABLE", quantity: 0 }, { sku: "MUG-REUSABLE", quantity: 1 }] }, /duplicate SKU/],
  ];
  for (const [stock, message] of cases) {
    await t.test(JSON.stringify(stock), () => assert.throws(() => manifest(stock), message));
  }
});

test("real CLI enough-stock and shortage reports have complete stdout and distinct exit codes", () => {
  for (const [stockPath, expected, status] of [[enoughPath, enoughCheck, 0], [shortagePath, shortageCheck, 4]]) {
    const before = readFileSync(stockPath, "utf8");
    for (const format of ["text", "json"]) {
      const result = run(["--stock", stockPath, "--format", format]);
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, status, result.stderr);
      assert.equal(result.stderr, "");
      if (format === "json") {
        const { stockCheck, ...originalFields } = JSON.parse(result.stdout);
        assert.deepEqual(stockCheck, expected);
        assert.deepEqual(originalFields, manifest());
        assert.ok(result.stdout.endsWith("\n"));
      } else {
        assert.equal(result.stdout, formatReport(manifest(readJsonFile(stockPath))));
      }
    }
    assert.equal(readFileSync(stockPath, "utf8"), before);
  }
});

test("stock CLI supports equals syntax and paths containing spaces", (t) => {
  const file = temporaryFile(t, JSON.stringify(readJsonFile(enoughPath)));
  const result = run(["--stock=" + file, "--format=json"], { cwd: tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).stockCheck, enoughCheck);
});

test("stock usage errors are distinct from input errors and shortages", () => {
  for (const extra of [["--stock"], ["--stock="], ["--stock", " "], ["--stock", enoughPath, "--stock", shortagePath]]) {
    assertFailure(run(extra), 2, "USAGE");
  }
});

test("malformed or unreadable stock never emits a report", (t) => {
  const malformed = temporaryFile(t, '{"items": [}');
  const invalid = temporaryFile(t, JSON.stringify({ items: [{ sku: "SOCK-ADULT", quantity: -1 }] }));
  const unknown = temporaryFile(t, JSON.stringify({ items: [{ sku: "UNKNOWN", quantity: 0 }] }));
  const nullFile = temporaryFile(t, "null");
  for (const format of ["text", "json"]) {
    assertFailure(run(["--stock", malformed, "--format", format]), 3, "INVALID_JSON");
    for (const file of [invalid, unknown, nullFile]) {
      assertFailure(run(["--stock", file, "--format", format]), 3, "INVALID_INPUT");
    }
    assertFailure(run(["--stock", malformed + ".missing", "--format", format]), 3, "INPUT_READ_FAILED");
  }
});

test("output failure takes precedence over stock shortage exit code", { skip: !existsSync("/dev/full") }, () => {
  const fd = openSync("/dev/full", "w");
  try {
    const result = run(["--stock", shortagePath, "--format", "json"], { stdio: ["ignore", fd, "pipe"] });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OUTPUT_WRITE_FAILED/);
  } finally {
    closeSync(fd);
  }
});
