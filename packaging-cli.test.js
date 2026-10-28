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


test("CLI summary JSON works from implicit/explicit stdin in both modes", () => {
  for (const mode of ["mixed", "single-sku"]) {
    for (const args of [["--summary", "--json", "--mode", mode], ["-", "--mode", mode, "--json", "--summary"]]) {
      const result = run(args);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        mode, maxItemsPerBox: 4, totalItems: 9, boxCount: 3,
        fullBoxes: mode === "mixed" ? 2 : 1,
        partialBoxes: mode === "mixed" ? 1 : 2, unusedItemSlots: "3",
      });
      assert.ok(result.stdout.endsWith("\n"));
    }
  }
  const implicit = run(["--summary", "--json"]);
  assert.equal(implicit.status, 0);
  assert.equal(implicit.stdout, run(["--summary", "--mode", "mixed", "--json"]).stdout);
});

test("CLI summary text is compact and handles empty, single-item, and partial plans", () => {
  for (const mode of ["mixed", "single-sku"]) {
    const result = run(["--summary", "--mode", mode]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "Mode: " + mode + " | Capacity: 4\n" +
      "9 items | 3 boxes: " + (mode === "mixed" ? "2 full, 1 partial" : "1 full, 2 partial") + " | 3 unused item slots\n");
    for (const items of [[], [{ sku: "A", quantity: 0 }]]) {
      const empty = run(["--summary", "--mode", mode], JSON.stringify({ items, maxItemsPerBox: 3 }));
      assert.equal(empty.status, 0);
      assert.equal(empty.stdout, "Mode: " + mode + " | Capacity: 3\n0 items | 0 boxes: 0 full, 0 partial | 0 unused item slots\n");
      const json = run(["--summary", "--mode", mode, "--json"], JSON.stringify({ items, maxItemsPerBox: 3 }));
      assert.equal(json.status, 0);
      assert.deepEqual(JSON.parse(json.stdout), {
        mode, maxItemsPerBox: 3, totalItems: 0, boxCount: 0,
        fullBoxes: 0, partialBoxes: 0, unusedItemSlots: "0",
      });
    }
  }
  const single = run(["--summary"], '{"items":[{"sku":"A","quantity":1}],"maxItemsPerBox":2}');
  assert.equal(single.status, 0);
  assert.equal(single.stdout, "Mode: mixed | Capacity: 2\n1 item | 1 box: 0 full, 1 partial | 1 unused item slot\n");
});

test("CLI summary handles real files, option terminators, read errors, and malformed files", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "--summary"), JSON.stringify(order));
  writeFileSync(path.join(dir, "bad.json"), "{broken");
  const args = ["--summary", "--mode", "single-sku", "--json", "--", "--summary"];
  const result = run(args, "ignored invalid stdin", { cwd: dir });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, run(["--summary", "--mode", "single-sku", "--json"]).stdout);
  fails(run(["--summary", path.join(dir, "missing.json")]), 1, /cannot read/);
  fails(run(["--summary", dir]), 1, /cannot read/);
  fails(run(["--summary", path.join(dir, "bad.json")]), 1, /JSON/);
});

test("CLI summary preserves both exact arithmetic boundary examples as decimal strings", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const cases = [
    { mode: "mixed", items: [{ sku: "A", quantity: max }], capacity: 4503599627370495, unused: "4503599627370494", boxes: 3 },
    { mode: "single-sku", items: [{ sku: "A", quantity: 1 }, { sku: "B", quantity: 2 }], capacity: max, unused: "18014398509481979", boxes: 2 },
  ];
  for (const sample of cases) {
    const input = JSON.stringify({ items: sample.items, maxItemsPerBox: sample.capacity });
    const json = run(["--summary", "--json", "--mode", sample.mode], input);
    assert.equal(json.status, 0);
    assert.equal(json.stderr, "");
    const summary = JSON.parse(json.stdout);
    assert.equal(summary.unusedItemSlots, sample.unused);
    assert.equal(summary.boxCount, sample.boxes);
    const text = run(["--summary", "--mode", sample.mode], input);
    assert.equal(text.status, 0);
    assert.ok(text.stdout.includes(sample.unused + " unused item slots"));
  }
});

test("CLI summary permits huge box counts but detailed mode still rejects them", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const input = JSON.stringify({ items: [{ sku: "A", quantity: max }], maxItemsPerBox: 1 });
  for (const mode of ["mixed", "single-sku"]) {
    const result = run(["--summary", "--json", "--mode", mode], input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      mode, maxItemsPerBox: 1, totalItems: max, boxCount: max,
      fullBoxes: max, partialBoxes: 0, unusedItemSlots: "0",
    });
    assert.ok(result.stdout.length < 400);
    fails(run(["--mode", mode], input), 1, /100000 boxes/);
  }
});

test("CLI summary uses existing input validation and diagnostics in both modes", () => {
  const inputs = ["", "{", "null", "[]", "42", "{}",
    '{"items":[{"sku":"","quantity":1}],"maxItemsPerBox":3}',
    '{"items":[{"sku":"A","quantity":-1}],"maxItemsPerBox":3}',
    '{"items":[{"sku":"A","quantity":0.5}],"maxItemsPerBox":3}',
    '{"items":[{"sku":"A","quantity":"2"}],"maxItemsPerBox":3}',
    '{"items":[{"sku":"A","quantity":1e309}],"maxItemsPerBox":3}',
    '{"items":[{"sku":"A","quantity":9007199254740992}],"maxItemsPerBox":3}',
    '{"items":[],"maxItemsPerBox":0}',
    '{"items":[],"maxItemsPerBox":9007199254740992}',
    '{"items":[{"sku":"A","quantity":9007199254740991},{"sku":"B","quantity":1}],"maxItemsPerBox":3}',
  ];
  for (const mode of ["mixed", "single-sku"]) {
    for (const input of inputs) {
      const summary = run(["--summary", "--json", "--mode", mode], input);
      const detailed = run(["--json", "--mode", mode], input);
      fails(summary, 1, /JSON|order|items|maxItemsPerBox|total/);
      assert.equal(summary.stderr, detailed.stderr);
      assert.equal(summary.status, detailed.status);
    }
  }
});

test("CLI summary rejects invalid arguments before reading input and appears in help", () => {
  for (const args of [["--summary", "--summary"], ["--summary=true"], ["--summary", "--wat"],
    ["--summary", "--mode"], ["--summary", "--mode", "other"], ["--summary", "a.json", "b.json"],
    ["--help", "--summary"]]) {
    fails(run(args, "not JSON"), 2, /option|mode|argument/);
  }
  assert.match(run(["--help"]).stdout, /--summary.*summary/i);
});


test("CLI rejects the reported raw fractional tokens through files and stdin in all modes", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-precision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Keep these as raw text: JSON.stringify would erase the finding before testing it.
  const cases = [
    ['{"items":[{"sku":"A","quantity":3}],"maxItemsPerBox":2.9999999999999999}', /maxItemsPerBox/],
    ['{"items":[{"sku":"A","quantity":1.0000000000000001}],"maxItemsPerBox":3}', /items\[0\]\.quantity/],
  ];
  const results = [];
  for (const [index, [input, diagnostic]] of cases.entries()) {
    const file = path.join(dir, index + ".json");
    writeFileSync(file, input);
    for (const mode of ["mixed", "single-sku"]) {
      for (const format of [[], ["--json"]]) {
        for (const summary of [[], ["--summary"]]) {
          const args = [...format, ...summary, "--mode", mode];
          results.push([run([...args, file], "ignored stdin"), diagnostic]);
          results.push([run([...args, "-"], input), diagnostic]);
        }
      }
    }
  }
  // Exercise every route before asserting, including on the pre-fix implementation.
  for (const [result, diagnostic] of results) fails(result, 1, diagnostic);
});

test("CLI preserves integral decimal and exponent spellings and exact safe boundaries", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-integral-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ["1.0", "3e0"], ["3e0", "300e-2"], ["300e-2", "3.00E+000"],
    ["0.001e3", "1000e-3"], ["-0.000e-9999", "1"],
    ["0e9999", "1"], ["9007199254740991.0", "9.007199254740991e15"],
    ["90071992547409910e-1", "9007199254740991"],
  ];
  for (const [quantity, capacity] of cases) {
    const input = '{"items":[{"sku":"A","quantity":' + quantity + '}],"maxItemsPerBox":' + capacity + '}';
    const normalized = JSON.stringify(JSON.parse(input));
    const file = path.join(dir, "order.json");
    writeFileSync(file, input);
    for (const args of [["--json"], ["--mode", "single-sku"], ["--summary", "--json"], ["--summary", "--mode", "single-sku"]]) {
      const expected = run(args, normalized);
      assert.equal(expected.status, 0, expected.stderr);
      for (const result of [run([...args, file], "ignored"), run(args, input)]) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, expected.stdout);
      }
    }
  }
});

test("CLI rejects rounded fractional numbers, underflow, and unsafe integer tokens", () => {
  const tokens = [
    "1.0000000000000001", "2.9999999999999999", "10000000000000001e-16",
    "9007199254740991.1", "9007199254740990.9", "1e-400", "-1e-400",
    "1e-999999999999999999999999999", "0.99999999999999999", "1.5",
    "9007199254740992", "9007199254740993", "90071992547409920e-1", "1e400",
  ];
  for (const token of tokens) {
    fails(run(["--summary", "--json"], '{"items":[{"sku":"A","quantity":' + token + '}],"maxItemsPerBox":3}'), 1, /quantity/);
    fails(run(["--mode", "single-sku"], '{"items":[],"maxItemsPerBox":' + token + '}'), 1, /maxItemsPerBox/);
  }
  // Long fractional tails must stay invalid without quadratic token processing.
  fails(run([], '{"items":[{"sku":"A","quantity":1.' + "0".repeat(100000) + '1}],"maxItemsPerBox":1}'), 1, /quantity/);
  // Exponent magnitude must not cause a giant power-of-ten allocation.
  const huge = "9".repeat(10000);
  const accepted = run(["--summary"], '{"items":[{"sku":"A","quantity":0e-' + huge + '}],"maxItemsPerBox":1}');
  assert.equal(accepted.status, 0, accepted.stderr);
  fails(run([], '{"items":[{"sku":"A","quantity":1e-' + huge + '}],"maxItemsPerBox":1}'), 1, /quantity/);
  const compensated = run(["--json"], '{"items":[{"sku":"A","quantity":1' + "0".repeat(1000) + 'e-1000}],"maxItemsPerBox":1}');
  assert.equal(compensated.status, 0, compensated.stderr);
  assert.equal(JSON.parse(compensated.stdout).totalItems, 1);
});

test("CLI source validation preserves strings, ignored extras, escaped keys, and last-key-wins semantics", () => {
  const sku = 'quantity: 1.0000000000000001 \\" \u2028 __proto__';
  const input = '{"items":[{"sku":' + JSON.stringify(sku) + ',"quantity":1.0,"extra":{"quantity":1e-400,"maxItemsPerBox":2.9999999999999999}}],"maxItemsPerBox":3e0,"quantity":1.0000000000000001,"extra":[1e9999,1e-400],"__proto__":{"quantity":1.0000000000000001},"constructor":2.9999999999999999}';
  const result = run(["--json"], input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).boxes[0].contents[0].sku, JSON.parse(input).items[0].sku);
  const finalValid = String.raw`{"items":[{"sku":"A","quantity":1.0000000000000001,"quanti\u0074y":3e0}],"maxItemsPerBox":2.9999999999999999,"maxItemsPer\u0042ox":300e-2}`;
  const valid = run(["--json"], finalValid);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).totalItems, 3);
  assert.equal(JSON.parse(valid.stdout).maxItemsPerBox, 3);
  fails(run([], String.raw`{"items":[{"sku":"A","quantity":1,"quanti\u0074y":1.0000000000000001}],"maxItemsPerBox":3}`), 1, /quantity/);
  fails(run([], String.raw`{"items":[],"maxItemsPerBox":3,"maxItemsPer\u0042ox":2.9999999999999999}`), 1, /maxItemsPerBox/);
  // An overwritten items array is not part of the effective order either.
  assert.equal(run([], '{"items":[{"sku":"A","quantity":1.0000000000000001}],"items":[],"maxItemsPerBox":3}').status, 0);
});

test("CLI precision checking does not relax JSON grammar or coerce numeric strings", () => {
  for (const token of ["01", "+1", ".1", "1.", "1e", "NaN", "Infinity"]) {
    fails(run([], '{"items":[{"sku":"A","quantity":' + token + '}],"maxItemsPerBox":3}'), 1, /JSON/);
  }
  fails(run([], '{"items":[{"sku":"A","quantity":"1.0"}],"maxItemsPerBox":3}'), 1, /quantity/);
  fails(run([], '{"items":[],"maxItemsPerBox":"3e0"}'), 1, /maxItemsPerBox/);
});

test("module APIs retain the parsed JavaScript Number contract, not source-token validation", () => {
  const { planPackaging, summarizePackaging } = require("./packaging.js");
  const order = JSON.parse('{"items":[{"sku":"A","quantity":1.0000000000000001}],"maxItemsPerBox":2.9999999999999999}');
  assert.equal(order.items[0].quantity, 1);
  assert.equal(order.maxItemsPerBox, 3);
  for (const mode of ["mixed", "single-sku"]) {
    assert.deepEqual(planPackaging(order.items, order.maxItemsPerBox, { mode }),
      planPackaging([{ sku: "A", quantity: 1 }], 3, { mode }));
    assert.deepEqual(summarizePackaging(order.items, order.maxItemsPerBox, { mode }),
      summarizePackaging([{ sku: "A", quantity: 1 }], 3, { mode }));
  }
});


test("CLI accepts deeply nested ignored data through files and stdin without recursive revival", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-deep-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const arrays = "[".repeat(3000) + "0" + "]".repeat(3000);
  const objects = '{"unused":'.repeat(20000) + "1.0000000000000001" + "}".repeat(20000);
  const cases = [
    ['{"items":[],"maxItemsPerBox":1,"ignored":' + arrays + '}', { items: [], maxItemsPerBox: 1 }],
    ['{"items":[],"maxItemsPerBox":1,"ignored":' + objects + '}', { items: [], maxItemsPerBox: 1 }],
    ['{"items":[{"sku":"A","quantity":300e-2,"ignored":' + objects + '}],"maxItemsPerBox":3e0}', { items: [{ sku: "A", quantity: 3 }], maxItemsPerBox: 3 }],
    ['{"items":' + arrays + ',"items":[],"maxItemsPerBox":1}', { items: [], maxItemsPerBox: 1 }],
  ];
  const results = [];
  for (const [index, [input, effectiveOrder]] of cases.entries()) {
    assert.doesNotThrow(() => JSON.parse(input), "native JSON parsing accepts the fixture");
    const file = path.join(dir, index + ".json");
    writeFileSync(file, input);
    for (const mode of ["mixed", "single-sku"]) {
      for (const format of [[], ["--json"]]) {
        for (const summary of [[], ["--summary"]]) {
          const args = [...format, ...summary, "--mode", mode];
          const expected = run(args, JSON.stringify(effectiveOrder));
          assert.equal(expected.status, 0, expected.stderr);
          results.push([run([...args, file], "ignored stdin"), expected.stdout]);
          results.push([run([...args, "-"], input), expected.stdout]);
        }
      }
    }
  }
  for (const [result, expected] of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  }
});

test("deep ignored data does not bypass fractional checks or native JSON syntax validation", () => {
  const ignored = "[".repeat(3000) + "1e-400" + "]".repeat(3000);
  for (const args of [[], ["--summary"], ["--mode", "single-sku"], ["--summary", "--mode", "single-sku"]]) {
    fails(run(args, '{"items":[{"sku":"A","quantity":1.0000000000000001}],"maxItemsPerBox":1,"ignored":' + ignored + '}'), 1, /quantity/);
    fails(run(args, '{"items":[],"maxItemsPerBox":2.9999999999999999,"ignored":' + ignored + '}'), 1, /maxItemsPerBox/);
    fails(run(args, '{"items":[],"maxItemsPerBox":1,"ignored":' + ignored.slice(1) + '}'), 1, /JSON/);
  }
});
