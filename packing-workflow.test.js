"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { parseBatchJson } = require("./fulfill.js");

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [join(__dirname, cli), ...args], {
    input, encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024, cwd: tmpdir(),
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function fixture(t, name, input) {
  const directory = mkdtempSync(join(tmpdir(), "packing-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, name);
  writeFileSync(file, input);
  return file;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const itemLabel = n => `${n} item${n === 1 ? "" : "s"}`;

// Check actual processes and report fields, not just calls to the renderers.
function reportsAgree(t, batch, status) {
  const raw = JSON.stringify(batch);
  const file = fixture(t, "recorded.json", raw);
  const outputs = {};
  for (const [format, flags] of [["text", []], ["json", ["--json"]], ["html", ["--html"]]]) {
    const fromFile = run("fulfill.js", [...flags, file]);
    const fromStdin = run("fulfill.js", [...flags, "-"], raw);
    for (const result of [fromFile, fromStdin]) {
      assert.equal(result.status, status, result.stderr);
      assert.equal(result.stderr, "");
    }
    assert.equal(fromFile.stdout, fromStdin.stdout);
    outputs[format] = fromFile.stdout;
  }
  assert.equal(readFileSync(file, "utf8"), raw, "validation never records or rewrites packing");
  const report = JSON.parse(outputs.json);
  assert.equal(report.valid, status === 0);
  assert.equal(report.total, report.ready + report.blocked);
  assert.ok(outputs.text.includes(`Summary: ${report.ready} ready, ${report.blocked} blocked, ${report.total} shipment${report.total === 1 ? "" : "s"}.`));
  for (const [label, count] of [["Total shipments", report.total], ["Ready", report.ready], ["Blocked", report.blocked]]) {
    assert.ok(outputs.html.includes(`<dt>${label}</dt><dd>${count}</dd>`));
  }
  report.shipments.forEach((shipment, index) => {
    const status = shipment.valid ? "READY" : "BLOCKED";
    const packed = shipment.packedQuantity === null ? "unknown" : itemLabel(shipment.packedQuantity);
    const ordered = shipment.expectedQuantity === null ? "unknown" : itemLabel(shipment.expectedQuantity);
    const parcels = shipment.parcelCount === null ? "unknown parcels" : `${shipment.parcelCount} parcel${shipment.parcelCount === 1 ? "" : "s"}`;
    assert.ok(outputs.text.includes(`${status} ${JSON.stringify(shipment.shipmentId)}: ${packed} packed / ${ordered} ordered; ${parcels}`));
    const card = outputs.html.split(`<details id="shipment-${index}"`)[1].split("</details>")[0];
    assert.ok(card.includes(`>${status}</span>`));
    assert.ok(card.includes(escapeHtml(shipment.shipmentId)));
    const htmlPacked = shipment.packedQuantity === null ? "Unknown packed quantity" : `${packed} packed`;
    const htmlOrdered = shipment.expectedQuantity === null ? "Unknown ordered quantity" : `${ordered} ordered`;
    assert.ok(card.includes(`${htmlPacked} / ${htmlOrdered}; ${shipment.parcelCount === null ? "Unknown parcel count" : parcels}`));
    for (const error of shipment.errors) {
      assert.ok(outputs.text.includes(`[${error.code}] ${error.path}: ${error.message}`));
      for (const field of [error.code, error.path, error.message]) assert.ok(card.includes(escapeHtml(field)));
    }
  });
  return report;
}

for (const mode of ["mixed", "single-sku"]) {
  test(mode + " proposal, explicit packing records, corrections and reports stay separate", t => {
    const orderFile = join(__dirname, "examples/order.json");
    const raw = readFileSync(orderFile, "utf8");
    const order = JSON.parse(raw);
    const flags = ["--mode", mode];
    const planned = run("packaging-cli.js", [...flags, "--json", orderFile]);
    assert.equal(planned.status, 0);
    assert.equal(planned.stderr, "");
    assert.equal(run("packaging-cli.js", [...flags, "--json", "-"], raw).stdout, planned.stdout);
    const plan = JSON.parse(planned.stdout);
    const text = run("packaging-cli.js", flags, raw);
    assert.equal(text.status, 0);
    assert.equal(text.stderr, "");
    assert.ok(text.stdout.includes(`Packing plan: ${itemLabel(plan.totalItems)} in ${plan.boxes.length} boxes`));
    plan.boxes.forEach((box, i) => {
      assert.ok(text.stdout.includes(`Box ${i + 1}: ${itemLabel(box.totalItems)}`));
      for (const item of box.contents) assert.ok(text.stdout.includes(`  ${JSON.stringify(item.sku)}: ${item.quantity}`));
    });
    const summarized = run("packaging-cli.js", [...flags, "--summary", "--json"], raw);
    assert.equal(summarized.status, 0);
    assert.equal(summarized.stderr, "");
    const summary = JSON.parse(summarized.stdout);
    assert.equal(summary.totalItems, plan.totalItems);
    assert.equal(summary.boxCount, plan.boxes.length);
    assert.equal(summary.fullBoxes, plan.boxes.filter(b => b.totalItems === plan.maxItemsPerBox).length);
    assert.equal(summary.partialBoxes, plan.boxes.length - summary.fullBoxes);
    assert.equal(summary.unusedItemSlots, plan.boxes.reduce((n, b) => n + BigInt(plan.maxItemsPerBox - b.totalItems), 0n).toString());
    const summaryText = run("packaging-cli.js", [...flags, "--summary"], raw);
    assert.equal(summaryText.status, 0);
    assert.equal(summaryText.stdout, `Mode: ${mode} | Capacity: ${summary.maxItemsPerBox}
${itemLabel(summary.totalItems)} | ${summary.boxCount} boxes: ${summary.fullBoxes} full, ${summary.partialBoxes} partial | ${summary.unusedItemSlots} unused item slots
`);

    // A proposal is ignored metadata, never recorded parcels.
    const shipment = { id: "S<&\"", order: order.items, parcels: [], proposal: plan };
    let report = reportsAgree(t, [shipment], 1);
    assert.equal(report.shipments[0].packedQuantity, 0);
    assert.equal(report.shipments[0].expectedQuantity, 9);
    assert.ok(report.errors.every(e => e.code === "MISSING_QUANTITY"));
    const missingRecords = { ...shipment };
    delete missingRecords.parcels;
    assert.ok(reportsAgree(t, [missingRecords], 1).errors.some(e => e.code === "INVALID_PARCELS"));

    // Simulate an explicit operator record AFTER checking the physical contents.
    // No production API or CLI performs this conversion.
    shipment.parcels = plan.boxes.map((box, index) => ({
      id: `RECORDED-${index + 1}`, items: structuredClone(box.contents),
    }));
    report = reportsAgree(t, [shipment], 0);
    assert.equal(report.shipments[0].packedQuantity, summary.totalItems);
    assert.equal(report.shipments[0].parcelCount, summary.boxCount);

    // Equal totals do not imply matching SKUs; corrections must be revalidated.
    const originalSku = shipment.parcels[0].items[0].sku;
    shipment.parcels[0].items[0].sku = "WRONG<&";
    report = reportsAgree(t, [shipment], 1);
    assert.equal(report.shipments[0].packedQuantity, report.shipments[0].expectedQuantity);
    assert.deepEqual(new Set(report.errors.map(e => e.code)), new Set(["MISSING_QUANTITY", "EXCESS_QUANTITY"]));
    shipment.parcels[0].items[0].sku = originalSku;
    reportsAgree(t, [shipment], 0);

    const second = structuredClone(shipment);
    second.id = "SECOND";
    second.parcels.forEach((parcel, i) => { if (i > 0) parcel.id = `SECOND-${i}`; });
    report = reportsAgree(t, [shipment, second], 1);
    assert.equal(report.ready, 0);
    assert.equal(report.errors.filter(e => e.code === "DUPLICATE_PARCEL").length, 2);
    assert.equal(readFileSync(orderFile, "utf8"), raw);
  });
}

test("shared JSON boundary retains different zero, shape, default and error rules", t => {
  for (const token of ["0", "-0", "1.0", "300e-2", "1.0000000000000001", "1e-400"]) {
    const order = `{"items":[{"sku":"A","quantity":${token}}],"maxItemsPerBox":3e0}`;
    const batch = `[{"id":"S","order":[{"sku":"A","quantity":${token}}],"parcels":[{"id":"P","items":[{"sku":"A","quantity":${token}}]}]}]`;
    const exact = ["0", "-0", "1.0", "300e-2"].includes(token);
    for (const mode of ["mixed", "single-sku"]) {
      for (const summary of [[], ["--summary"]]) {
        const result = run("packaging-cli.js", ["--mode", mode, ...summary, "--json"], order);
        assert.equal(result.status, exact ? 0 : 1, token);
        if (!exact) { assert.equal(result.stdout, ""); assert.ok(result.stderr.includes("items[0].quantity")); }
      }
    }
    for (const flags of [[], ["--json"], ["--html"]]) {
      const result = run("fulfill.js", [...flags, "-"], batch);
      assert.equal(result.status, ["1.0", "300e-2"].includes(token) ? 0 : 1, token);
      assert.equal(result.stderr, "");
      if (result.status === 1) assert.match(result.stdout, /INVALID_QUANTITY/);
    }
  }
  assert.equal(run("packaging-cli.js", [], '{"items":[],"maxItemsPerBox":1}').status, 0);
  assert.ok(reportsAgree(t, [{ id: "S", order: [], parcels: [] }], 1).errors.some(e => e.code === "INVALID_ITEMS"));
  assert.equal(run("fulfill.js", [], "[]").status, 2, "fulfillment still requires an explicit input argument");
  for (const [cli, args, status] of [["packaging-cli.js", [], 1], ["fulfill.js", ["-"], 2]]) {
    const result = run(cli, args, '{"quantity":1.0000000000000001,}');
    assert.equal(result.status, status);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /JSON/);
  }
});

test("parseBatchJson keeps its exported value contract after scanner sharing", () => {
  const raw = String.raw`{"quantity":1.0000000000000001,"other":1.0000000000000001,"maxItemsPerBox":2.9999999999999999,"nested":{"quantity":-1.0000000000000001},"underflow":{"quantity":-1e-400},"duplicate":{"quantity":1.0000000000000001,"quanti\u0074y":1e0},"text":"quantity:1.0000000000000001","__proto__":{"quantity":1.0000000000000001}}`;
  let coercions = 0;
  const parsed = parseBatchJson({ toString() { coercions += 1; return raw; } });
  assert.equal(coercions, 1);
  const native = JSON.parse(raw);
  native.quantity = NaN;
  native.__proto__.quantity = NaN;
  assert.deepEqual(parsed, native);
  assert.ok(Object.is(parsed.underflow.quantity, -0));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parseBatchJson("1.0000000000000001"), 1);
  assert.deepEqual(parseBatchJson("[1.0000000000000001]"), [1]);
});

test("escape-heavy metadata preserves counts and source-labelled diagnostics", t => {
  const metadata = JSON.stringify("\\".repeat(5_000_000) + '"quantity":1.0000000000000001');
  for (const token of ["1.0", "1.0000000000000001", "1e-400"]) {
    const plain = `{"items":[{"sku":"A","quantity":${token}}],"maxItemsPerBox":2}`;
    const raw = plain.slice(0, -1) + `,"metadata":${metadata}}`;
    const file = fixture(t, "escape-heavy.json", raw);
    for (const mode of ["mixed", "single-sku"]) {
      for (const output of [[], ["--json"], ["--summary"], ["--summary", "--json"]]) {
        const args = ["--mode", mode, ...output];
        const expected = run("packaging-cli.js", args, plain);
        const detail = "items[0].quantity must be a non-negative safe integer\n";
        assert.equal(expected.status, token === "1.0" ? 0 : 1);
        assert.equal(expected.stderr, token === "1.0" ? "" : "packaging: standard input: " + detail);
        for (const [source, label] of [[file, JSON.stringify(file)], ["-", "standard input"]]) {
          const result = run("packaging-cli.js", [...args, source], raw);
          assert.equal(result.status, expected.status);
          assert.equal(result.stdout, expected.stdout);
          assert.equal(result.stderr, token === "1.0" ? "" : "packaging: " + label + ": " + detail);
        }
      }
    }
  }
});
