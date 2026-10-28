"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

function run(name, args, input, options = {}) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
    input, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
const single = (args, input, options) => run("packaging-cli.js", args, input, options);
const batch = (args, input, options) => run("packaging-batch-cli.js", args, input, options);
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}
function summaries(totalItems, capacity, mixedBoxes, singleBoxes) {
  return Object.fromEntries([["mixed", mixedBoxes], ["single-sku", singleBoxes]].map(([mode, boxCount]) => [mode, {
    mode, maxItemsPerBox: capacity, totalItems, boxCount, fullBoxes: 0,
    partialBoxes: boxCount, unusedItemSlots: String(BigInt(boxCount) * BigInt(capacity) - BigInt(totalItems)),
  }]));
}

test("both entry points retain effective-key exact numbers and ignore deep overwritten data", () => {
  const deep = '['.repeat(3000) + '1e-400' + ']'.repeat(3000);
  const input = '{"items":' + deep + ',"items":[{"sku":"B","quantity":-0},{"sku":"A","quantity":1e-400,"quanti\\u0074y":300e-2},{"sku":"B","quantity":1.0}],"maxItemsPerBox":2.9999999999999999,"maxItemsPer\\u0042ox":5e0,"extra":' + deep + '}';
  const expected = summaries(4, 5, 1, 2);
  assert.deepEqual(JSON.parse(success(single(["--compare", "--json"], input))), expected);
  assert.equal(success(batch([], input)), JSON.stringify({ line: 1, ...expected }) + '\n');
  for (const mode of ["mixed", "single-sku"]) {
    assert.equal(success(single(["--check", "--mode", mode], input)), "");
    assert.deepEqual(JSON.parse(success(single(["--summary", "--json", "--mode", mode], input))), expected[mode]);
  }
  // Zero-quantity first appearance still controls detailed ordering, not object-key order.
  assert.equal(success(single(["--csv"], input)), 'box,sku,quantity\r\n1,B,1\r\n1,A,3\r\n');
  assert.equal(success(single(["--csv", "--mode", "single-sku"], input)), 'box,sku,quantity\r\n1,B,1\r\n2,A,3\r\n');
});

test("CSV-only surrogate rejection never reaches the shared parser or batch summaries", () => {
  for (const quantity of [0, 1]) {
    const input = JSON.stringify({ items: [{ sku: '\ud800', quantity }], maxItemsPerBox: 2 });
    const expected = summaries(quantity, 2, quantity, quantity);
    assert.equal(success(batch([], input)), JSON.stringify({ line: 1, ...expected }) + '\n');
    assert.deepEqual(JSON.parse(success(single(["--compare", "--json"], input))), expected);
    for (const mode of ["mixed", "single-sku"]) {
      assert.equal(success(single(["--check", "--mode", mode], input)), "");
      const csv = single(["--csv", "--mode", mode], input);
      assert.equal(csv.status, 1);
      assert.equal(csv.stdout, "");
      assert.equal(csv.stderr, 'packaging: standard input: items[0].sku contains an unpaired UTF-16 surrogate; CSV requires well-formed Unicode\n');
    }
  }
});

test("shared failures keep separate source context and batch continues to a clean EOF successor", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-entrypoints-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, process.platform === "win32" ? "order file.json" : 'order "file"\n.json');
  const good = '{"items":[{"sku":"A","quantity":1},{"sku":"B","quantity":1}],"maxItemsPerBox":4}';
  const expected = summaries(2, 4, 1, 2);
  const invalid = [
    ['{PRIVATE ORDER', 'input must contain one valid JSON order'],
    ['null', 'order must be an object with items and maxItemsPerBox'],
    ['{"items":[{"sku":"A","quantity":1.0000000000000001}],"maxItemsPerBox":4}', 'items[0].quantity must be a non-negative safe integer'],
    ['{"items":[{"sku":"A","quantity":1e-400}],"maxItemsPerBox":4}', 'items[0].quantity must be a non-negative safe integer'],
    ['{"items":[],"maxItemsPerBox":2.9999999999999999}', 'maxItemsPerBox must be a positive safe integer'],
    ['{"items":[{"sku":"A","quantity":9007199254740991},{"sku":"B","quantity":1}],"maxItemsPerBox":4}', 'total item count must be a safe integer'],
  ];
  for (const [bad, detail] of invalid) {
    writeFileSync(file, bad);
    for (const args of [["--check"], ["--csv"], ["--compare", "--json"]]) {
      for (const source of [[], [file]]) {
        const r = single([...args, ...source], source.length ? 'ignored' : bad);
        assert.equal(r.status, 1);
        assert.equal(r.stdout, "");
        assert.equal(r.stderr, 'packaging: ' + (source.length ? JSON.stringify(file) : 'standard input') + ': ' + detail + '\n');
      }
    }
    // Blank, bad, then valid without LF: physical line numbers and clean tail matter.
    const input = ' \t\r\n' + bad + '\n' + good;
    writeFileSync(file, input);
    for (const source of [[], [file]]) {
      const r = batch(source, source.length ? 'ignored' : input);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, JSON.stringify({ line: 3, ...expected }) + '\n');
      assert.equal(r.stderr, 'packaging-batch: ' + (source.length ? JSON.stringify(file) : 'standard input') + ': line 2: ' + detail + '\n');
      assert.doesNotMatch(r.stderr, /PRIVATE ORDER|\n\s+at /);
    }
  }
});

test("batch rejects all single-order reporting flags before reading open stdin", { timeout: 15000 }, async t => {
  for (const flag of ["--csv", "--check", "--json", "--summary", "--compare"]) {
    const child = spawn(process.execPath, [path.join(__dirname, "packaging-batch-cli.js"), flag], {
      stdio: ["pipe", "pipe", "pipe"], timeout: 2000,
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    // Deliberately neither write nor end stdin.
    const result = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status, signal) => resolve({ status, signal }));
    });
    assert.equal(result.signal, null);
    assert.equal(result.status, 2);
    assert.equal(stdout, "");
    assert.ok(stderr.startsWith('packaging-batch: unknown option ' + JSON.stringify(flag) + '\nUsage:'));
  }
});

test("batch LF transport stays separate from single-order whole-document whitespace", () => {
  const input = '{\n"items":[],\n"maxItemsPerBox":4\n}';
  assert.equal(success(single(["--check"], input)), "");
  const r = batch([], input);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.deepEqual([...r.stderr.matchAll(/: line (\d+):/g)].map(m => Number(m[1])), [1, 2, 3, 4]);
  const bareCR = input.replaceAll('\n', '\r');
  assert.equal(success(single(["--check"], bareCR)), "");
  assert.equal(success(batch([], bareCR)), JSON.stringify({ line: 1, ...summaries(0, 4, 0, 0) }) + '\n');
});
