"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const cli = path.join(__dirname, "packaging-cli.js");
const order = { items: [{ sku: "B", quantity: 2 }, { sku: "A", quantity: 3 }, { sku: "B", quantity: 4 }], maxItemsPerBox: 4 };
const header = "box,sku,quantity\r\n";
const mixed = header + "1,B,4\r\n2,B,2\r\n2,A,2\r\n3,A,1\r\n";
const singleSku = header + "1,B,4\r\n2,B,2\r\n3,A,3\r\n";

function run(args, input = JSON.stringify(order), options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", timeout: 5000, ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function succeeds(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, expected);
}

function fails(result, status, message) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
}

function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-csv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("CSV emits existing box/SKU entries in order in both modes from stdin and files", () => {
  succeeds(run(["--csv"]), mixed);
  for (const [mode, expected] of [["mixed", mixed], ["single-sku", singleSku]]) {
    succeeds(run(["-", "--mode", mode, "--csv"]), expected);
    succeeds(run(["--csv", "--mode", mode]), expected);
    succeeds(run([path.join(__dirname, "examples/order.json"), "--csv", "--mode", mode], "ignored"), expected);
  }
});

test("CSV keeps zero-row first appearances and omits empty/all-zero contents", () => {
  for (const mode of ["mixed", "single-sku"]) {
    for (const items of [[], [{ sku: "A", quantity: 0 }, { sku: "B", quantity: 0 }]]) {
      succeeds(run(["--csv", "--mode", mode], JSON.stringify({ items, maxItemsPerBox: 3 })), header);
    }
    const items = [{ sku: "B", quantity: 0 }, { sku: "A", quantity: 1 }, { sku: "B", quantity: 2 }];
    succeeds(run(["--csv", "--mode", mode], JSON.stringify({ items, maxItemsPerBox: 2 })),
      header + "1,B,2\r\n2,A,1\r\n");
  }
});

test("CSV respects --, filenames with spaces, and options after filenames outside the repository", t => {
  const dir = directory(t);
  for (const name of ["--csv", "order file.json"]) writeFileSync(path.join(dir, name), JSON.stringify(order));
  succeeds(run(["--csv", "--", "--csv"], "ignored", { cwd: dir }), mixed);
  succeeds(run(["order file.json", "--csv", "--mode", "single-sku"], "ignored", { cwd: dir }), singleSku);
  // After --, a CSV-looking filename is not an output option.
  const text = run(["--", "--csv"], "ignored", { cwd: dir });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^Packing plan:/);
});

test("CSV bytes are UTF-8 without a BOM and preserve exact SKUs with correct quoting", () => {
  const samples = [
    ["plain", "plain"], ["a,b", '"a,b"'], ['a"b', '"a""b"'],
    ["line\nnext", '"line\nnext"'], ["line\rnext", '"line\rnext"'],
    ["line\r\nnext", '"line\r\nnext"'], ['a,"\r\nb', '"a,""\r\nb"'],
    [" 00123 ", " 00123 "], ["=1+1", "=1+1"], ["+123", "+123"],
    ["-123", "-123"], ["@name", "@name"], ["\t=1+1", "\t=1+1"],
    ["café 📦", "café 📦"], ["\u0000\u001b\u0085\u2028\u2029", "\u0000\u001b\u0085\u2028\u2029"],
    ["\ufeffSKU", "\ufeffSKU"],
  ];
  const input = JSON.stringify({ items: samples.map(([sku]) => ({ sku, quantity: 1 })), maxItemsPerBox: 1 });
  const expected = header + samples.map(([, field], index) => (index + 1) + "," + field + ",1\r\n").join("");
  const result = run(["--csv"], input, { encoding: null });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  assert.deepEqual(result.stdout, Buffer.from(expected, "utf8"));
  succeeds(run(["--csv"], '{"items":[{"sku":"\\ud83d\\udce6","quantity":1}],"maxItemsPerBox":1}'), header + "1,📦,1\r\n");
});

test("CSV rejects unpaired surrogates before any stdout, with input index and source", t => {
  const dir = directory(t);
  // Match the Windows-safe/POSIX-special filename convention in packaging-cli.test.js.
  const name = process.platform === "win32" ? "bad sku.json" : 'bad "sku"\n.json';
  const file = path.join(dir, name);
  for (const sku of ["\ud800", "\udfff", "A\ud800B", "\udc00\ud800", "📦\ud800", "\ud800📦"]) {
    for (const quantity of [0, 1]) {
      const input = JSON.stringify({ items: [{ sku: "valid", quantity: 1 }, { sku, quantity }], maxItemsPerBox: 1 });
      writeFileSync(file, input);
      for (const mode of ["mixed", "single-sku"]) {
        for (const [source, label] of [[[], "standard input"], [["-"], "standard input"], [[file], JSON.stringify(file)]]) {
          const result = run(["--csv", "--mode", mode, ...source], input);
          fails(result, 1, /items\[1\]\.sku.*unpaired UTF-16 surrogate/);
          assert.ok(result.stderr.startsWith("packaging: " + label + ": "));
        }
      }
    }
  }
});

test("CSV validates only effective SKU fields, not ignored or overwritten values", () => {
  const input = '{"items":[{"sku":"\\ud800","sku":"valid","quantity":1,"extra":"\\udfff"}],"maxItemsPerBox":1,"extra":{"sku":"\\ud800"}}';
  succeeds(run(["--csv"], input), header + "1,valid,1\r\n");
  succeeds(run(["--csv"], '{"items":[{"sku":"\\ud800","quantity":1}],"items":[],"maxItemsPerBox":1}'), header);
});

test("existing text, JSON and summaries still accept and preserve unpaired SKU surrogates", () => {
  const input = JSON.stringify({ items: [{ sku: "\ud800", quantity: 1 }], maxItemsPerBox: 2 });
  for (const mode of ["mixed", "single-sku"]) {
    const args = ["--mode", mode];
    succeeds(run(args, input), "Packing plan: 1 item in 1 box (capacity: 2 items per box)\n" +
      (mode === "single-sku" ? "Mode: single-sku (one SKU per box)\n" : "") + 'Box 1: 1 item\n  "\\ud800": 1\n');
    const expectedPlan = { maxItemsPerBox: 2, totalItems: 1, boxes: [{ contents: [{ sku: "\ud800", quantity: 1 }], totalItems: 1 }] };
    if (mode === "single-sku") expectedPlan.mode = mode;
    succeeds(run([...args, "--json"], input), JSON.stringify(expectedPlan, null, 2) + "\n");
    succeeds(run([...args, "--summary"], input), "Mode: " + mode + " | Capacity: 2\n1 item | 1 box: 0 full, 1 partial | 1 unused item slot\n");
    const expectedSummary = { mode, maxItemsPerBox: 2, totalItems: 1, boxCount: 1, fullBoxes: 0, partialBoxes: 1, unusedItemSlots: "1" };
    succeeds(run([...args, "--summary", "--json"], input), JSON.stringify(expectedSummary, null, 2) + "\n");
  }
});

test("CSV conflicts and repeats are argument errors before input is read", t => {
  const missing = path.join(directory(t), "missing.json");
  for (const args of [["--csv", "--json"], ["--json", "--csv"], ["--csv", "--summary"],
    ["--summary", "--csv"], ["--csv", "--csv"], ["--summary", "--csv", "--json"]]) {
    for (const source of [[], [missing]]) {
      const result = run([...source, ...args], "not JSON");
      fails(result, 2, /packaging: .*--csv/);
      assert.match(result.stderr, /cannot be combined|repeated option/);
      assert.doesNotMatch(result.stderr, /cannot read input|input must contain/);
    }
  }
  for (const args of [["--csv=true"], ["--csv", "--help"]]) fails(run(args), 2, /option/);
});

test("CSV uses the existing exact-number parser and source-aware input diagnostics", t => {
  const file = path.join(directory(t), "order.json");
  const samples = [
    ['{"items":[{"sku":"A","quantity":1.0000000000000001}],"maxItemsPerBox":3}', /items\[0\]\.quantity/],
    ['{"items":[],"maxItemsPerBox":2.9999999999999999}', /maxItemsPerBox/],
    ['{"items":[{"sku":"A","quantity":1e-400}],"maxItemsPerBox":3}', /quantity/],
    ['{"items":[{"sku":"A","quantity":"1"}],"maxItemsPerBox":3}', /quantity/],
    ['{broken PRIVATE ORDER', /input must contain one valid JSON order/],
  ];
  for (const [input, diagnostic] of samples) {
    writeFileSync(file, input);
    for (const mode of ["mixed", "single-sku"]) {
      for (const source of [[], ["-"], [file]]) {
        const csv = run(["--csv", "--mode", mode, ...source], input);
        const json = run(["--json", "--mode", mode, ...source], input);
        fails(csv, 1, diagnostic);
        assert.equal(csv.stderr, json.stderr);
        assert.doesNotMatch(csv.stderr, /PRIVATE ORDER/);
      }
    }
  }
  for (const mode of ["mixed", "single-sku"]) {
    succeeds(run(["--csv", "--mode", mode], '{"items":[{"sku":"A","quantity":300e-2}],"maxItemsPerBox":3.0}'), header + "1,A,3\r\n");
    succeeds(run(["--csv", "--mode", mode], '{"items":[{"sku":"A","quantity":9007199254740991.0}],"maxItemsPerBox":9.007199254740991e15}'), header + "1,A,9007199254740991\r\n");
  }
  fails(run(["--csv", path.join(path.dirname(file), "missing.json")]), 1, /cannot read input \(ENOENT\)/);
});

test("CSV keeps detailed-plan limits while summaries still handle huge orders", () => {
  const huge = JSON.stringify({ items: [{ sku: "A", quantity: Number.MAX_SAFE_INTEGER }], maxItemsPerBox: 1 });
  for (const mode of ["mixed", "single-sku"]) {
    fails(run(["--csv", "--mode", mode], huge), 1, /100000 boxes/);
    const summary = run(["--summary", "--json", "--mode", mode], huge);
    assert.equal(summary.status, 0);
    assert.equal(summary.stderr, "");
    assert.equal(JSON.parse(summary.stdout).boxCount, Number.MAX_SAFE_INTEGER);
    assert.ok(summary.stdout.length < 400);
  }
  // Mixed mode needs 100000 boxes, single-SKU needs 100001: preserve the mode-specific guard.
  const input = JSON.stringify({ items: [{ sku: "A", quantity: 149999 }, { sku: "B", quantity: 149999 }, { sku: "C", quantity: 2 }], maxItemsPerBox: 3 });
  fails(run(["--csv", "--mode", "single-sku"], input), 1, /100000 boxes/);
});

test("CSV output drains beyond a pipe buffer without truncation", () => {
  const count = 12000;
  const input = JSON.stringify({ items: [{ sku: "A", quantity: count }], maxItemsPerBox: 1 });
  const expected = header + Array.from({ length: count }, (_, index) => (index + 1) + ",A,1\r\n").join("");
  assert.ok(Buffer.byteLength(expected) > 65536);
  succeeds(run(["--csv"], input), expected);
});

test("CSV broken pipes retain a nonzero exit and clean output diagnostic", { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [cli, "--csv"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal }));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.destroy();
  child.stdin.end(JSON.stringify(order));
  const result = await completed;
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(stderr, /^packaging: cannot write output \(EPIPE\)\n$/);
});

test("CSV is documented in help and module imports remain silent", () => {
  const help = run(["--help"], "not JSON");
  assert.equal(help.status, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--csv.*detailed.*CSV/);
  assert.match(help.stdout, /--csv.*--json.*--summary/);
  const imported = spawnSync(process.execPath, ["-e", "require('./packaging.js'); require('./packaging-cli.js');"], {
    cwd: __dirname, input: "not JSON", encoding: "utf8", timeout: 5000,
  });
  assert.ifError(imported.error);
  succeeds(imported, "");
});
