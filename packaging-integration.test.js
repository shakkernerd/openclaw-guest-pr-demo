"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const cli = path.join(__dirname, "packaging-cli.js");
const order = JSON.stringify({ items: [{ sku: "A", quantity: 1 }, { sku: "B", quantity: 1 }], maxItemsPerBox: 4 });
const flags = ["--check", "--csv", "--json", "--summary", "--compare"];
// Enumerate valid selections independently of the parser's conflict conditions.
const validSelections = new Set(["", "--json", "--summary", "--json --summary", "--csv", "--check", "--compare", "--compare --json"]);

function run(args, input = order, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input, encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, args.join(" "));
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function argumentError(result, usage) {
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^packaging: --(?:check|csv|compare) cannot be combined with /);
  assert.ok(result.stderr.endsWith("\n" + usage));
  assert.doesNotMatch(result.stderr, /cannot read input|input must contain|\n\s+at /);
}

function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "packaging-integration-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("combined CLI covers every reporting-flag subset, both orders, and every mode selection", t => {
  const dir = directory(t);
  const file = path.join(dir, "order file.json");
  const missing = path.join(dir, "missing.json");
  writeFileSync(file, order);
  const usage = success(run(["--help"]));
  let valid = 0;
  let invalid = 0;
  for (let mask = 0; mask < 2 ** flags.length; mask += 1) {
    const selection = flags.filter((_, index) => mask & (1 << index));
    const key = [...selection].sort().join(" ");
    for (const mode of [undefined, "mixed", "single-sku"]) {
      const modeArgs = mode === undefined ? [] : ["--mode", mode];
      const allowed = validSelections.has(key) && !(selection.includes("--compare") && mode !== undefined);
      const expected = allowed ? success(run([...selection, ...modeArgs])) : undefined;
      for (const args of [[...selection, ...modeArgs], [...modeArgs, ...selection.toReversed()]]) {
        if (allowed) {
          // Existing feature suites pin the canonical bytes; composition must not change them.
          assert.equal(success(run(args)), expected);
          assert.equal(success(run([file, ...args], "ignored invalid stdin")), expected);
          if (selection.includes("--check")) assert.equal(expected, "");
          valid += 1;
        } else {
          argumentError(run(args, "not JSON"), usage);
          argumentError(run([missing, ...args], "not JSON"), usage);
          invalid += 1;
        }
      }
    }
  }
  assert.equal(valid, 40);
  assert.equal(invalid, 152);
});

test("every cross-feature conflict exits before reading an open stdin", { timeout: 30000 }, async t => {
  const pairs = [
    ...["--csv", "--json", "--summary", "--compare"].map(flag => [["--check"], [flag]]),
    ...["--json", "--summary", "--compare"].map(flag => [["--csv"], [flag]]),
    [["--compare"], ["--summary"]],
    [["--compare", "--json"], ["--mode", "mixed"]],
    [["--compare", "--json"], ["--mode", "single-sku"]],
  ];
  const usage = success(run(["--help"]));
  for (const [left, right] of pairs) {
    for (const args of [[...left, ...right], [...right, ...left]]) {
      const child = spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "pipe"], timeout: 2000 });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      // No write/end on stdin: reading it would block until the process deadline.
      const result = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) => resolve({ status, signal }));
      });
      assert.equal(result.signal, null, args.join(" ") + " waited for input");
      argumentError({ ...result, stdout, stderr }, usage);
    }
  }
});

test("new flag names after -- remain filenames for all combined commands", t => {
  const dir = directory(t);
  for (const name of flags) writeFileSync(path.join(dir, name), order);
  for (const selection of validSelections) {
    const args = selection ? selection.split(" ") : [];
    const expected = success(run(args));
    for (const name of flags) {
      assert.equal(success(run([...args, "--", name], "ignored", { cwd: dir })), expected);
    }
  }
});

test("CSV Unicode restrictions do not leak into check or comparison", () => {
  for (const quantity of [0, 1]) {
    const input = JSON.stringify({ items: [{ sku: "\ud800", quantity }], maxItemsPerBox: 2 });
    for (const mode of ["mixed", "single-sku"]) {
      assert.equal(success(run(["--check", "--mode", mode], input)), "");
      const csv = run(["--csv", "--mode", mode], input);
      assert.equal(csv.status, 1);
      assert.equal(csv.stdout, "");
      assert.equal(csv.stderr, "packaging: standard input: items[0].sku contains an unpaired UTF-16 surrogate; CSV requires well-formed Unicode\n");
    }
    const comparison = JSON.parse(success(run(["--compare", "--json"], input)));
    for (const mode of ["mixed", "single-sku"]) {
      assert.deepEqual(comparison[mode], JSON.parse(success(run(["--summary", "--json", "--mode", mode], input))));
    }
    assert.equal(success(run(["--compare"], input)).split("\n").length, 4);
  }
});

test("combined commands retain deep ignored fields, effective keys, and exact source diagnostics", t => {
  const dir = directory(t);
  const file = path.join(dir, "order file.json");
  const ignored = '{"unused":'.repeat(20000) + "1e-400" + "}".repeat(20000);
  const input = '{"items":[{"sku":"\\ud800","sku":"📦","quantity":1e-400,"quanti\\u0074y":300e-2}],"maxItemsPerBox":2.9999999999999999,"maxItemsPer\\u0042ox":3e0,"extra":' + ignored + ',"check":true,"csv":true,"compare":false,"mode":"ignored"}';
  const normalized = JSON.stringify({ items: [{ sku: "📦", quantity: 3 }], maxItemsPerBox: 3 });
  const commands = [["--compare"], ["--compare", "--json"],
    ...["--check", "--csv"].flatMap(flag => ["mixed", "single-sku"].map(mode => [flag, "--mode", mode]))];
  for (const raw of [input, input.replace('300e-2', '1.0000000000000001')]) {
    writeFileSync(file, raw);
    for (const args of commands) {
      for (const source of [[], ["-"], [file]]) {
        // File commands ignore stdin; do not write a pipe-sized fixture they never read.
        const stdin = source[0] === file ? "ignored stdin" : raw;
        const result = run([...args, ...source], stdin);
        if (raw === input) {
          assert.equal(success(result), success(run(args, normalized)));
        } else {
          const baseline = run(["--summary", ...source], stdin);
          assert.equal(result.status, 1);
          assert.equal(result.stdout, "");
          assert.equal(result.stderr, baseline.stderr);
          assert.match(result.stderr, /items\[0\]\.quantity must be a non-negative safe integer/);
        }
      }
    }
  }
});

test("CSV retains the exact mode-specific box boundary while check and compare remain compact", () => {
  const input = JSON.stringify({ items: [{ sku: "A", quantity: 149999 }, { sku: "B", quantity: 149999 }, { sku: "C", quantity: 2 }], maxItemsPerBox: 3 });
  const csv = success(run(["--csv", "--mode", "mixed"], input));
  assert.ok(csv.startsWith("box,sku,quantity\r\n1,A,3\r\n"));
  assert.ok(csv.includes("50000,A,2\r\n50000,B,1\r\n"));
  assert.ok(csv.endsWith("100000,B,1\r\n100000,C,2\r\n"));
  assert.equal(csv.split("\r\n").length, 100004);
  const rejected = run(["--csv", "--mode", "single-sku"], input);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /100000 boxes/);
  const comparison = JSON.parse(success(run(["--compare", "--json"], input)));
  assert.equal(comparison.mixed.boxCount, 100000);
  assert.equal(comparison["single-sku"].boxCount, 100001);
  for (const mode of ["mixed", "single-sku"]) assert.equal(success(run(["--check", "--mode", mode], input)), "");
});

test("README CLI examples execute with the documented output and validation behavior", t => {
  const doc = readFileSync(path.join(__dirname, "README.md"), "utf8");
  const dir = directory(t);
  mkdirSync(path.join(dir, "examples"));
  for (const name of ["order.json", "single-sku-order.json", "large-order.json", "integer-spellings-order.json"]) {
    copyFileSync(path.join(__dirname, "examples", name), path.join(dir, "examples", name));
  }
  copyFileSync(path.join(dir, "examples/order.json"), path.join(dir, "-order.json"));
  let exercised = 0;
  // Parse only the documented command forms, without a shell or executing arbitrary Markdown.
  const fence = String.fromCharCode(96).repeat(3);
  const blocks = [...doc.matchAll(new RegExp(fence + "sh\\n([\\s\\S]*?)" + fence, "g"))];
  for (const [, block] of blocks) {
    for (const line of block.split("\n").filter(line => line.includes("node packaging-cli.js"))) {
      const match = line.match(/^(?:(?:cat (\S+)|printf '%s\\n' '([^']*)') \| )?node packaging-cli\.js(.*)$/);
      assert.ok(match, "unrecognized CLI documentation example: " + line);
      const input = match[1] ? readFileSync(path.join(dir, match[1]), "utf8") : match[2] ?? "ignored invalid stdin";
      const args = match[3].trim().replace(/ > packing\.csv$/, "").split(/\s+/).filter(Boolean);
      const result = run(args, input, { cwd: dir });
      if (match[2] && JSON.parse(match[2]).maxItemsPerBox === 0) {
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "packaging: standard input: maxItemsPerBox must be a positive safe integer\n");
      } else {
        const output = success(result);
        if (args.includes("--check")) assert.equal(output, "");
        else assert.ok(output.length > 0);
        if (args.includes("--json")) assert.doesNotThrow(() => JSON.parse(output));
        if (args.includes("--csv") && !args.includes("single-sku")) {
          const documented = doc.match(new RegExp(fence + "csv\\n([\\s\\S]*?)" + fence))[1];
          assert.equal(output, documented.replaceAll("\n", "\r\n"));
        }
        if (args.includes("--compare") && match[2]) {
          const section = doc.slice(doc.indexOf("### Compare packing policies"));
          const documented = section.match(new RegExp(fence + "text\\n([\\s\\S]*?)" + fence))[1];
          assert.equal(output, documented);
          const json = section.match(new RegExp(fence + "json\\n([\\s\\S]*?)" + fence))[1];
          assert.equal(success(run([...args, "--json"], input)), json);
        }
      }
      exercised += 1;
    }
  }
  assert.ok(exercised >= 30, "exercise examples rather than only checking documentation strings");
});
