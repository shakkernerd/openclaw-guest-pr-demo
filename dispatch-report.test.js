"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { createDispatchReport } = require("./dispatch-report.js");

const cli = join(__dirname, "dispatch-report.js");
const samplePath = join(__dirname, "examples", "orders.json");
const sample = require("./examples/orders.json");
const expectedSample = [
  "Dispatch report",
  "Orders: 3",
  "Total items: 4",
  "",
  "1. ORD-003 | Ada Lovelace | 1 item",
  "2. ORD-001 | Grace Hopper | 3 items",
  "3. ORD-002 | Katherine Johnson | 0 items",
].join("\n");
const emptyReport = "Dispatch report\nOrders: 0\nTotal items: 0\n\nNo orders to dispatch.";
const expectedSelection = [
  "Dispatch report",
  "Orders: 2",
  "Total items: 1",
  "",
  "1. ORD-003 | Ada Lovelace | 1 item",
  "2. ORD-002 | Katherine Johnson | 0 items",
].join("\n");

function order(overrides = {}) {
  return { id: "ORD-1", recipient: "Ada Lovelace", itemCount: 1, ...overrides };
}

function runCli(args, cwd = __dirname) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-report-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runInput(t, content, args = []) {
  const directory = tempDirectory(t);
  const filename = "orders with spaces.json";
  writeFileSync(join(directory, filename), content);
  return runCli([filename, ...args], directory);
}

function assertFailure(result, message) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Error: /);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
}

test("report preserves input order and formats singular, plural, and zero labels", () => {
  assert.equal(createDispatchReport(sample), expectedSample);
});

test("empty batch produces a useful report", () => {
  assert.equal(createDispatchReport([]), emptyReport);
});

test("text is trimmed, extra fields ignored, and input left unchanged", () => {
  const batch = Object.freeze([
    Object.freeze(order({ id: " ORD-1 ", recipient: " Zoë 李 ", note: "ignored" })),
  ]);
  assert.equal(createDispatchReport(batch), "Dispatch report\nOrders: 1\nTotal items: 1\n\n1. ORD-1 | Zoë 李 | 1 item");
  assert.equal(batch[0].id, " ORD-1 ");
  assert.equal(batch[0].recipient, " Zoë 李 ");
});

test("rejects non-array batches", () => {
  for (const value of [undefined, null, {}, "orders", 1, true]) {
    assert.throws(() => createDispatchReport(value), /Orders must be a JSON array/);
  }
});

test("rejects non-object orders with their input position", () => {
  for (const value of [undefined, null, [], "order", 1, true]) {
    assert.throws(() => createDispatchReport([order(), value]), /Order 2: must be an object/);
  }
});

for (const field of ["id", "recipient"]) {
  test("rejects missing or invalid " + field, () => {
    const message = new RegExp("Order 2: " + field + " must be a nonempty string");
    const missing = order({ id: "ORD-2" });
    delete missing[field];
    assert.throws(() => createDispatchReport([order(), missing]), message);
    for (const value of [undefined, null, "", "   ", 123, false, [], {}]) {
      assert.throws(() => createDispatchReport([order(), order({ id: "ORD-2", [field]: value })]), message);
    }
  });

  test("rejects line breaks and control characters in " + field, () => {
    for (const control of ["\n", "\r", "\t", "\0", "\x1b", "\x7f", "\x85", "\u2028", "\u2029"]) {
      assert.throws(
        () => createDispatchReport([order({ [field]: "A" + control + "B" })]),
        new RegExp("Order 1: " + field + " must be a single line without control characters"),
      );
    }
  });
}

test("rejects missing or invalid item counts without coercion", () => {
  const message = /Order 2: itemCount must be a nonnegative safe integer/;
  const missing = order({ id: "ORD-2" });
  delete missing.itemCount;
  assert.throws(() => createDispatchReport([order(), missing]), message);
  for (const value of [undefined, null, -1, 1.5, "3", "", true, [], {}, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createDispatchReport([order(), order({ id: "ORD-2", itemCount: value })]), message);
  }
});

test("accepts the maximum safe integer count", () => {
  assert.match(createDispatchReport([order({ itemCount: Number.MAX_SAFE_INTEGER })]), /9007199254740991 items$/);
});

test("rejects duplicate IDs, including surrounding whitespace", () => {
  for (const id of ["ORD-1", " ORD-1 "]) {
    assert.throws(
      () => createDispatchReport([order(), order({ id, recipient: "Grace Hopper" })]),
      /Order 2: duplicate id "ORD-1"/,
    );
  }
});

test("IDs are case-sensitive and object-property names are valid IDs", () => {
  const ids = ["A", "a", "__proto__", "constructor"];
  assert.match(createDispatchReport(ids.map((id) => order({ id }))), /Orders: 4/);
  assert.throws(
    () => createDispatchReport([order({ id: "__proto__" }), order({ id: "__proto__" })]),
    /duplicate id "__proto__"/,
  );
});

test("CLI prints the sample report and succeeds", () => {
  const result = runCli([samplePath]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, expectedSample + "\n");
});

test("CLI accepts paths with spaces relative to the working directory", (t) => {
  const result = runInput(t, JSON.stringify([order()]));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, createDispatchReport([order()]) + "\n");
});

test("CLI handles an empty batch successfully", (t) => {
  const result = runInput(t, "[]");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, emptyReport + "\n");
});

test("CLI rejects missing and extra arguments with usage", () => {
  for (const args of [[], [samplePath, "extra.json"]]) {
    assertFailure(runCli(args), /Usage: node dispatch-report\.js <orders\.json>/);
  }
});

test("CLI reports unreadable input files", (t) => {
  const missing = join(tempDirectory(t), "missing.json");
  assertFailure(runCli([missing]), /Cannot read orders file .*missing\.json/);
});

test("CLI rejects malformed or empty JSON files", (t) => {
  for (const source of ["", "[{", '[{"id":"ORD-1",}]']) {
    assertFailure(runInput(t, source), /Invalid JSON in "orders with spaces\.json"/);
  }
});

test("CLI rejects invalid batches without printing a partial report", (t) => {
  const cases = [
    [{}, /Orders must be a JSON array/],
    [[order(), null], /Order 2: must be an object/],
    [[order(), { recipient: "Grace", itemCount: 3 }], /Order 2: id/],
    [[order(), { id: "ORD-2", itemCount: 3 }], /Order 2: recipient/],
    [[order(), { id: "ORD-2", recipient: "Grace" }], /Order 2: itemCount/],
    [[order(), order({ id: "ORD-2", itemCount: -1 })], /Order 2: itemCount/],
    [[order(), order()], /Order 2: duplicate id "ORD-1"/],
  ];
  for (const [batch, message] of cases) {
    assertFailure(runInput(t, JSON.stringify(batch)), message);
  }
});


test("selection keeps batch order, renumbers rows, and totals only reported orders", () => {
  assert.equal(createDispatchReport(sample, ["ORD-002", "ORD-003"]), expectedSelection);
});

test("repeated selected IDs are trimmed and reported only once", () => {
  const ids = Object.freeze(["ORD-002", "ORD-003", " ORD-002 ", "ORD-003"]);
  const batch = Object.freeze(sample.map((entry) => Object.freeze({ ...entry })));
  assert.equal(createDispatchReport(batch, ids), expectedSelection);
});

test("selection matches trimmed batch IDs without changing internal spaces", () => {
  const batch = [order({ id: " ORD WALK IN " })];
  assert.match(createDispatchReport(batch, [" ORD WALK IN "]), /1\. ORD WALK IN \| Ada Lovelace \| 1 item$/);
  assert.throws(() => createDispatchReport(batch, ["ORD WALK  IN"]), /Unknown order IDs: "ORD WALK  IN"/);
});

test("unknown selected IDs fail clearly, including on empty batches", () => {
  assert.throws(
    () => createDispatchReport(sample, ["ORD-003", "MISSING", "ALSO-MISSING"]),
    /Unknown order IDs: "MISSING", "ALSO-MISSING"/,
  );
  assert.throws(() => createDispatchReport(sample, ["ord-003"]), /Unknown order IDs: "ord-003"/);
  assert.throws(() => createDispatchReport([], ["ORD-003"]), /Unknown order IDs: "ORD-003"/);
});

test("empty selections report zero orders and zero items", () => {
  assert.equal(createDispatchReport(sample, []), emptyReport);
  assert.equal(createDispatchReport([], []), emptyReport);
});

test("selecting a zero-count order reports an exact zero total", () => {
  assert.equal(
    createDispatchReport(sample, ["ORD-002"]),
    "Dispatch report\nOrders: 1\nTotal items: 0\n\n1. ORD-002 | Katherine Johnson | 0 items",
  );
});

test("selection still validates every input order and keeps original error positions", () => {
  const invalid = [
    [null, /Order 2: must be an object/],
    [{ recipient: "Grace", itemCount: 3 }, /Order 2: id/],
    [{ id: "ORD-2", itemCount: 3 }, /Order 2: recipient/],
    [{ id: "ORD-2", recipient: "Grace" }, /Order 2: itemCount/],
    [order({ id: "ORD-2", itemCount: -1 }), /Order 2: itemCount/],
    [order({ id: "ORD-2", recipient: "Grace\nHopper" }), /Order 2: recipient/],
    [order({ id: "ORD-2", itemCount: Number.MAX_SAFE_INTEGER + 1 }), /Order 2: itemCount/],
  ];
  for (const [entry, message] of invalid) {
    for (const ids of [["ORD-1"], [], ["UNKNOWN"]]) {
      assert.throws(() => createDispatchReport([order(), entry], ids), message);
    }
  }
  const duplicate = [order(), order({ id: "OTHER" }), order({ id: " OTHER " })];
  assert.throws(() => createDispatchReport(duplicate, ["ORD-1"]), /Order 3: duplicate id "OTHER"/);
});

test("selection rejects invalid containers and invalid ID values", () => {
  for (const value of [null, {}, "ORD-1", 1, true]) {
    assert.throws(() => createDispatchReport([order()], value), /Selected IDs must be an array of strings/);
  }
  for (const value of [undefined, null, "", " ", 1, false, [], {}]) {
    assert.throws(() => createDispatchReport([order()], [value]), /Selected ID 1 must be a nonempty string/);
  }
  assert.throws(() => createDispatchReport([order()], ["ORD\n1"]), /Selected ID 1 must be a single line/);
});

test("totals remain exact beyond the safe integer limit for full and selected reports", () => {
  const large = require("./examples/orders-large-counts.json");
  assert.match(createDispatchReport(large), /\nTotal items: 9007199254740993\n/);
  const batch = [...large, order({ id: "EXCLUDED", itemCount: 10 })];
  assert.match(
    createDispatchReport(batch, ["ORD-EXTRA-2", "ORD-LARGE", "ORD-EXTRA-1", "ORD-LARGE"]),
    /\nOrders: 3\nTotal items: 9007199254740993\n/,
  );
  assert.match(createDispatchReport(batch), /\nTotal items: 9007199254741003\n/);
});

test("CLI repeated --id options deduplicate and preserve batch order with consecutive numbering", () => {
  const result = runCli([samplePath, "--id", "ORD-002", "--id", "ORD-003", "--id", " ORD-002 "]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, expectedSelection + "\n");
});

test("CLI accepts the documented ID containing spaces", () => {
  const result = runCli([join(__dirname, "examples", "orders-with-spaces.json"), "--id", "ORD WALK IN"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Dispatch report\nOrders: 1\nTotal items: 2\n\n1. ORD WALK IN | Walk-in desk | 2 items\n");
});

test("CLI supports --id=value, including IDs beginning with dashes", (t) => {
  const result = runInput(t, JSON.stringify([order({ id: "--desk" })]), ["--id=--desk"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /1\. --desk \| Ada Lovelace \| 1 item\n$/);
  const selected = runCli([samplePath, "--id=ORD-002", "--id=ORD-003"]);
  assert.equal(selected.status, 0);
  assert.equal(selected.stderr, "");
  assert.equal(selected.stdout, expectedSelection + "\n");
});

test("CLI unknown IDs fail without a partial report", (t) => {
  assertFailure(
    runCli([samplePath, "--id", "ORD-003", "--id", "UNKNOWN", "--id", "ALSO-UNKNOWN"]),
    /Unknown order IDs: "UNKNOWN", "ALSO-UNKNOWN"/,
  );
  assertFailure(runInput(t, "[]", ["--id", "UNKNOWN"]), /Unknown order IDs: "UNKNOWN"/);
});

test("CLI selection does not hide invalid or duplicate unselected orders", (t) => {
  const cases = [
    [[order(), order({ id: "OTHER", itemCount: -1 })], /Order 2: itemCount/],
    [[order(), { id: "OTHER", itemCount: 1 }], /Order 2: recipient/],
    [[order(), order({ id: "OTHER" }), order({ id: "OTHER" })], /Order 3: duplicate id "OTHER"/],
  ];
  for (const [batch, message] of cases) {
    assertFailure(runInput(t, JSON.stringify(batch), ["--id", "ORD-1"]), message);
  }
});

test("CLI rejects missing ID values, blank IDs, and unsupported options", () => {
  const cases = [
    [[samplePath, "--id"], /--id requires an order ID/],
    [[samplePath, "--id", "--id", "ORD-003"], /--id requires an order ID/],
    [[samplePath, "--ids", "ORD-003"], /Unexpected argument "--ids"/],
    [[samplePath, "--id", ""], /Selected ID 1 must be a nonempty string/],
    [[samplePath, "--id", "   "], /Selected ID 1 must be a nonempty string/],
    [[samplePath, "--id="], /Selected ID 1 must be a nonempty string/],
    [["--id", "ORD-003"], /Usage: node dispatch-report/],
  ];
  for (const [args, message] of cases) {
    assertFailure(runCli(args), message);
  }
});

test("CLI large-count example prints the exact total as plain decimal", () => {
  const result = runCli([join(__dirname, "examples", "orders-large-counts.json")]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\nTotal items: 9007199254740993\n/);
});
