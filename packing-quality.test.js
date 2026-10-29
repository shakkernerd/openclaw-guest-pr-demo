"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { validateDispatch, formatChecklist, formatCsv, formatHtml } = require("./packing-quality.js");

const fixturePath = join(__dirname, "examples", "dispatch.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const cliPath = join(__dirname, "packing-quality.js");

function parcel() {
  return structuredClone(fixture.parcels[0]);
}

function reportFor(value) {
  return validateDispatch({ parcels: [value] });
}

function hasIssue(report, path) {
  assert.ok(report.issues.some((issue) => issue.path === path), "expected issue at " + path);
  assert.equal(report.ok, false);
}

function run(args, cwd = __dirname) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function tempDirectory(t) {
  const directory = mkdtempSync(join(__dirname, ".packing-quality-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("synthetic dispatch passes with exact parcel/item totals and existing item labels", () => {
  const before = structuredClone(fixture);
  const report = validateDispatch(fixture);
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.totals, { parcels: 2, items: 4n, readyItems: 4n, uncounted: 0, ready: 2 });
  const output = formatChecklist(report);
  assert.match(output, /Parcels: 2 \| Items: 4 \| Ready: 2 \| Needs attention: 0/);
  assert.match(output, /Contents: 3 items \(order: 3 items\)/);
  assert.match(output, /Contents: 1 item \(order: 1 item\)/);
  assert.equal((output.match(/\[x\]/g) || []).length, 20);
  assert.match(output, /Anomalies: none\n\nResult: READY/);
  assert.match(output, /Ready-to-dispatch items: 4/);
  assert.deepEqual(fixture, before, "validation must not mutate the input");
});

test("punctuation, non-ASCII, decomposed characters and surrounding spaces are preserved", () => {
  const value = parcel();
  value.recipient = "  D’Arcy & Zoë / Jose\u0301 — 李・نور 📦  ";
  value.address = {
    street: "42/B Rue de l’Exemple, Apt. #5 — 東京",
    city: "São Paulo",
    region: "Île-de-France",
    postcode: "〒000-0000",
    country: "日本 / Côte d’Ivoire",
  };
  const report = reportFor(value);
  assert.equal(report.ok, true);
  const output = formatChecklist(report);
  for (const text of [value.recipient, ...Object.values(value.address)]) {
    assert.ok(output.includes(text), "preserve " + text);
  }
});

test("requires an object with a non-empty parcels array", () => {
  for (const input of [undefined, null, [], "parcel", 12, true, {}, { parcels: null }, { parcels: {} }, { parcels: [] }]) {
    const report = validateDispatch(input);
    hasIssue(report, "parcels");
    assert.equal(report.totals.parcels, 0);
    assert.match(formatChecklist(report), /Result: NEEDS ATTENTION/);
  }
});

test("invalid parcel entries do not hide later valid entries or imply zero items", () => {
  for (const invalid of [null, [], "parcel", 42, false]) {
    const report = validateDispatch({ parcels: [invalid, parcel()] });
    hasIssue(report, "parcels[0]");
    assert.deepEqual(report.totals, { parcels: 2, items: 3n, readyItems: 3n, uncounted: 1, ready: 1 });
    assert.match(formatChecklist(report), /Items: 3 \(partial; 1 uncounted parcel\(s\)\)/);
    assert.match(formatChecklist(report), /Parcel 2 — E10-001 \[READY\]/);
  }
});

test("required identity and address fields reject missing, blank and non-string values", () => {
  for (const key of ["id", "recipient", "street", "postcode", "country"]) {
    for (const invalid of [undefined, null, "", " \t ", 123, false, [], {}]) {
      const value = parcel();
      const parent = key === "id" || key === "recipient" ? value : value.address;
      const path = "parcels[0]." + (parent === value ? "" : "address.") + key;
      if (invalid === undefined) delete parent[key];
      else parent[key] = invalid;
      hasIssue(reportFor(value), path);
    }
  }
});

test("address must be an object and optional city/region must be valid when supplied", () => {
  for (const invalid of [undefined, null, [], "address", 12]) {
    const value = parcel();
    value.address = invalid;
    hasIssue(reportFor(value), "parcels[0].address");
  }
  const value = parcel();
  delete value.address.city;
  assert.equal(reportFor(value).ok, true);
  for (const key of ["city", "region"]) {
    for (const invalid of ["", 12, null]) {
      const value = parcel();
      value.address[key] = invalid;
      hasIssue(reportFor(value), "parcels[0].address." + key);
    }
  }
});

test("counts must be positive safe integers, without coercion", () => {
  for (const key of ["itemCount", "orderItemCount"]) {
    for (const invalid of [undefined, null, 0, -0, -1, 1.5, "3", true, [], {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const value = parcel();
      value[key] = invalid;
      const report = reportFor(value);
      hasIssue(report, "parcels[0]." + key);
      assert.equal(report.totals.uncounted, key === "itemCount" ? 1 : 0);
      assert.match(formatChecklist(report), /unknown \(invalid count\)/);
    }
  }
});

test("mismatched counts give a corrective action and still total known packed items", () => {
  const value = parcel();
  value.itemCount = 2;
  const report = reportFor(value);
  hasIssue(report, "parcels[0].itemCount");
  assert.equal(report.totals.items, 2n);
  assert.equal(report.totals.readyItems, 0n);
  assert.equal(report.totals.ready, 0);
  assert.match(formatChecklist(report), /packed count 2 does not match orderItemCount 3; reconcile/);
  assert.match(formatChecklist(report), /\[ \] Item count matches order/);
});

test("large valid item totals do not silently lose integer precision", () => {
  const first = parcel();
  first.itemCount = first.orderItemCount = Number.MAX_SAFE_INTEGER;
  const second = structuredClone(first);
  second.id = "E10-LARGE-2";
  const third = parcel();
  third.id = "E10-LARGE-3";
  third.itemCount = third.orderItemCount = 1;
  const report = validateDispatch({ parcels: [first, second, third] });
  assert.equal(report.ok, true);
  assert.equal(report.totals.items, 18014398509481983n);
  assert.equal(report.totals.readyItems, 18014398509481983n);
  assert.match(formatChecklist(report), /Ready-to-dispatch items: 18014398509481983/);
  assert.match(formatChecklist(report), /Items: 18014398509481983/);
});

test("every packing and label confirmation requires explicit boolean true", () => {
  for (const key of Object.keys(parcel().checks)) {
    for (const invalid of [undefined, false, null, "true", 1, [], {}]) {
      const value = parcel();
      if (invalid === undefined) delete value.checks[key];
      else value.checks[key] = invalid;
      const report = reportFor(value);
      hasIssue(report, "parcels[0].checks." + key);
      assert.equal(report.totals.ready, 0);
      assert.match(report.issues[0].message, /must be explicitly true \(boolean\).*then record true/);
    }
  }
});

test("missing or malformed checks cannot imply that packing is complete", () => {
  for (const invalid of [undefined, null, [], true, "true"]) {
    const value = parcel();
    value.checks = invalid;
    const report = reportFor(value);
    hasIssue(report, "parcels[0].checks");
    assert.equal(report.entries[0].checks.filter((check) => !check.passed).length, 6);
  }
  const value = parcel();
  value.checks = {};
  assert.equal(reportFor(value).issues.length, 6);
});

test("duplicate parcel IDs mark every occurrence, including the first", () => {
  const first = parcel();
  first.id = "__proto__";
  const second = structuredClone(first);
  const report = validateDispatch({ parcels: [first, second] });
  hasIssue(report, "parcels[0].id");
  hasIssue(report, "parcels[1].id");
  assert.equal(report.totals.ready, 0);
  assert.equal(report.entries[0].checks[0].passed, false);
  assert.equal(report.entries[1].checks[0].passed, false);
  second.id = "__PROTO__";
  assert.equal(validateDispatch({ parcels: [first, second] }).ok, true);
});

test("all anomalies are collected with indexed paths and corrective actions", () => {
  const first = parcel();
  first.recipient = "";
  first.address.postcode = "";
  first.checks.sealed = false;
  const second = parcel();
  second.id = "E10-BAD-2";
  second.checks.labelAttached = false;
  const report = validateDispatch({ parcels: [first, second] });
  assert.deepEqual(report.issues.map((issue) => issue.path), [
    "parcels[0].recipient", "parcels[0].address.postcode", "parcels[0].checks.sealed", "parcels[1].checks.labelAttached",
  ]);
  const output = formatChecklist(report);
  assert.match(output, /Seal the parcel, then record true/);
  assert.match(output, /Securely attach the label, then record true/);
  assert.match(output, /Anomalies \(4\)/);
});

test("terminal controls, bidi overrides and unpaired surrogates are rejected and escaped", () => {
  for (const control of ["\u001b", "\n", "\r", "\t", "\u0000", "\u0085", "\u2028", "\u202e", "\u2066", "\ud800", "\udfff"]) {
    const value = parcel();
    value.recipient = "Name" + control + "Forged";
    const report = reportFor(value);
    hasIssue(report, "parcels[0].recipient");
    const output = formatChecklist(report);
    assert.ok(output.includes("Name\\u" + control.codePointAt(0).toString(16).padStart(4, "0") + "Forged"));
    assert.ok(!output.includes(value.recipient));
  }
});

test("unrelated metadata is ignored without changing validation or output", () => {
  const value = parcel();
  value.orderReference = "metadata";
  value.address.notes = "not a supported address field";
  assert.equal(formatChecklist(reportFor(value)), formatChecklist(reportFor(parcel())));
});

test("CLI success prints the checklist to stdout, preserves the file and exits 0", () => {
  const before = readFileSync(fixturePath);
  const result = run([fixturePath]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, formatChecklist(validateDispatch(fixture)));
  assert.ok(result.stdout.includes("Zoë O’Example"));
  assert.ok(result.stdout.includes("見本町 1-2-3, 例示ビル #5"));
  assert.deepEqual(readFileSync(fixturePath), before);
});

test("CLI validation anomalies print to stdout and exit 1", () => {
  const result = run([join(__dirname, "examples", "dispatch-needs-attention.json")]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Parcels: 1 \| Items: 1 \| Ready: 0 \| Needs attention: 1/);
  assert.match(result.stdout, /Anomalies \(3\)/);
  assert.match(result.stdout, /Ready-to-dispatch items: 0/);
  assert.match(result.stdout, /parcels\[0\]\.address.postcode/);
  assert.match(result.stdout, /parcels\[0\]\.itemCount/);
  assert.match(result.stdout, /parcels\[0\]\.checks.labelAttached/);
  assert.match(result.stdout, /Result: NEEDS ATTENTION/);
});

test("CLI help exits 0; missing, extra and unknown arguments exit 2", () => {
  for (const flag of ["--help", "-h"]) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage:/);
    assert.equal(result.stderr, "");
  }
  for (const args of [[], ["--unknown"], [""], [fixturePath, fixturePath], ["--help", fixturePath]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error: expected one dispatch JSON file/);
    assert.match(result.stderr, /Usage:/);
  }
});

test("CLI unreadable paths and malformed JSON give useful errors and exit 2", (t) => {
  const directory = tempDirectory(t);
  const missing = run([join(directory, "absent.json")]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /cannot read .*ENOENT.*Check the path and read permissions/);
  const asDirectory = run([directory]);
  assert.equal(asDirectory.status, 2);
  for (const [index, source] of ["", "{", '{"parcels": [],}', '{"secret-recipient":'].entries()) {
    const file = join(directory, "invalid-" + index + ".json");
    writeFileSync(file, source);
    const result = run([file]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error: invalid JSON .*Check JSON syntax/);
    assert.doesNotMatch(result.stderr, /secret-recipient|SyntaxError|\n\s+at /);
  }
});

test("CLI parsed but invalid schema exits 1 rather than a JSON parsing error", (t) => {
  const directory = tempDirectory(t);
  for (const [index, value] of [null, [], {}, { parcels: [] }, { parcels: [null] }].entries()) {
    const file = join(directory, "schema-" + index + ".json");
    writeFileSync(file, JSON.stringify(value));
    const result = run([file]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Result: NEEDS ATTENTION/);
  }
});

test("CLI accepts UTF-8 BOM and filenames with spaces or a leading dash", (t) => {
  const directory = tempDirectory(t);
  for (const name of ["dispatch with spaces.json", "-dispatch.json"]) {
    writeFileSync(join(directory, name), "\ufeff" + JSON.stringify(fixture));
    const result = run(["./" + name], directory);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, formatChecklist(validateDispatch(fixture)));
  }
});

test("CLI rejects invalid UTF-8 rather than silently corrupting a recipient", (t) => {
  const directory = tempDirectory(t);
  const file = join(directory, "invalid-utf8.json");
  writeFileSync(file, Buffer.concat([Buffer.from('{"recipient":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]));
  const result = run([file]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /not valid UTF-8.*Save the dispatch file as UTF-8/);
});

test("importing the CLI library does not execute the command", () => {
  const result = spawnSync(process.execPath, ["-e", "require('./packing-quality.js')"], { cwd: __dirname, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

const CSV_HEADER = ["id", "recipient", "street", "city", "region", "postcode", "country", "itemCount", "readiness", "anomalies"];

// Independent decoder for assertions: enforce one physical CRLF record per row,
// while honoring CSV quoted commas and doubled quotes within each field.
function csvRows(output) {
  assert.ok(output.endsWith("\r\n"));
  assert.doesNotMatch(output.replaceAll("\r\n", ""), /[\r\n]/);
  return output.slice(0, -2).split("\r\n").map((line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"') {
        if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = !quoted;
      } else if (line[i] === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += line[i];
    }
    assert.equal(quoted, false, "CSV quotes must balance");
    cells.push(cell);
    assert.equal(cells.length, CSV_HEADER.length, "stable column count");
    return cells;
  });
}

function writeDispatch(t, data) {
  const file = join(tempDirectory(t), "dispatch handoff.json");
  writeFileSync(file, JSON.stringify(data));
  return file;
}

test("CLI CSV, generated fixture and README agree with JSON rows in input order", () => {
  const before = readFileSync(fixturePath);
  const result = run(["--csv", fixturePath]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(csvRows(result.stdout), [CSV_HEADER, ...fixture.parcels.map((value) => [
    value.id, value.recipient, value.address.street, value.address.city, "", value.address.postcode,
    value.address.country, String(value.itemCount), "READY", "",
  ])]);
  assert.equal(result.stdout, run([fixturePath, "--csv"]).stdout);
  assert.equal(result.stdout, formatCsv(validateDispatch(fixture)));
  const savedCsv = readFileSync(join(__dirname, "examples", "packing-handoff.csv"));
  assert.deepEqual(savedCsv, Buffer.from(result.stdout, "utf8"), "generated fixture must match actual CLI bytes");
  const readme = readFileSync(join(__dirname, "README.md"), "utf8").replaceAll("\r\n", "\n");
  const documentedCsv = readme.match(/```csv\n([\s\S]*?)```/);
  assert.ok(documentedCsv, "README must include the successful CSV example");
  assert.equal(result.stdout.replaceAll("\r\n", "\n"), documentedCsv[1]);
  assert.ok(readme.includes("node packing-quality.js --csv examples/dispatch.json > examples/packing-handoff.csv"));

  assert.doesNotMatch(result.stdout, /packing checklist|Result:|Ready-to-dispatch items:/);
  assert.deepEqual(readFileSync(fixturePath), before);
});

test("CLI CSV round-trips commas, double quotes, apostrophes and international text", (t) => {
  const value = parcel();
  value.id = 'E10,"Á-2"';
  value.recipient = '  Zoë "Z", O’Example & 李 📦  ';
  value.address = {
    street: '42/B Rue de l’Exemple, "Annexe #5"',
    city: "São Paulo",
    region: "Île-de-France / Jose\u0301",
    postcode: "00123",
    country: "Côte d’Ivoire",
  };
  const file = writeDispatch(t, { parcels: [value] });
  const before = readFileSync(file);
  const result = run(["--csv", file]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(csvRows(result.stdout)[1], [
    value.id, value.recipient, value.address.street, value.address.city, value.address.region,
    value.address.postcode, value.address.country, "3", "READY", "",
  ]);
  assert.ok(result.stdout.includes('"E10,""Á-2"""'));
  assert.ok(result.stdout.includes('"  Zoë ""Z"", O’Example & 李 📦  "'));
  assert.deepEqual(readFileSync(file), before);
});

test("CLI CSV neutralizes formulas in every input text column, before leading whitespace", (t) => {
  const prefixes = ["", " ", "  ", "\u00a0", "\u2003", "\ufeff", "\u200b"];
  const values = [];
  const parcels = [];
  for (const prefix of prefixes) {
    for (const operator of ["=", "+", "-", "@"]) {
      const text = prefix + operator + 'SUM(1,2)&"' + parcels.length + '"';
      values.push(text);
      const value = parcel();
      value.id = value.recipient = text;
      for (const field of ["street", "city", "region", "postcode", "country"]) value.address[field] = text;
      parcels.push(value);
    }
  }
  const file = writeDispatch(t, { parcels });
  const original = readFileSync(file);
  const result = run(["--csv", file]);
  assert.equal(result.status, 0, "spreadsheet protection must not invent validation anomalies");
  assert.equal(result.stderr, "");
  const rows = csvRows(result.stdout).slice(1);
  assert.equal(rows.length, values.length);
  for (let i = 0; i < rows.length; i += 1) {
    assert.deepEqual(rows[i].slice(0, 7), Array(7).fill("'" + values[i]));
    assert.deepEqual(rows[i].slice(7), ["3", "READY", ""]);
  }
  assert.deepEqual(readFileSync(file), original, "CSV protection does not rewrite source text");
});

test("CLI CSV escapes controls without adding rows and protects whitespace-prefixed formulas", (t) => {
  const cases = [
    ["\t", "\\u0009"], ["\r", "\\u000d"], ["\n", "\\u000a"], ["\u0000", "\\u0000"],
    ["\u0085", "\\u0085"], ["\u2028", "\\u2028"], ["\u202e", "\\u202e"],
  ];
  const parcels = cases.map(([prefix], i) => {
    const value = parcel();
    value.id = "CONTROLS-" + i;
    value.recipient = prefix + "=1+1";
    return value;
  });
  const result = run(["--csv", writeDispatch(t, { parcels })]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const rows = csvRows(result.stdout).slice(1);
  assert.equal(rows.length, cases.length);
  for (let i = 0; i < rows.length; i += 1) {
    assert.equal(rows[i][1], "'" + cases[i][1] + "=1+1");
    assert.equal(rows[i][8], "NEEDS ATTENTION");
    assert.ok(rows[i][9].startsWith("parcels[" + i + "].recipient: must be single-line"));
  }
});

test("mixed dispatch CSV retains failed/malformed rows; checklist separates ready item totals", (t) => {
  const ready = parcel();
  ready.id = "READY-3";
  const blocked = parcel();
  blocked.id = "BLOCKED-2";
  blocked.itemCount = blocked.orderItemCount = 2;
  blocked.checks.labelAttached = false;
  const duplicate = parcel();
  duplicate.id = "DUPLICATE-1";
  duplicate.itemCount = duplicate.orderItemCount = 1;
  const uncounted = parcel();
  uncounted.id = "UNCOUNTED";
  uncounted.itemCount = "=1+1";
  const data = { parcels: [ready, blocked, duplicate, uncounted, null, structuredClone(duplicate)] };
  const file = writeDispatch(t, data);
  const result = run(["--csv", file]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const rows = csvRows(result.stdout).slice(1);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row[0]), ["READY-3", "BLOCKED-2", "DUPLICATE-1", "UNCOUNTED", "", "DUPLICATE-1"]);
  assert.deepEqual(rows.map((row) => row[7]), ["3", "2", "1", "", "", "1"]);
  assert.deepEqual(rows.map((row) => row[8]), ["READY", ...Array(5).fill("NEEDS ATTENTION")]);
  assert.equal(rows[0][9], "");
  assert.equal(rows[1][9], "parcels[1].checks.labelAttached: must be explicitly true (boolean)");
  assert.equal(rows[2][9], "parcels[2].id: duplicates another parcel ID");
  assert.match(rows[3][9], /^parcels\[3\].itemCount: must be a positive safe integer/);
  assert.equal(rows[4][9], "parcels[4]: must be an object");
  assert.equal(rows[5][9], "parcels[5].id: duplicates another parcel ID");
  const checklist = run([file]);
  assert.equal(checklist.status, 1);
  assert.match(checklist.stdout, /Items: 7 \(partial; 2 uncounted parcel\(s\)\)/);
  assert.match(checklist.stdout, /Ready: 1 \| Needs attention: 5/);
  assert.match(checklist.stdout, /Ready-to-dispatch items: 3/);
  assert.deepEqual(validateDispatch(data).totals, { parcels: 6, items: 7n, readyItems: 3n, uncounted: 2, ready: 1 });
});

test("formatters use supplied validation decisions without revalidating", () => {
  const report = reportFor(parcel());
  // Deliberately override decisions to prove formatting consumes the report,
  // not a second pass that guesses readiness from the raw valid parcel.
  report.entries[0].counted = false;
  report.entries[0].orderCounted = false;
  report.entries[0].issues.push({ path: "parcels[0].checks.sealed", message: "must be explicitly true (boolean). Seal the parcel, then record true." });
  const before = structuredClone(report);
  const row = csvRows(formatCsv(report))[1];
  assert.equal(row[7], "");
  assert.equal(row[8], "NEEDS ATTENTION");
  assert.equal(row[9], "parcels[0].checks.sealed: must be explicitly true (boolean)");
  assert.ok(formatChecklist(report).includes("Contents: unknown (invalid count) (order: unknown (invalid count))"));
  assert.ok(formatHtml(report).includes("<dd>unknown (invalid count) (order: unknown (invalid count))</dd>"));
  assert.deepEqual(report, before);
});

test("CLI CSV failing example keeps all anomalies concise and retains exit 1", () => {
  const result = run(["--csv", join(__dirname, "examples", "dispatch-needs-attention.json")]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const rows = csvRows(result.stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][8], "NEEDS ATTENTION");
  assert.equal(rows[1][9], "parcels[0].address.postcode: must be a non-blank string | " +
    "parcels[0].itemCount: packed count 1 does not match orderItemCount 2 | " +
    "parcels[0].checks.labelAttached: must be explicitly true (boolean)");
});

test("CLI CSV invalid dispatch structure emits header only, a stderr reason and exit 1", (t) => {
  for (const input of [null, [], {}, { parcels: [] }]) {
    const result = run(["--csv", writeDispatch(t, input)]);
    assert.equal(result.status, 1);
    assert.deepEqual(csvRows(result.stdout), [CSV_HEADER]);
    assert.match(result.stderr, /^Validation anomaly: parcels:/);
  }
});

test("CLI CSV rejects bad arguments and input files with exit 2 and no CSV output", (t) => {
  for (const args of [["--csv"], ["--csv", "--csv", fixturePath], ["--csv", "--help"],
    ["--csv", "--unknown", fixturePath], ["--csv", fixturePath, fixturePath], ["--csv", ""]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error: expected one dispatch JSON file/);
  }
  const directory = tempDirectory(t);
  const missing = join(directory, "missing.json");
  const malformed = join(directory, "invalid.json");
  const invalidUtf8 = join(directory, "invalid-utf8.json");
  writeFileSync(malformed, '{"parcels": [}');
  writeFileSync(invalidUtf8, Buffer.from([0xff]));
  for (const [file, message] of [[missing, /cannot read/], [malformed, /invalid JSON/], [invalidUtf8, /not valid UTF-8/]]) {
    const result = run(["--csv", file]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});


// Check our intentionally small HTML vocabulary and nesting without a DOM dependency.
function assertStandaloneHtml(html) {
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.ok(html.endsWith("</html>\n"));
  const allowed = new Set(["html", "head", "meta", "title", "style", "body", "main", "h1", "h2", "h3",
    "section", "p", "strong", "dl", "dt", "dd", "bdi", "ul", "li", "code", "footer"]);
  const stack = [];
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const [, closing, tag] = match;
    assert.ok(allowed.has(tag), "unexpected active HTML tag: " + tag);
    assert.doesNotMatch(match[0], /\s(?:on\w+|href|src|srcset|action)\s*=/i);
    if (closing) assert.equal(stack.pop(), tag, "balanced HTML elements");
    else if (tag !== "meta") stack.push(tag);
  }
  assert.deepEqual(stack, []);
  assert.equal((html.match(/<html\b/g) || []).length, 1);
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.match(html, /<meta charset="utf-8">/);
  assert.ok(html.includes("default-src 'none'"));
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(style, /@import|url\(/i);
  assert.match(style, /@page\s*\{/);
  assert.match(style, /@media print\s*\{/);
  assert.match(style, /break-inside: avoid-page/);
  assert.match(style, /overflow-wrap: anywhere/);
  assert.match(style, /white-space: pre-wrap/);
}

test("CLI HTML is standalone, printable and matches the generated example", () => {
  const before = readFileSync(fixturePath);
  const result = run(["--html", fixturePath]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assertStandaloneHtml(result.stdout);
  assert.equal(result.stdout, formatHtml(validateDispatch(fixture)));
  assert.equal(result.stdout, run([fixturePath, "--html"]).stdout);
  assert.deepEqual(readFileSync(join(__dirname, "examples", "packing-handoff.html")), Buffer.from(result.stdout));
  assert.ok(Buffer.byteLength(result.stdout) < 10000, "keep the generated example small");
  assert.match(result.stdout, /Result: READY<\/h2>/);
  assert.match(result.stdout, /<dt>All counted items<\/dt><dd>4<\/dd>/);
  assert.match(result.stdout, /<dt>Ready-to-dispatch items<\/dt><dd>4<\/dd>/);
  assert.equal((result.stdout.match(/<section class="parcel">/g) || []).length, 2);
  assert.equal((result.stdout.match(/<li>\[x\]/g) || []).length, 20);
  for (const value of ["Zoë O’Example", "山田・サンプル", "見本町 1-2-3, 例示ビル #5", "000-0000", "日本"]) {
    assert.ok(result.stdout.includes(value));
  }
  assert.ok(readFileSync(join(__dirname, "README.md"), "utf8").includes(
    "node packing-quality.js --html examples/dispatch.json > examples/packing-handoff.html"));
  assert.deepEqual(readFileSync(fixturePath), before);
});

test("CLI HTML escapes every input text field, preserving literal markup and Unicode", (t) => {
  const value = parcel();
  const raw = '  =1 < 2 > 0 & "Zoë" \'李\' &lt; </bdi></style><script>alert(1)</script><img src=x onerror=alert(1)>  ';
  const escaped = "  =1 &lt; 2 &gt; 0 &amp; &quot;Zoë&quot; &#39;李&#39; &amp;lt; &lt;/bdi&gt;&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;  ";
  value.id = value.recipient = raw;
  for (const key of ["street", "city", "region", "postcode", "country"]) value.address[key] = raw;
  const file = writeDispatch(t, { parcels: [value] });
  const before = readFileSync(file);
  const result = run(["--html", file]);
  assert.equal(result.status, 0, "HTML encoding must not create validation failures");
  assert.equal(result.stderr, "");
  assertStandaloneHtml(result.stdout);
  assert.equal(result.stdout.split('<bdi class="value">' + escaped + '</bdi>').length - 1, 7);
  assert.doesNotMatch(result.stdout, /<script\b|<img\b/);
  assert.ok(!result.stdout.includes(raw));
  assert.deepEqual(readFileSync(file), before);
});

test("CLI HTML renders formula-looking text literally, without CSV apostrophe prefixes", (t) => {
  const parcels = ["=", "+", "-", "@"].map((operator, i) => {
    const value = parcel();
    value.id = "HTML-FORMULA-" + i;
    value.recipient = "  " + operator + 'SUM(1,2) & "Zoë" <keep>';
    return value;
  });
  const result = run(["--html", writeDispatch(t, { parcels })]);
  assert.equal(result.status, 0);
  assertStandaloneHtml(result.stdout);
  for (const operator of ["=", "+", "-", "@"]) {
    assert.ok(result.stdout.includes('<bdi class="value">  ' + operator + 'SUM(1,2) &amp; &quot;Zoë&quot; &lt;keep&gt;</bdi>'));
  }
});

test("CLI HTML retains mixed readiness, partial totals and actionable per-parcel anomalies", (t) => {
  const ready = parcel();
  ready.id = "READY-3";
  const blocked = parcel();
  blocked.id = "BLOCKED-2";
  blocked.itemCount = blocked.orderItemCount = 2;
  blocked.checks.labelAttached = false;
  const invalidCount = parcel();
  invalidCount.id = "UNCOUNTED";
  invalidCount.itemCount = "2";
  const duplicate = parcel();
  duplicate.id = "DUPLICATE-1";
  duplicate.itemCount = duplicate.orderItemCount = 1;
  const data = { parcels: [ready, blocked, invalidCount, null, duplicate, structuredClone(duplicate)] };
  const result = run(["--html", writeDispatch(t, data)]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assertStandaloneHtml(result.stdout);
  assert.match(result.stdout, /Result: NEEDS ATTENTION<\/h2>/);
  assert.match(result.stdout, /<dt>All counted items<\/dt><dd>7 \(partial; 2 uncounted parcel\(s\)\)<\/dd>/);
  assert.match(result.stdout, /<dt>Ready-to-dispatch items<\/dt><dd>3<\/dd>/);
  assert.match(result.stdout, /<dt>Ready parcels<\/dt><dd>1<\/dd>/);
  assert.match(result.stdout, /<dt>Needs attention<\/dt><dd>5<\/dd>/);
  const parcels = result.stdout.split('<section class="parcel">').slice(1);
  assert.equal(parcels.length, 6);
  for (let i = 0; i < parcels.length; i += 1) {
    assert.ok(parcels[i].startsWith("\n<h2>Parcel " + (i + 1) + " — "));
    assert.ok(parcels[i].includes('<strong>' + (i === 0 ? "READY" : "NEEDS ATTENTION") + '</strong>'));
  }
  assert.ok(parcels[1].includes('<li>[ ] Label securely attached</li>'));
  assert.ok(parcels[1].includes('<code>parcels[1].checks.labelAttached</code>: must be explicitly true (boolean). Securely attach the label, then record true.'));
  assert.ok(parcels[2].includes('unknown (invalid count)'));
  assert.ok(parcels[3].includes('Supply a valid parcel object'));
  assert.ok(parcels[4].includes('assign a unique ID to each physical parcel'));
  assert.ok(parcels[5].includes('assign a unique ID to each physical parcel'));
});

test("HTML escapes check labels and anomaly paths/messages from the supplied report", () => {
  const report = reportFor(parcel());
  report.entries[0].checks[0] = { passed: false, label: '<img src=x> & "check"' };
  const issue = { path: 'parcels[0].<id>', message: 'Use <literal> & "quotes"; do not run <script>.' };
  report.entries[0].issues.push(issue);
  report.issues.push(issue);
  report.ok = false;
  report.totals.ready = 0;
  report.totals.readyItems = 0n;
  const before = structuredClone(report);
  const html = formatHtml(report);
  assertStandaloneHtml(html);
  assert.ok(html.includes('<li>[ ] &lt;img src=x&gt; &amp; &quot;check&quot;</li>'));
  assert.ok(html.includes('<code>parcels[0].&lt;id&gt;</code>: Use &lt;literal&gt; &amp; &quot;quotes&quot;; do not run &lt;script&gt;.'));
  assert.deepEqual(report, before);
});

test("CLI HTML shows dispatch-level errors and safely escapes invalid controls", (t) => {
  for (const data of [null, [], {}, { parcels: [] }]) {
    const result = run(["--html", writeDispatch(t, data)]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assertStandaloneHtml(result.stdout);
    assert.match(result.stdout, /Result: NEEDS ATTENTION/);
    assert.match(result.stdout, /<h2>Dispatch anomalies<\/h2>/);
    assert.match(result.stdout, /<code>parcels<\/code>:/);
    assert.doesNotMatch(result.stdout, /<section class="parcel">/);
  }
  const value = parcel();
  value.recipient = "\u001b\n\ud800<Zoë>";
  value.address = null;
  const result = run(["--html", writeDispatch(t, { parcels: [value] })]);
  assert.equal(result.status, 1);
  assertStandaloneHtml(result.stdout);
  assert.ok(result.stdout.includes('\\u001b\\u000a\\ud800&lt;Zoë&gt;'));
  assert.ok(!result.stdout.includes("\u001b"));
  assert.ok(!result.stdout.includes("\ufffd"));
  assert.ok(result.stdout.includes('(missing or invalid)'));
});

test("CLI output modes are exclusive and reject repeated flags before emitting output", () => {
  for (const args of [
    ["--html", "--csv", fixturePath], ["--csv", fixturePath, "--html"],
    [fixturePath, "--html", "--csv"], ["--html", "--html", fixturePath],
    ["--html"], ["--html", "--help"], ["--html", "--unknown", fixturePath],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /expected one dispatch JSON file and at most one output flag/);
  }
  const plain = run([fixturePath]);
  const csv = run(["--csv", fixturePath]);
  const html = run(["--html", fixturePath]);
  assert.equal(plain.status, 0);
  assert.equal(csv.status, 0);
  assert.equal(html.status, 0);
  assert.equal(plain.stdout, formatChecklist(validateDispatch(fixture)));
  assert.equal(csv.stdout, readFileSync(join(__dirname, "examples", "packing-handoff.csv"), "utf8"));
  assert.match(plain.stdout, /^E10 Dispatch Desk — packing checklist\n/);
  assert.match(csv.stdout, /^id,recipient,street,/);
  assert.match(html.stdout, /^<!doctype html>\n/);
  assert.doesNotMatch(plain.stdout + csv.stdout, /<!doctype html>|<style>/);
  assert.doesNotMatch(html.stdout, /^id,recipient,/m);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[--csv \| --html\]/);
});

test("CLI HTML input errors preserve exit 2 and produce no partial document", (t) => {
  const directory = tempDirectory(t);
  const missing = join(directory, "missing.json");
  const malformed = join(directory, "malformed.json");
  const invalidUtf8 = join(directory, "invalid-utf8.json");
  writeFileSync(malformed, '{"parcels": [}');
  writeFileSync(invalidUtf8, Buffer.from([0xff]));
  for (const [file, diagnostic] of [[missing, /cannot read/], [malformed, /invalid JSON/], [invalidUtf8, /not valid UTF-8/]]) {
    const result = run(["--html", file]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, diagnostic);
  }
});


test("CLI early-closing preview reader keeps validation status without EPIPE noise", async (t) => {
  for (const mixed of [false, true]) {
    const parcels = Array.from({ length: 10000 }, (_, i) => {
      const value = parcel();
      value.id = "PIPE-" + i;
      if (mixed && i % 2) value.checks.sealed = false;
      return value;
    });
    const input = writeDispatch(t, { parcels });
    for (const flags of [[], ["--csv"], ["--html"]]) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cliPath, ...flags, input], {
          stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
        });
        let preview = "", stderr = "", closedEarly = false;
        child.on("error", reject);
        child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
        child.stdout.setEncoding("utf8").on("data", (data) => {
          preview += data;
          if (preview.split("\n").length > 5) {
            preview = preview.split("\n").slice(0, 5).join("\n") + "\n";
            closedEarly = true;
            child.stdout.destroy(); // Same closed-reader condition as head -n 5.
          }
        });
        child.on("close", (status, signal) => resolve({ status, signal, preview, stderr, closedEarly }));
      });
      assert.equal(result.closedEarly, true);
      assert.equal(result.signal, null);
      assert.equal(result.status, mixed ? 1 : 0);
      assert.equal(result.stderr, "");
      assert.equal(result.preview.split("\n").length, 6);
      if (!flags.length) {
        assert.ok(result.preview.includes("Parcels: 10000 | Items: 30000 | Ready: " + (mixed ? 5000 : 10000)));
        assert.ok(result.preview.includes("Ready-to-dispatch items: " + (mixed ? 15000 : 30000)));
      } else if (flags[0] === "--csv") assert.match(result.preview, /^id,recipient,street,/);
      else assert.match(result.preview, /^<!doctype html>\n/);
    }
  }
});

test("CLI other stdout errors remain diagnostic I/O failures, not validation failures", (t) => {
  const hook = join(tempDirectory(t), "stdout-error.cjs");
  writeFileSync(hook, [
    'process.stdout.write = function () {',
    '  process.nextTick(() => this.emit("error", Object.assign(new Error("synthetic write failure"),',
    '    { code: process.env.PACKING_TEST_ERROR || undefined })));',
    '  return false;',
    '};',
  ].join("\n"));
  for (const code of ["ENOSPC", "EIO", ""]) {
    for (const input of [fixturePath, join(__dirname, "examples", "dispatch-needs-attention.json")]) {
      for (const flags of [[], ["--csv"], ["--html"]]) {
        const result = spawnSync(process.execPath, ["--require", hook, cliPath, ...flags, input], {
          encoding: "utf8", env: { ...process.env, PACKING_TEST_ERROR: code },
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "Error: cannot write output (" + (code || "I/O error") +
          "). Check the output destination and available space; the export may be incomplete.\n");
      }
    }
  }
});

test("CLI real full-device output failure exits 2 without a stack trace", {
  skip: process.platform !== "linux" || !existsSync("/dev/full"),
}, () => {
  const fd = openSync("/dev/full", "w");
  try {
    for (const input of [fixturePath, join(__dirname, "examples", "dispatch-needs-attention.json")]) {
      for (const flags of [[], ["--csv"], ["--html"]]) {
        const result = spawnSync(process.execPath, [cliPath, ...flags, input], {
          stdio: ["ignore", fd, "pipe"], encoding: "utf8",
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /^Error: cannot write output \(ENOSPC\)/);
        assert.doesNotMatch(result.stderr, /Unhandled|\n\s+at /);
      }
    }
  } finally { closeSync(fd); }
});
