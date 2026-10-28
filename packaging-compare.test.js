"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { summarizePackaging } = require("./packaging.js");

const cli = path.join(__dirname, "packaging-cli.js");
const order = { items: [{ sku: "A", quantity: 1 }, { sku: "B", quantity: 1 }], maxItemsPerBox: 4 };
const expected = {
  mixed: { mode: "mixed", maxItemsPerBox: 4, totalItems: 2, boxCount: 1, fullBoxes: 0, partialBoxes: 1, unusedItemSlots: "2" },
  "single-sku": { mode: "single-sku", maxItemsPerBox: 4, totalItems: 2, boxCount: 2, fullBoxes: 0, partialBoxes: 2, unusedItemSlots: "6" },
};

function run(args = [], input = JSON.stringify(order), options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", timeout: 5000, ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n"));
  return result.stdout;
}

function fails(result, status, diagnostic) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, diagnostic);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-compare-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("comparison JSON contains only both unchanged exact summaries in stable policy order", () => {
  for (const args of [["--compare", "--json"], ["-", "--json", "--compare"]]) {
    const output = succeeds(run(args));
    assert.equal(output, JSON.stringify(expected, null, 2) + "\n");
    const result = JSON.parse(output);
    for (const mode of ["mixed", "single-sku"]) {
      assert.deepEqual(result[mode], JSON.parse(succeeds(run(["--summary", "--json", "--mode", mode]))));
      assert.equal(typeof result[mode].unusedItemSlots, "string");
      assert.equal(Object.hasOwn(result[mode], "boxes"), false);
    }
  }
});

test("comparison text displays all seven existing fields without derived metrics", () => {
  assert.equal(succeeds(run(["--compare"])), [
    "Policy     | Capacity | Items | Boxes | Full | Partial | Unused item slots",
    "mixed      | 4        | 2     | 1     | 0    | 1       | 2",
    "single-sku | 4        | 2     | 2     | 0    | 2       | 6", "",
  ].join("\n"));
});

test("comparison accepts files, options in either position, and dashed filenames after --", t => {
  const dir = tempDir(t);
  for (const name of ["order file.json", "--compare", "--mode", "--summary"]) {
    writeFileSync(path.join(dir, name), JSON.stringify(order));
    const output = succeeds(run(["--compare", "--json", "--", name], "ignored invalid stdin", { cwd: dir }));
    assert.equal(output, JSON.stringify(expected, null, 2) + "\n");
  }
  assert.equal(succeeds(run(["order file.json", "--json", "--compare"], "ignored", { cwd: dir })),
    JSON.stringify(expected, null, 2) + "\n");
  assert.equal(succeeds(run(["--compare", "order file.json"], "ignored", { cwd: dir })), succeeds(run(["--compare"])));
  // The option terminator must also preserve legacy detailed output.
  assert.equal(succeeds(run(["--json", "--", "--compare"], "ignored", { cwd: dir })), succeeds(run(["--json"])));
});

test("comparison handles empty, zero, single-item, exact-capacity and repeated-SKU orders", () => {
  const cases = [[], [{ sku: "A", quantity: 0 }], [{ sku: "A", quantity: 1 }],
    [{ sku: "A", quantity: 4 }, { sku: "B", quantity: 8 }],
    [{ sku: "B", quantity: 0 }, { sku: "A", quantity: 1 }, { sku: "B", quantity: 2 }, { sku: "A", quantity: 3 }]];
  for (const items of cases) {
    const input = JSON.stringify({ items, maxItemsPerBox: 4, mode: "ignored", compare: false });
    const result = JSON.parse(succeeds(run(["--compare", "--json"], input)));
    const lines = succeeds(run(["--compare"], input)).trimEnd().split("\n");
    assert.equal(lines.length, 3);
    for (const [index, mode] of ["mixed", "single-sku"].entries()) {
      const summary = summarizePackaging(items, 4, { mode });
      assert.deepEqual(result[mode], summary);
      assert.deepEqual(lines[index + 1].split("|").map(cell => cell.trim()), Object.values(summary).map(String));
    }
  }
});

test("comparison preserves exact unused-slot strings and aligns wide integer columns", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const cases = [
    [{ items: [{ sku: "A", quantity: max }], maxItemsPerBox: 4503599627370495 }, ["4503599627370494", "4503599627370494"]],
    [{ items: [{ sku: "A", quantity: 1 }, { sku: "B", quantity: 2 }], maxItemsPerBox: max }, ["9007199254740988", "18014398509481979"]],
  ];
  for (const [input, unused] of cases) {
    const json = JSON.parse(succeeds(run(["--compare", "--json"], JSON.stringify(input))));
    const text = succeeds(run(["--compare"], JSON.stringify(input)));
    const lines = text.trimEnd().split("\n");
    const separators = line => [...line.matchAll(/\|/g)].map(match => match.index);
    for (const [index, mode] of ["mixed", "single-sku"].entries()) {
      assert.equal(json[mode].unusedItemSlots, unused[index]);
      assert.ok(text.includes(unused[index]));
      assert.deepEqual(separators(lines[index + 1]), separators(lines[0]));
    }
  }
});

test("comparison reports maximum-safe-integer box counts as exact compact text and JSON within deadline", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const input = JSON.stringify({ items: [{ sku: "A", quantity: max }], maxItemsPerBox: 1 });
  const expectedLarge = {
    mixed: { mode: "mixed", maxItemsPerBox: 1, totalItems: max, boxCount: max, fullBoxes: max, partialBoxes: 0, unusedItemSlots: "0" },
    "single-sku": { mode: "single-sku", maxItemsPerBox: 1, totalItems: max, boxCount: max, fullBoxes: max, partialBoxes: 0, unusedItemSlots: "0" },
  };
  // Ordinary CLI processes use the existing 5-second deadline in run().
  const json = succeeds(run(["--compare", "--json"], input));
  assert.equal(json, JSON.stringify(expectedLarge, null, 2) + "\n");
  assert.ok(json.length < 1000);
  for (const summary of Object.values(JSON.parse(json))) {
    assert.equal(Object.hasOwn(summary, "boxes"), false);
  }
  const text = succeeds(run(["--compare"], input));
  assert.equal(text, [
    "Policy     | Capacity | Items            | Boxes            | Full             | Partial | Unused item slots",
    "mixed      | 1        | 9007199254740991 | 9007199254740991 | 9007199254740991 | 0       | 0",
    "single-sku | 1        | 9007199254740991 | 9007199254740991 | 9007199254740991 | 0       | 0",
    "",
  ].join("\n"));
  assert.ok(text.length < 1000);
});

test("comparison conflicts fail before reading an open stdin, in either option order", { timeout: 10000 }, async t => {
  for (const selection of [["--summary"], ["--mode", "mixed"], ["--mode", "single-sku"]]) {
    for (const args of [["--compare", ...selection], [...selection, "--compare", "--json"]]) {
      const child = spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "pipe"], timeout: 2000 });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      // Deliberately neither write to nor close stdin: input reads would block.
      const result = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) => resolve({ status, signal }));
      });
      assert.equal(result.signal, null, "argument validation must not wait for stdin");
      fails({ ...result, stdout, stderr }, 2, /^packaging: --compare cannot be combined with --mode or --summary\n/);
    }
  }
});

test("comparison rejects repeated and invalid arguments and documents itself in help", () => {
  for (const args of [["--compare", "--compare"], ["--compare=true"], ["--compare", "--json", "--json"],
    ["--compare", "--wat"], ["--compare", "--mode"], ["--compare", "--mode", "invalid"],
    ["--compare", "a.json", "b.json"], ["--help", "--compare"], ["--compare", "-h"]]) {
    fails(run(args, "not JSON"), 2, /^packaging: /);
  }
  for (const flag of ["--help", "-h"]) {
    const help = succeeds(run([flag], "not JSON"));
    assert.match(help, /--compare \[--json\] \[FILE\|-\]/);
    assert.match(help, /--compare.*cannot combine with --mode or --summary/);
  }
});

test("comparison preserves input diagnostics, source context, and raw-number validation", t => {
  const dir = tempDir(t);
  const file = path.join(dir, "private order.json");
  const inputs = ["{", "null", "[]", "{}",
    '{"items":[{"sku":"PRIVATE_MARKER","quantity":-1}],"maxItemsPerBox":4}',
    '{"items":[{"sku":"A","quantity":1.0000000000000001}],"maxItemsPerBox":4}',
    '{"items":[],"maxItemsPerBox":2.9999999999999999}',
    '{"items":[{"sku":"A","quantity":1e-400}],"maxItemsPerBox":4}',
    '{"items":[{"sku":"A","quantity":9007199254740991},{"sku":"B","quantity":1}],"maxItemsPerBox":4}'];
  for (const input of inputs) {
    writeFileSync(file, input);
    for (const source of [[], ["-"], [file]]) {
      const baseline = run(["--summary", ...source], input);
      for (const format of [[], ["--json"]]) {
        const result = run(["--compare", ...format, ...source], input);
        fails(result, 1, /^packaging: /);
        assert.equal(result.stderr, baseline.stderr);
        assert.doesNotMatch(result.stderr, /PRIVATE_MARKER/);
      }
    }
  }
  for (const source of [path.join(dir, "missing.json"), dir]) {
    const result = run(["--compare", source]);
    fails(result, 1, /cannot read input/);
    assert.equal(result.stderr, run(["--summary", source]).stderr);
  }
});

test("comparison retains integral spellings, duplicate-key behavior and deeply ignored data", () => {
  const ignored = "[".repeat(3000) + "1e-400" + "]".repeat(3000);
  const input = '{"items":[{"sku":"A","quantity":1.0000000000000001,"quantity":1e0},{"sku":"B","quantity":100e-2}],"maxItemsPerBox":4.0,"ignored":' + ignored + "}";
  assert.equal(succeeds(run(["--compare", "--json"], input)), JSON.stringify(expected, null, 2) + "\n");
});

test("comparison retains broken-pipe failure handling", { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [cli, "--compare", "--json"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal }));
  });
  child.stdout.destroy();
  child.stdin.end(JSON.stringify(order));
  const result = await completed;
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(stderr, /^packaging: cannot write output/);
});
