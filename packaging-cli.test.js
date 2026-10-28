"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const cli = path.join(__dirname, "packaging-cli.js");
const order = { items: [{ sku: "B", quantity: 2 }, { sku: "A", quantity: 3 }, { sku: "B", quantity: 4 }], maxItemsPerBox: 4 };
const expected = { maxItemsPerBox: 4, totalItems: 9, boxes: [
  { contents: [{ sku: "B", quantity: 4 }], totalItems: 4 },
  { contents: [{ sku: "B", quantity: 2 }, { sku: "A", quantity: 2 }], totalItems: 4 },
  { contents: [{ sku: "A", quantity: 1 }], totalItems: 1 },
] };

function run(args = [], input = JSON.stringify(order), options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", timeout: 5000, ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function fails(result, code, message) {
  assert.equal(result.status, code);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^packaging: /);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
}

test("CLI JSON from implicit and explicit stdin has real success exit status", () => {
  for (const args of [["--json"], ["-", "--json"]]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.ok(result.stdout.endsWith("\n"));
  }
});

test("CLI reads JSON files, works outside repository, and accepts -- for dashed filenames", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "order file.json"), JSON.stringify(order));
  writeFileSync(path.join(dir, "--order.json"), JSON.stringify(order));
  for (const args of [["--json", "order file.json"], ["--json", "--", "--order.json"]]) {
    const result = run(args, "not JSON on stdin", { cwd: dir });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test("CLI default text lists totals, capacity, each box and quantities", () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    "Packing plan: 9 items in 3 boxes (capacity: 4 items per box)",
    "Box 1: 4 items", '  "B": 4',
    "Box 2: 4 items", '  "B": 2', '  "A": 2',
    "Box 3: 1 item", '  "A": 1', "",
  ].join("\n"));
});

test("CLI handles empty and single-item orders; escapes SKU control characters in text", () => {
  const empty = run([], JSON.stringify({ items: [], maxItemsPerBox: 2 }));
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /0 items in 0 boxes/);
  assert.match(empty.stdout, /No boxes needed/);
  const single = run([], JSON.stringify({ items: [{ sku: 'line\n\u001b"', quantity: 1 }], maxItemsPerBox: 1 }));
  assert.equal(single.status, 0);
  assert.match(single.stdout, /1 item in 1 box \(capacity: 1 item per box\)/);
  assert.ok(single.stdout.includes('  "line\\n\\u001b\\\"": 1\n'));
});

test("CLI help is successful without reading input", () => {
  for (const arg of ["--help", "-h"]) {
    const result = run([arg], "not JSON");
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Usage:.*packaging-cli\.js/);
    assert.match(result.stdout, /--json/);
    assert.match(result.stdout, /stdin|standard input/i);
  }
});

test("CLI rejects unknown, repeated, missing-value, and extra arguments before reading input", () => {
  for (const args of [["--wat"], ["-j"], ["--json=true"], ["a.json", "b.json"],
    ["--json", "--json"], ["--file"], ["--help", "--wat"]]) {
    fails(run(args, "not JSON"), 2, /argument|option|Usage/i);
  }
});

test("CLI reports missing files and directory reads cleanly", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fails(run([path.join(dir, "missing.json")]), 1, /read|ENOENT/i);
  fails(run([dir]), 1, /read|EISDIR/i);
});

test("CLI rejects malformed JSON and invalid top-level order shapes", () => {
  for (const input of ["", "{", '{"items": [],}', "{} {}"]) {
    fails(run([], input), 1, /JSON/);
  }
  for (const input of ["null", "[]", "42", '"text"']) {
    fails(run([], input), 1, /order.*object/i);
  }
  for (const value of [{}, { items: [] }, { items: null, maxItemsPerBox: 2 }]) {
    fails(run([], JSON.stringify(value)), 1, /items|maxItemsPerBox/);
  }
});

test("CLI rejects invalid, overflowing, and impractically large numeric orders", () => {
  for (const quantity of [-1, 1.5, "2", null, 9007199254740992]) {
    fails(run(["--json"], JSON.stringify({ items: [{ sku: "A", quantity }], maxItemsPerBox: 2 })), 1, /quantity/);
  }
  for (const maxItemsPerBox of [0, -1, 1.5, "2", null, 9007199254740992]) {
    fails(run([], JSON.stringify({ items: [], maxItemsPerBox })), 1, /maxItemsPerBox/);
  }
  fails(run([], '{"items":[{"sku":"A","quantity":1e309}],"maxItemsPerBox":2}'), 1, /quantity/);
  fails(run([], JSON.stringify({ items: [{ sku: "A", quantity: Number.MAX_SAFE_INTEGER }, { sku: "B", quantity: 1 }], maxItemsPerBox: 2 })), 1, /total.*safe integer/i);
  fails(run([], JSON.stringify({ items: [{ sku: "A", quantity: Number.MAX_SAFE_INTEGER }], maxItemsPerBox: 1 })), 1, /100000 boxes/);
});

test("CLI writes complete output beyond a pipe buffer before exiting", () => {
  const result = run(["--json"], JSON.stringify({ items: [{ sku: "A", quantity: 2000 }], maxItemsPerBox: 1 }));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).boxes.length, 2000);
});


test("CLI reports a closed output pipe with a real nonzero exit", { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [cli, "--json"], { stdio: ["pipe", "pipe", "pipe"] });
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
  assert.match(stderr, /^packaging: cannot write output/);
  assert.doesNotMatch(stderr, /\n\s+at /);
});

test("requiring packaging modules has no CLI side effects", () => {
  const result = spawnSync(process.execPath, ["-e", "require('./packaging.js'); require('./packaging-cli.js');"], {
    cwd: __dirname, input: "invalid input", encoding: "utf8", timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});


test("text reports escape C1 controls and Unicode line separators without changing JSON SKUs", () => {
  const codePoints = [...Array.from({ length: 33 }, (_, index) => 0x7f + index), 0x2028, 0x2029];
  const controls = String.fromCodePoint(...codePoints);
  const sku = "A" + controls + "B";
  const input = JSON.stringify({ items: [{ sku, quantity: 1 }], maxItemsPerBox: 1 });
  const text = run([], input);
  assert.equal(text.status, 0);
  assert.equal(text.stderr, "");
  for (const character of controls) assert.ok(!text.stdout.includes(character));
  const escaped = codePoints.map(code => "\\u" + code.toString(16).padStart(4, "0")).join("");
  assert.ok(text.stdout.includes('  "A' + escaped + 'B": 1\n'));
  const json = run(["--json"], input);
  assert.equal(json.status, 0);
  assert.equal(json.stderr, "");
  assert.equal(JSON.parse(json.stdout).boxes[0].contents[0].sku, sku);
});


test("CLI single-SKU mode identifies itself in JSON and keeps partial boxes separate", () => {
  const input = JSON.stringify({ items: [{ sku: "A", quantity: 2 }, { sku: "B", quantity: 2 }], maxItemsPerBox: 3 });
  for (const args of [["--mode", "single-sku", "--json"], ["-", "--json", "--mode", "single-sku"],
    [path.join(__dirname, "examples/single-sku-order.json"), "--mode", "single-sku", "--json"]]) {
    const result = run(args, input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      maxItemsPerBox: 3, totalItems: 4, boxes: [
        { contents: [{ sku: "A", quantity: 2 }], totalItems: 2 },
        { contents: [{ sku: "B", quantity: 2 }], totalItems: 2 },
      ], mode: "single-sku",
    });
  }
});

test("CLI single-SKU text reports show the selected mode, including empty orders", () => {
  const result = run(["--mode", "single-sku"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    "Packing plan: 9 items in 3 boxes (capacity: 4 items per box)",
    "Mode: single-sku (one SKU per box)",
    "Box 1: 4 items", '  "B": 4',
    "Box 2: 2 items", '  "B": 2',
    "Box 3: 3 items", '  "A": 3', "",
  ].join("\n"));
  for (const items of [[], [{ sku: "A", quantity: 0 }]]) {
    const input = JSON.stringify({ items, maxItemsPerBox: 3 });
    const text = run(["--mode", "single-sku"], input);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /0 items in 0 boxes.*\nMode: single-sku.*\nNo boxes needed\./);
    const json = run(["--json", "--mode", "single-sku"], input);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), { maxItemsPerBox: 3, totalItems: 0, boxes: [], mode: "single-sku" });
  }
});

test("CLI explicit mixed mode retains the legacy text and JSON byte for byte", () => {
  for (const args of [[], ["--json"]]) {
    const legacy = run(args);
    const mixed = run([...args, "--mode", "mixed"]);
    assert.equal(mixed.status, 0);
    assert.equal(mixed.stderr, "");
    assert.equal(mixed.stdout, legacy.stdout);
    assert.doesNotMatch(mixed.stdout, /Mode:|"mode":/);
  }
});

test("CLI mode works with files and option terminators and is documented in help", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "--mode"), JSON.stringify(order));
  const result = run(["--mode", "single-sku", "--json", "--", "--mode"], "invalid", { cwd: dir });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, "single-sku");
  assert.deepEqual(plan.boxes.map(box => box.totalItems), [4, 2, 3]);
  assert.ok(plan.boxes.every(box => box.contents.length === 1));
  assert.match(run(["--help"]).stdout, /--mode.*mixed.*single-sku/);
});

test("CLI missing, invalid and repeated modes fail with argument exit status before input", () => {
  for (const args of [
    ["--mode"], ["--mode", "--json"], ["--mode", ""], ["--mode", "single"],
    ["--mode", "true"], ["--mode", "SINGLE-SKU"], ["--mode=single-sku"],
    ["--mode", "mixed", "--mode", "single-sku"], ["--mode", "single-sku", "--mode", "single-sku"],
  ]) {
    fails(run(args, "not JSON"), 2, /mode/);
  }
});

test("CLI single-SKU mode preserves input errors and applies its actual box-count limit", () => {
  fails(run(["--mode", "single-sku"], "not JSON"), 1, /JSON/);
  for (const quantity of [-1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    fails(run(["--mode", "single-sku"], JSON.stringify({ items: [{ sku: "A", quantity }], maxItemsPerBox: 3 })), 1, /quantity/);
  }
  const excessive = JSON.stringify({ items: [
    { sku: "A", quantity: 149999 }, { sku: "B", quantity: 149999 }, { sku: "C", quantity: 2 },
  ], maxItemsPerBox: 3 });
  fails(run(["--mode", "single-sku", "--json"], excessive), 1, /100000 boxes/);
  const max = Number.MAX_SAFE_INTEGER;
  const safe = run(["--mode", "single-sku", "--json"], JSON.stringify({ items: [
    { sku: "A", quantity: max - 1 }, { sku: "B", quantity: 1 },
  ], maxItemsPerBox: max }));
  assert.equal(safe.status, 0);
  assert.deepEqual(JSON.parse(safe.stdout).boxes.map(box => box.totalItems), [max - 1, 1]);
});
