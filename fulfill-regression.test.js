"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync, statSync, openSync, closeSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { parseBatchJson, formatSummary } = require("./fulfill.js");
const { validateBatch } = require("./packing.js");
const { formatHtmlReport } = require("./packing-report.js");
const cli = join(__dirname, "fulfill.js");
const shipment = (id = "S", packed = 1) => ({
  id, order: [{ sku: "A", quantity: 1 }],
  parcels: [{ id: "P-" + id, items: [{ sku: "A", quantity: packed }] }],
});
const ready = JSON.stringify([shipment()]);
const arrays = "[".repeat(3000) + "0" + "]".repeat(3000);
const guardedArrays = "[".repeat(3000) + '{"quantity":1.0000000000000001}' + "]".repeat(3000);
const objects = '{"ignored":'.repeat(20000) + "1.0000000000000001" + "}".repeat(20000);
const withMetadata = (raw, metadata) => raw.replace('{"id":', '{"metadata":' + metadata + ',"id":');

function fixture(t, raw) {
  const dir = mkdtempSync(join(tmpdir(), "fulfillment-regression-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "batch.json");
  writeFileSync(file, raw);
  return file;
}
function invocation(t, format, source, raw) {
  return {
    args: [...(format === "text" ? [] : ["--" + format]), source === "stdin" ? "-" : fixture(t, raw)],
    input: source === "stdin" ? raw : undefined,
  };
}
function run(t, format, source, raw, options = {}) {
  const { args, input } = invocation(t, format, source, raw);
  const result = spawnSync(process.execPath, [cli, ...args], {
    input, encoding: "utf8", cwd: tmpdir(), timeout: 5000, maxBuffer: 8 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function outputError(result, code) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, new RegExp("Cannot write.*standard output.*" + code));
  assert.doesNotMatch(result.stderr, /\n\s+at /);
}
function fullDevice(t) {
  try {
    if (!statSync("/dev/full").isCharacterDevice()) {
      t.skip("/dev/full is not an available full-output device");
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("/dev/full is unavailable on this platform");
    return;
  }
  const fd = openSync("/dev/full", "r+"); // Existing device only; never create a file.
  t.after(() => closeSync(fd));
  return fd;
}

for (const format of ["text", "json", "html"]) {
  for (const source of ["file", "stdin"]) {
    const route = format + " via " + source;
    test(route + " reports full output devices as operational failures", t => {
      const fd = fullDevice(t);
      if (fd === undefined) return;
      for (const raw of [ready, JSON.stringify([shipment("BLOCKED", 2)])]) {
        const result = run(t, format, source, raw, { stdio: ["pipe", fd, "pipe"] });
        outputError(result, "ENOSPC");
        assert.equal(result.stdout, null); // Output was redirected, not captured.
      }
    });

    test(route + " reports closed output pipes as operational failures", { timeout: 10000 }, async t => {
      // A report larger than pipe capacity prevents a small write from winning a close race.
      const raw = JSON.stringify([shipment("S" + "x".repeat(2 * 1024 * 1024))]);
      const { args, input } = invocation(t, format, source, raw);
      const child = spawn(process.execPath, [cli, ...args], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let stderr = "";
      let inputError;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdin.on("error", error => { inputError = error; });
      const completed = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) => resolve({ status, signal }));
      });
      child.stdout.destroy();
      child.stdin.end(input);
      const result = await completed;
      assert.ifError(inputError);
      assert.equal(result.signal, null);
      outputError({ ...result, stderr }, "EPIPE");
    });

    test(route + " delivers complete reports beyond a pipe buffer", t => {
      const input = Array.from({ length: 1500 }, (_, i) => shipment("S-" + i, i === 1499 ? 2 : 1));
      const batch = validateBatch(input);
      const expected = format === "html" ? formatHtmlReport(batch) : format === "text" ? formatSummary(batch) :
        JSON.stringify({ valid: false, total: 1500, ready: 1499, blocked: 1, shipments: batch.shipments, errors: batch.errors }, null, 2);
      assert.ok(Buffer.byteLength(expected) > 65536);
      const result = run(t, format, source, JSON.stringify(input));
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, expected + "\n");
    });

    test(route + " accepts deep ignored metadata without changing the report", t => {
      const baseline = run(t, format, source, ready);
      assert.equal(baseline.status, 0);
      for (const metadata of [arrays, guardedArrays, objects]) {
        const raw = withMetadata(ready, metadata);
        assert.doesNotThrow(() => JSON.parse(raw));
        const result = run(t, format, source, raw);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, baseline.stdout);
      }
    });

    test(route + " accepts large escaped metadata without a regex stack limit", t => {
      const metadata = JSON.stringify("\\".repeat(5_000_000) + '"quantity":1.0000000000000001');
      for (const raw of [ready, ready.replace('"quantity":1', '"quantity":1.0000000000000001')]) {
        const baseline = run(t, format, source, raw);
        const input = withMetadata(raw, metadata);
        assert.doesNotThrow(() => JSON.parse(input));
        const result = run(t, format, source, input);
        assert.equal(result.status, baseline.status, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, baseline.stdout);
      }
    });

    test(route + " preserves quantities, validation and syntax errors with deep metadata", t => {
      for (const token of ["1.0", "100e-2", "1e+2", "9007199254740991.0"]) {
        const raw = ready.replaceAll('"quantity":1', '"quantity":' + token);
        const baseline = run(t, format, source, JSON.stringify(JSON.parse(raw)));
        const result = run(t, format, source, withMetadata(raw, guardedArrays));
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, baseline.stdout);
      }
      for (const side of ["order", "packed"]) {
        const invalid = shipment();
        (side === "order" ? invalid.order : invalid.parcels[0].items)[0].quantity = "RAW";
        const raw = JSON.stringify([invalid]).replace('"RAW"', "1.0000000000000001");
        const baseline = run(t, format, source, raw);
        assert.equal(baseline.status, 1);
        const result = run(t, format, source, withMetadata(raw, objects));
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, baseline.stdout);
        assert.match(result.stdout, /INVALID_QUANTITY/);
      }
      const malformed = withMetadata(ready, arrays).slice(0, -1);
      const result = run(t, format, source, malformed);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Cannot parse JSON/);
      assert.doesNotMatch(result.stderr, /call stack|\n\s+at /i);
    });
  }
}

test("help output also reports an unwritable destination", t => {
  const fd = fullDevice(t);
  if (fd === undefined) return;
  const result = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8", timeout: 5000, stdio: ["pipe", fd, "pipe"],
  });
  assert.ifError(result.error);
  outputError(result, "ENOSPC");
});

test("source-aware parsing retains native keys, strings, overwritten values and NaN quantities", () => {
  const raw = String.raw`{"quantity":1.0000000000000001,"other":1.0000000000000001,"text":"\"quantity\":1.0000000000000001","nested":{"quanti\u0074y":1.0000000000000001},"overwritten":{"quantity":1.0000000000000001,"quanti\u0074y":1.0},"numericString":{"quantity":"1.0000000000000001"},"__proto__":{"quantity":1.0000000000000001}}`;
  const result = parseBatchJson(raw);
  assert.ok(Number.isNaN(result.quantity));
  assert.ok(Number.isNaN(result.nested.quantity));
  assert.equal(result.other, 1);
  assert.equal(result.text, JSON.parse(raw).text);
  assert.equal(result.overwritten.quantity, 1);
  assert.equal(result.numericString.quantity, "1.0000000000000001");
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.ok(Object.hasOwn(result, "__proto__"));
  assert.ok(Number.isNaN(result.__proto__.quantity));
  assert.equal(parseBatchJson("1.0000000000000001"), 1);
  const overwritten = '{"quantity":' + objects + ',"quantity":1.0}';
  assert.equal(parseBatchJson(overwritten).quantity, 1);
  assert.throws(() => parseBatchJson('{"quantity":1.0000000000000001,}'), SyntaxError);
});
