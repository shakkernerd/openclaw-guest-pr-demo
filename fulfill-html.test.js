"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateBatch } = require("./packing.js");
const { parseBatchJson } = require("./fulfill.js");
const cli = join(__dirname, "fulfill.js");
const example = join(__dirname, "examples", "shipments.json");
const render = (batch) => require("./packing-report.js").formatHtmlReport(batch);
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], {
  input, encoding: "utf8", timeout: 5000, cwd: tmpdir(),
});
const shipment = (id = "S", quantity = 1) => ({
  id, order: [{ sku: "MUG", quantity: 1 }],
  parcels: [{ id: "BOX-" + id, items: [{ sku: "MUG", quantity }] }],
});
function fixture(t, content, name = "batch.json") {
  const dir = mkdtempSync(join(tmpdir(), "fulfillment-html-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}
function report(result, status) {
  assert.equal(result.status, status, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^<!doctype html>\n<html lang="en">/);
  assert.match(result.stdout, /<\/html>\n$/);
  return result.stdout;
}

for (const source of ["file", "stdin"]) {
  test("HTML reports ready and blocked batches from " + source, (t) => {
    for (const [input, status] of [[[shipment()], 0], [[shipment(), shipment("BLOCKED", 2)], 1]]) {
      const raw = JSON.stringify(input);
      const file = source === "stdin" ? "-" : fixture(t, raw);
      const html = report(run(["--html", file], source === "stdin" ? raw : undefined), status);
      assert.equal(html, render(validateBatch(parseBatchJson(raw))) + "\n");
      assert.match(html, /READY/);
      if (status === 1) {
        assert.match(html, /BLOCKED/);
        assert.match(html, /EXCESS_QUANTITY/);
        assert.match(html, /shipments\[1\]\.parcels/);
        assert.match(html, /remove 1/);
      }
      if (source === "file") assert.equal(readFileSync(file, "utf8"), raw);
    }
  });

  test("HTML retains precision and all affected duplicate assignments via " + source, (t) => {
    for (const side of ["order", "packed"]) {
      const first = shipment();
      const second = shipment();
      (side === "order" ? second.order : second.parcels[0].items)[0].quantity = "RAW";
      const raw = JSON.stringify([first, second, shipment("INDEPENDENT")]).replace('"RAW"', "1.0000000000000001");
      const file = source === "stdin" ? "-" : fixture(t, raw);
      const html = report(run([file, "--html"], source === "stdin" ? raw : undefined), 1);
      assert.match(html, /INVALID_QUANTITY/);
      assert.match(html, /Unknown/);
      assert.equal((html.match(/<span class="badge blocked">BLOCKED<\/span>/g) || []).length, 2);
      assert.equal((html.match(/<span class="badge ready">READY<\/span>/g) || []).length, 1);
      assert.equal((html.match(/<code>DUPLICATE_PARCEL<\/code>/g) || []).length, 2);
      assert.equal((html.match(/<code>DUPLICATE_SHIPMENT<\/code>/g) || []).length, 2);
      assert.match(html, side === "order" ? /shipments\[1\]\.order\[0\]\.quantity/ : /shipments\[1\]\.parcels\[0\]\.items\[0\]\.quantity/);
    }
    for (const token of ["1.0", "100e-2", "1e+2"]) {
      const raw = JSON.stringify([shipment()]).replaceAll('"quantity":1', '"quantity":' + token);
      const file = source === "stdin" ? "-" : fixture(t, raw);
      report(run(["--html", file], source === "stdin" ? raw : undefined), 0);
    }
  });
}

test("HTML renderer has labeled native disclosure controls and complete quantities", () => {
  const batch = validateBatch(JSON.parse(readFileSync(example, "utf8")));
  const before = JSON.stringify(batch);
  const html = render(batch);
  assert.equal(JSON.stringify(batch), before);
  assert.match(html, /<title>Shipment packing report<\/title>/);
  assert.match(html, /<h1>Shipment packing report<\/h1>/);
  assert.match(html, /<dt>Total shipments<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>Ready<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Blocked<\/dt><dd>1<\/dd>/);
  assert.match(html, /<details id="shipment-0" class="shipment ready">/);
  assert.match(html, /<details id="shipment-1" class="shipment blocked" open>/);
  assert.equal((html.match(/<summary>/g) || []).length, 2);
  assert.match(html, /SHIP-1001/);
  assert.match(html, /SHIP-1002/);
  assert.match(html, /3 items packed \/ 3 items ordered/);
  assert.match(html, /2 parcels/);
  assert.match(html, /1 parcel/);
  assert.match(html, /MUG-BLUE.*pack 1 more/);
  assert.match(html, /TEA-100G.*remove 1/);
  assert.match(html, /Toggle details/);
  assert.match(html, /:focus-visible/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<link\b|\son\w+=|https?:\/\/|@import|url\(/i);
});

test("HTML renders untrusted identifiers and every issue field only as text", () => {
  const hostile = `<img src=x onerror="alert(1)">&' </summary><script>evil()</script>`;
  const input = shipment(hostile, 2);
  input.order[0].sku = hostile;
  input.parcels[0].items[0].sku = hostile;
  const batch = validateBatch([input]);
  const html = render(batch);
  assert.doesNotMatch(html, /<img|<script|<\/summary><script>/i);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#39;/);
  assert.match(html, /&lt;\/summary&gt;&lt;script&gt;evil\(\)&lt;\/script&gt;/);
  assert.match(html, /remove 1/);
  for (const field of ["code", "path", "message"]) {
    const mutated = structuredClone(batch);
    mutated.shipments[0].errors[0][field] = hostile;
    const escaped = render(mutated);
    assert.doesNotMatch(escaped, /<img|<script/i);
    assert.ok(escaped.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;"));
  }
  const root = render({ valid: false, shipments: [], errors: [{ code: hostile, path: hostile, message: hostile }] });
  assert.doesNotMatch(root, /<img|<script/i);
});

test("HTML distinguishes empty batches, invalid roots, and unknown quantities", () => {
  const empty = report(run(["--html", "-"], "[]"), 0);
  assert.match(empty, /Packing validation passed/);
  assert.match(empty, /No shipments in this batch/);
  const invalid = report(run(["--html", "-"], "{}"), 1);
  assert.match(invalid, /Needs attention/);
  assert.match(invalid, /Batch issues/);
  assert.match(invalid, /INVALID_BATCH/);
  assert.doesNotMatch(invalid, /Packing validation passed|No shipments in this batch/);
  const malformed = shipment();
  malformed.order[0].quantity = "one";
  const html = report(run(["--html", "-"], JSON.stringify([malformed, null])), 1);
  assert.match(html, /Unknown ordered quantity/);
  assert.match(html, /Entry 2/);
  assert.match(html, /INVALID_SHIPMENT/);
});

test("HTML operational errors keep stdout empty and exit 2", (t) => {
  for (const raw of ["", "{", "[] []"]) {
    for (const args of [["--html", "-"], ["--html", fixture(t, raw)]]) {
      const result = run(args, raw);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Cannot parse JSON/);
    }
  }
  const missing = run(["--html", fixture(t, "[]") + ".missing"]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /Cannot read/);
  for (const args of [["--html"], ["--html", "--json", "-"], ["--json", "--html", "-"], ["--html", "--html", "-"], ["--html", "a", "b"]]) {
    const result = run(args, "[]");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/);
  }
  const help = run(["--html", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--html/);
  assert.equal(help.stderr, "");
  const file = fixture(t, "[]", "--html");
  const literal = spawnSync(process.execPath, [cli, "--html", "--", "--html"], {
    encoding: "utf8", timeout: 5000, cwd: join(file, ".."),
  });
  report(literal, 0);
});

test("documented HTML sample matches file and piped output byte for byte", () => {
  const expected = readFileSync(join(__dirname, "examples", "shipments.report.html"), "utf8");
  assert.doesNotMatch(expected, /^[ \t]+$/m, "Generated example has no whitespace-only lines");
  assert.equal(report(run(["--html", example]), 1), expected);
  assert.equal(report(run(["--html", "-"], readFileSync(example, "utf8")), 1), expected);
});
