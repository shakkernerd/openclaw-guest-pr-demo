"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { parseJsonInput } = require("../lib/json-input.js");
const { createManifest, readJsonFile, ManifestError } = require("..");

const root = path.resolve(__dirname, "..");
const catalogue = path.join(root, "examples/catalogue.json");
const orders = path.join(root, "examples/orders.json");
const checks = path.join(root, "examples/input-checks");
const roundedOrders = readFileSync(path.join(checks, "orders-rounded-fraction.json"), "utf8");
const roundedStock = readFileSync(path.join(checks, "stock-rounded-fraction.json"), "utf8");
const duplicateOrders = readFileSync(path.join(checks, "orders-duplicate-member.json"), "utf8");
const backslash = String.fromCharCode(92);

function temporaryFile(t, source) {
  const directory = mkdtempSync(path.join(tmpdir(), "dispatch-input-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "input.json");
  writeFileSync(file, source);
  return file;
}

function run(inputFlag, file, format) {
  const inputs = { catalogue, orders, [inputFlag]: file };
  const args = Object.entries(inputs).flatMap(([name, value]) => ["--" + name, value]);
  return spawnSync(process.execPath, [path.join(root, "bin/dispatch-manifest.js"), ...args, "--format", format], {
    cwd: root, encoding: "utf8", timeout: 10000,
  });
}

function assertInputFailure(result, code) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.startsWith("dispatch-manifest: " + code + ":"), result.stderr);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
}

test("Node provides original numeric source even after Number rounding", () => {
  const result = JSON.parse('{"quantity":1.0000000000000001}', (key, value, context) => {
    return key === "quantity" ? { value, source: context.source } : value;
  });
  assert.deepEqual(result, { quantity: { value: 1, source: "1.0000000000000001" } });
});

test("file quantities reject decimal and exponent notation, not only visible fractions", async (t) => {
  for (const token of ["1.0000000000000001", "1.5", "1.0", "0.0", "-0.0", "1e0", "10e-1", "1E+0", "1e-400", "1e400", "9007199254740990.5"]) {
    await t.test(token, () => {
      assert.throws(() => parseJsonInput('{"quantity":' + token + '}', "test.json"), (error) => {
        assert.ok(error instanceof ManifestError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.equal(error.exitCode, 3);
        assert.match(error.message, /quantity must use plain integer notation/);
        return true;
      });
    });
  }
});

test("plain integer tokens pass notation checks; schema validation still checks sign/range/type", () => {
  for (const token of ["0", "-0", "1", "12", "-1", "9007199254740991", "9007199254740992"]) {
    const source = '{"quantity":' + token + '}';
    assert.deepEqual(parseJsonInput(source, "test.json"), JSON.parse(source));
  }
  // The loader does not claim to validate arbitrary document shapes or ranges.
  for (const token of ['"1"', "null", "true", "[]", "{}"]) {
    const source = '{"quantity":' + token + '}';
    assert.deepEqual(parseJsonInput(source, "test.json"), JSON.parse(source));
  }
});

test("duplicate members are rejected at every object scope, including escaped names", async (t) => {
  const cases = [
    duplicateOrders,
    '{"quantity":1,"quantity":2}',
    '{"address":{"country":"UK","country":"France"}}',
    '{"items":[{"sku":"A","sku":"B"}]}',
    '{"a":[],"child":{"a":1},"a":[]}',
    '{"orders":[],"' + backslash + 'u006frders":[]}',
    '{"ignored":{"x":1,"x":1}}',
    '{"":1,"":2}',
    '{"__proto__":1,"__proto__":2}',
    '{"constructor":1,"constructor":2}',
  ];
  for (const source of cases) {
    await t.test(source.slice(0, 70), () => {
      assert.throws(() => parseJsonInput(source, "test.json"), (error) => {
        assert.ok(error instanceof ManifestError);
        assert.equal(error.code, "DUPLICATE_MEMBER");
        assert.equal(error.exitCode, 3);
        assert.match(error.message, /near character/);
        return true;
      });
    });
  }
});

test("scope checking ignores punctuation inside strings and permits names in separate objects", () => {
  const unusual = ['"', backslash, '"orders":[],"orders":[]', '{}[]:', "\n\t", "é", "e\u0301", "😀", "", "__proto__"];
  for (const value of unusual) {
    const document = {
      [value]: { id: value },
      rows: [{ sku: value, quantity: 1 }, { sku: value, quantity: 2 }],
      text: value + backslash + '"}]:{',
    };
    const source = JSON.stringify(document);
    assert.deepEqual(parseJsonInput(source, "test.json"), JSON.parse(source));
    const key = JSON.stringify(value);
    assert.throws(() => parseJsonInput("{" + key + ":1," + key + ":2}", "test.json"), /duplicate JSON member/);
  }
  assert.deepEqual(parseJsonInput('{"a":{"id":1},"b":{"id":2}}', "test.json"), { a: { id: 1 }, b: { id: 2 } });
});

test("decoded quantity member names and ignored metadata follow the documented file rules", () => {
  assert.throws(() => parseJsonInput('{"' + backslash + 'u0071uantity":1.0000000000000001}', "test.json"), /plain integer notation/);
  assert.throws(() => parseJsonInput('{"metadata":{"quantity":1.0}}', "test.json"), /plain integer notation/);
  // Other, unused numeric metadata retains ordinary JSON.parse Number semantics.
  assert.deepEqual(parseJsonInput('{"weight":1.0000000000000001}', "test.json"), { weight: 1 });
});

test("JSON syntax checking stays with Node rather than the duplicate-name scanner", () => {
  for (const source of ['{"x":1,}', '{"x":1 "x":2}', '{"quantity":01}', '{"quantity":+1}', '{"quantity":NaN}', '{"text":"unterminated}', '/* comment */ {}']) {
    assert.throws(() => parseJsonInput(source, "test.json"), SyntaxError);
  }
});

test("raw-file CLI rejects rounded, fractional and non-plain quantity spellings in orders and stock", (t) => {
  for (const token of ["1.0000000000000001", "1.5", "1.0", "1e0", "1e-400"]) {
    for (const [flag, template, marker] of [["orders", roundedOrders, "1.0000000000000001"], ["stock", roundedStock, "6.0000000000000001"]]) {
      const file = temporaryFile(t, template.replace(marker, token));
      for (const format of ["text", "json"]) {
        assertInputFailure(run(flag, file, format), "INVALID_INPUT");
      }
    }
  }
});

test("real CLI rejects duplicate members in orders, catalogue and stock without a partial report", (t) => {
  const sources = [
    ["orders", duplicateOrders],
    ["orders", '{"orders":[],"' + backslash + 'u006frders":[]}'],
    ["catalogue", '{"items":[],"items":[{"sku":"HYGIENE-KIT","name":"Kit"}]}'],
    ["stock", '{"items":[{"sku":"HYGIENE-KIT","quantity":4,"quantity":6}]}'],
  ];
  for (const [flag, source] of sources) {
    const file = temporaryFile(t, source);
    for (const format of ["text", "json"]) {
      assertInputFailure(run(flag, file, format), "DUPLICATE_MEMBER");
    }
  }
});

test("real CLI still enforces quantity sign/range and permits stock zero", (t) => {
  for (const token of ["0", "-1", "9007199254740992", '"1"']) {
    const file = temporaryFile(t, roundedOrders.replace("1.0000000000000001", token));
    assertInputFailure(run("orders", file, "json"), "INVALID_INPUT");
  }
  for (const token of ["-1", "9007199254740992", '"0"']) {
    const file = temporaryFile(t, roundedStock.replace("6.0000000000000001", token));
    assertInputFailure(run("stock", file, "json"), "INVALID_INPUT");
  }
  for (const token of ["0", "-0"]) {
    const file = temporaryFile(t, roundedStock.replace("6.0000000000000001", token));
    const result = run("stock", file, "json");
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).stockCheck.items.find((item) => item.sku === "HYGIENE-KIT"), {
      sku: "HYGIENE-KIT", requested: 6, available: 0, missing: 6,
    });
  }
});

test("already-parsed library input cannot recover lost numeric precision or duplicate members", () => {
  const parsedOrders = JSON.parse(roundedOrders);
  assert.equal(parsedOrders.orders[0].items[0].quantity, 1);
  assert.equal(createManifest(readJsonFile(catalogue), parsedOrders).totals.units, 1);
  assert.equal(createManifest(readJsonFile(catalogue), JSON.parse(duplicateOrders)).totals.orders, 0);
  // Use readJsonFile for source-level checks, not JSON.parse followed by createManifest.
  assert.throws(() => readJsonFile(path.join(checks, "orders-rounded-fraction.json")), /plain integer notation/);
  assert.throws(() => readJsonFile(path.join(checks, "orders-duplicate-member.json")), /duplicate JSON member/);
});
