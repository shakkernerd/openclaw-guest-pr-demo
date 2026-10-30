"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const vm = require("node:vm");

// Only the new production boundary is evaluated. No DOM/browser simulation.
const context = vm.createContext({ TextDecoder });
vm.runInContext(readFileSync(join(__dirname, "saved-batch-report.js"), "utf8"), context);
const SavedBatchReport = vm.runInContext("SavedBatchReport", context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
// Native in-memory File reads for ordinary cases; deferred doubles only for races.
const file = (name, content) => new File([content], name);
const success = (formatted = "") => ({
  total: 1, succeeded: 1, failed: 0,
  results: [{ position: 1, file: "", ok: true, formatted }],
});
const failure = () => ({
  total: 1, succeeded: 0, failed: 1,
  results: [{ position: 1, file: "", ok: false, error: { stage: "read", name: "", message: "" } }],
});
const zero = { total: 0, succeeded: 0, failed: 0, results: [] };
const csvHeader = '"position","file","status","formatted","error_stage","error_name","error_message"\r\n';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { file: { name: "delayed.json", arrayBuffer: () => promise }, resolve, reject };
}

function fixture(name) {
  return readFileSync(join(__dirname, "saved-batch-report-fixtures", name));
}

test("retained success document: exact identity, independent values, duplicate spelling/order", async () => {
  const input = fixture("success-report.json");
  assert.equal(input.length, 294);
  assert.equal(createHash("sha256").update(input).digest("hex"),
    "0c4366856cab2d112cd53c68b95e518b57829a7dae679f241e4f3b891a6c1a6e");
  const original = Buffer.from(input);
  const viewer = new SavedBatchReport(() => {});
  await viewer.selectFile(file("success-report.json", input));
  assert.equal(viewer.status.kind, "accepted");
  assert.equal(viewer.accepted.name, "success-report.json");
  assert.equal(viewer.accepted.byteLength, 294);
  assert.deepEqual(plain(viewer.accepted.report), {
    total: 3, succeeded: 3, failed: 0, results: [
      { position: 1, file: "./bom-valid.json", ok: true, formatted: "\uFEFFinside\n  Ω  " },
      { position: 2, file: "bom-valid.json", ok: true, formatted: "\uFEFFinside\n  Ω  " },
      { position: 3, file: "bom-valid.json", ok: true, formatted: "\uFEFFinside\n  Ω  " },
    ],
  });
  assert.deepEqual(input, original);
  const expectedCsv = csvHeader +
    '"1","./bom-valid.json","success","\uFEFFinside\n  Ω  ","","",""\r\n' +
    '"2","bom-valid.json","success","\uFEFFinside\n  Ω  ","","",""\r\n' +
    '"3","bom-valid.json","success","\uFEFFinside\n  Ω  ","","",""\r\n';
  assert.equal(viewer.toCsv(), expectedCsv);
  viewer.setFilter("failure");
  assert.equal(viewer.rows.length, 0);
  assert.equal(viewer.toCsv(), expectedCsv);
  assert.equal(viewer.accepted.report.total, 3);
  viewer.setFilter("all");
  assert.deepEqual(plain(viewer.rows.map((row) => row.position)), [1, 2, 3]);
});

test("retained mixed document: exact outcomes and every filter projection", async () => {
  const input = fixture("mixed-report.json");
  assert.equal(input.length, 845);
  assert.equal(createHash("sha256").update(input).digest("hex"),
    "851b8250e3f553850ea5bacf24d9dd4c94311ed45b8ba1bc58a5f03aade52dea");
  const viewer = new SavedBatchReport(() => {});
  await viewer.selectFile(file("mixed-report.json", input));
  const accepted = viewer.accepted;
  assert.deepEqual(plain(accepted.report), {
    total: 6, succeeded: 2, failed: 4, results: [
      { position: 1, file: "bom-valid.json", ok: true, formatted: "\uFEFFinside\n  Ω  " },
      { position: 2, file: "valid-crlf-layout.json", ok: false, error: { stage: "format", name: "RangeError", message: "lines[1] must not contain line breaks" } },
      { position: 3, file: "not-present-address-draft.json", ok: false, error: { stage: "read", name: "Error", message: "ENOENT: no such file or directory, open 'not-present-address-draft.json'" } },
      { position: 4, file: "cr-value.json", ok: false, error: { stage: "decode", name: "RangeError", message: "draft[1] contains CR; textareas cannot preserve CR" } },
      { position: 5, file: "empty.json", ok: false, error: { stage: "format", name: "RangeError", message: "lines must not be empty" } },
      { position: 6, file: "bom-valid.json", ok: true, formatted: "\uFEFFinside\n  Ω  " },
    ],
  });
  const expectedCsv = csvHeader +
    '"1","bom-valid.json","success","\uFEFFinside\n  Ω  ","","",""\r\n' +
    '"2","valid-crlf-layout.json","failure","","format","RangeError","lines[1] must not contain line breaks"\r\n' +
    '"3","not-present-address-draft.json","failure","","read","Error","ENOENT: no such file or directory, open \'not-present-address-draft.json\'"\r\n' +
    '"4","cr-value.json","failure","","decode","RangeError","draft[1] contains CR; textareas cannot preserve CR"\r\n' +
    '"5","empty.json","failure","","format","RangeError","lines must not be empty"\r\n' +
    '"6","bom-valid.json","success","\uFEFFinside\n  Ω  ","","",""\r\n';
  for (const [filter, positions] of [
    ["all", [1, 2, 3, 4, 5, 6]], ["success", [1, 6]],
    ["failure", [2, 3, 4, 5]], ["read", [3]], ["decode", [4]], ["format", [2, 5]],
  ]) {
    viewer.setFilter(filter);
    assert.deepEqual(plain(viewer.rows.map((row) => row.position)), positions, filter);
    for (const row of viewer.rows) assert.equal(row, accepted.report.results[row.position - 1]);
    assert.equal(viewer.accepted, accepted);
    assert.equal(viewer.toCsv(), expectedCsv);
    assert.deepEqual(plain([accepted.report.total, accepted.report.succeeded, accepted.report.failed]), [6, 2, 4]);
  }
});

test("literal and empty fields, CR/CRLF, FEFF, markup and unknown fields are not repaired", async () => {
  const literal = "\uFEFF \tΩ e\u0301\r\n\n<svg onload='not code'> & ../path\r";
  const report = {
    total: 3, succeeded: 2, failed: 1, extra: { list: [null, false, { untouched: 1 }] },
    results: [
      { position: 1, file: literal, ok: true, formatted: literal, error: "unknown on success" },
      { position: 2, file: "", ok: true, formatted: "" },
      { position: 3, file: "", ok: false, formatted: null, error: { stage: "decode", name: "", message: literal, extra: [3] } },
    ],
  };
  const viewer = new SavedBatchReport(() => {});
  await viewer.selectFile(file(literal, bytes(report)));
  assert.equal(viewer.status.kind, "accepted");
  assert.equal(viewer.accepted.name, literal);
  assert.deepEqual(plain(viewer.accepted.report), report);
  assert.equal(viewer.accepted.report.results[0].formatted, literal);
  assert.equal(viewer.accepted.report.results[1].formatted, "");
  assert.equal(viewer.accepted.report.results[2].error.name, "");
  for (const value of [viewer.accepted, viewer.accepted.report, viewer.accepted.report.results,
    viewer.accepted.report.results[0], viewer.accepted.report.results[2].error]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => { viewer.accepted.report.results[0].file = "changed"; }, TypeError);
  await viewer.selectFile(file("empty-errors.json", bytes(failure())));
  assert.deepEqual(plain(viewer.accepted.report), failure());
  await viewer.selectFile(file("blank-output.json", bytes(success(" \t\r\n"))));
  assert.equal(viewer.accepted.report.results[0].formatted, " \t\r\n");
});

test("encoding BOM and JSON whitespace only are consumed, not parsed string content", async () => {
  const viewer = new SavedBatchReport(() => {});
  const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("\r\n\t "), bytes(success("﻿")), Buffer.from("\r\n")]);
  await viewer.selectFile(file("bom.json", input));
  assert.equal(viewer.status.kind, "accepted");
  assert.equal(viewer.accepted.report.results[0].formatted, "﻿");
});

test("no accepted data, valid empty data and a no-match projection stay distinct", async () => {
  const viewer = new SavedBatchReport(() => {});
  assert.equal(viewer.accepted, null);
  assert.equal(viewer.status.kind, "idle");
  assert.equal(viewer.rows.length, 0);
  viewer.setFilter("format");
  await viewer.selectFile(file("zero.json", bytes(zero)));
  assert.equal(viewer.status.kind, "accepted");
  assert.deepEqual(plain(viewer.accepted.report), zero);
  assert.equal(viewer.filter, "format");
  assert.equal(viewer.rows.length, 0);
  await viewer.selectFile(file("one.json", bytes(success())));
  assert.equal(viewer.accepted.report.total, 1);
  assert.equal(viewer.rows.length, 0);
  assert.equal(viewer.filter, "format");
  viewer.setFilter("all");
  assert.equal(viewer.rows.length, 1);
});

test("invalid encoding, envelope, counts, positions and payload shapes are refused atomically", async (t) => {
  const invalid = [
    ["bad UTF-8", Buffer.from([0xc3, 0x28])], ["truncated UTF-8", Buffer.from([0xe2, 0x82])],
    ["empty bytes", Buffer.alloc(0)], ["truncated JSON", Buffer.from('{"total":')],
    ["two documents", Buffer.from('{}{}')], ["not JSON", Buffer.from('undefined')],
    ...[null, [], true, 1, "report", {}].map((value) => ["envelope " + JSON.stringify(value), bytes(value)]),
  ];
  for (const key of ["total", "succeeded", "failed"]) {
    for (const value of [-1, 0.5, 9007199254740992, "1", null, true, {}, []]) {
      invalid.push([key + " = " + JSON.stringify(value), bytes({ ...success(), [key]: value })]);
    }
    const missing = success();
    delete missing[key];
    invalid.push(["missing " + key, bytes(missing)]);
  }
  invalid.push(["nonfinite total", Buffer.from('{"total":1e400,"succeeded":0,"failed":0,"results":[]}')]);
  const cases = [
    ["missing results", (r) => { delete r.results; }],
    ["object results", (r) => { r.results = {}; }], ["null results", (r) => { r.results = null; }],
    ["length mismatch", (r) => { r.total = 2; }], ["count sum mismatch", (r) => { r.failed = 1; }],
    ["right sum wrong outcomes", (r) => { r.succeeded = 0; r.failed = 1; }],
    ["huge safe count mismatch", (r) => { r.succeeded = Number.MAX_SAFE_INTEGER; }],
    ["null result", (r) => { r.results[0] = null; }], ["array result", (r) => { r.results[0] = []; }],
    ["string result", (r) => { r.results[0] = "row"; }],
  ];
  for (const [field, values] of [
    ["position", [undefined, 0, "1", 1.1, -1, Number.MAX_SAFE_INTEGER]],
    ["file", [undefined, 4, null, []]], ["ok", [undefined, 1, "false", null]],
    ["formatted", [undefined, null, [], false]],
  ]) {
    for (const value of values) cases.push([field + " = " + String(value), (r) => { r.results[0][field] = value; }]);
  }
  for (const [label, mutate] of cases) {
    const report = success(); mutate(report); invalid.push([label, bytes(report)]);
  }
  for (const value of [undefined, null, [], "error"]) {
    const report = failure(); report.results[0].error = value;
    invalid.push(["error = " + String(value), bytes(report)]);
  }
  for (const [field, values] of [
    ["stage", [undefined, "READ", "", 0]], ["name", [undefined, null, 0]], ["message", [undefined, null, 0]],
  ]) {
    for (const value of values) {
      const report = failure(); report.results[0].error[field] = value;
      invalid.push(["error." + field + " = " + String(value), bytes(report)]);
    }
  }
  for (const positions of [[1, 1], [2, 1], [1, 3]]) {
    invalid.push(["ordered positions " + positions.join(","), bytes({ total: 2, succeeded: 2, failed: 0,
      results: positions.map((position) => ({ position, file: "same", ok: true, formatted: "" })),
    })]);
  }
  const viewer = new SavedBatchReport(() => {});
  await viewer.selectFile(file("keep.json", bytes(success("keep"))));
  const accepted = viewer.accepted;
  viewer.setFilter("read");
  for (const [label, input] of invalid) {
    await t.test(label, async () => {
      await viewer.selectFile(file(label, input));
      assert.equal(viewer.status.kind, "invalid");
      assert.equal(viewer.status.name, label);
      assert.equal(viewer.accepted, accepted);
      assert.equal(viewer.accepted.report.results[0].formatted, "keep");
      assert.equal(viewer.filter, "read");
    });
  }
});

test("first invalid/read-error/cancelled selection never creates accepted data", async () => {
  const viewer = new SavedBatchReport(() => {});
  await viewer.selectFile(file("invalid.json", Buffer.from("oops")));
  assert.equal(viewer.status.kind, "invalid");
  assert.equal(viewer.accepted, null);
  await viewer.selectFile({ name: "unreadable.json", arrayBuffer() { throw new Error("read denied"); } });
  assert.equal(viewer.status.kind, "read-error");
  assert.equal(viewer.accepted, null);
  await viewer.selectFile(null);
  assert.equal(viewer.status.kind, "empty");
  assert.equal(viewer.status.name, null);
  assert.equal(viewer.accepted, null);
});

test("controlled reads: accepted identity stays pending/failed, valid replacement is atomic", async () => {
  const viewer = new SavedBatchReport(() => {});
  await viewer.selectFile(file("first.json", bytes(success("first"))));
  const first = viewer.accepted;
  assert.equal(viewer.status.kind, "accepted");
  assert.equal(first.name, "first.json");
  assert.equal(viewer.filter, "all");
  assert.equal(viewer.rows[0].formatted, "first");
  const pending = deferred();
  const work = viewer.selectFile(pending.file);
  assert.equal(viewer.status.kind, "reading");
  assert.equal(viewer.status.name, "delayed.json");
  assert.equal(viewer.accepted, first);
  viewer.setFilter("failure");
  assert.equal(viewer.accepted, first);
  assert.equal(viewer.status.kind, "reading");
  assert.equal(viewer.filter, "failure");
  assert.equal(viewer.rows.length, 0);
  pending.reject(new Error("read failed"));
  await work;
  assert.equal(viewer.status.kind, "read-error");
  assert.equal(viewer.status.name, "delayed.json");
  assert.equal(viewer.accepted, first);
  assert.equal(viewer.filter, "failure");
  assert.equal(viewer.rows.length, 0);
  const replacement = viewer.selectFile(file("replacement.json", bytes(failure())));
  assert.equal(viewer.status.kind, "reading");
  assert.equal(viewer.status.name, "replacement.json");
  assert.equal(viewer.accepted, first);
  assert.equal(viewer.rows.length, 0);
  await replacement;
  assert.equal(viewer.status.kind, "accepted");
  assert.equal(viewer.status.name, "replacement.json");
  assert.notEqual(viewer.accepted, first);
  assert.equal(viewer.accepted.name, "replacement.json");
  assert.deepEqual(plain(viewer.accepted.report), failure());
  assert.equal(viewer.filter, "failure");
  assert.equal(viewer.rows.length, 1);
});

test("controlled stale success, invalid bytes and read error cannot overwrite newer work/status", async (t) => {
  for (const settlement of ["success", "invalid", "error"]) {
    for (const newer of ["pending", "accepted", "invalid", "read-error", "empty"]) {
      await t.test(settlement + " after " + newer, async () => {
        const viewer = new SavedBatchReport(() => {});
        await viewer.selectFile(file("keep.json", bytes(success("keep"))));
        viewer.setFilter("decode");
        const old = deferred();
        const oldWork = viewer.selectFile(old.file);
        let next;
        let nextWork;
        if (newer === "pending") {
          next = deferred(); next.file.name = "newest-pending.json";
          nextWork = viewer.selectFile(next.file);
        } else if (newer === "accepted") {
          await viewer.selectFile(file("newest.json", bytes(zero)));
        } else if (newer === "invalid") {
          await viewer.selectFile(file("newest-invalid.json", Buffer.from("oops")));
        } else if (newer === "read-error") {
          await viewer.selectFile({ name: "newest-unreadable.json", arrayBuffer: async () => { throw new Error("denied"); } });
        } else {
          await viewer.selectFile(undefined);
        }
        const accepted = viewer.accepted;
        const status = viewer.status;
        const csv = viewer.toCsv();
        if (settlement === "error") old.reject(new Error("obsolete failure"));
        else old.resolve(settlement === "invalid" ? Buffer.from("invalid") : bytes(success("obsolete")));
        await oldWork;
        assert.equal(viewer.accepted, accepted);
        assert.equal(viewer.status, status);
        assert.equal(viewer.toCsv(), csv);
        assert.equal(viewer.filter, "decode");
        if (next) {
          next.resolve(bytes(zero)); await nextWork;
          assert.equal(viewer.accepted.name, "newest-pending.json");
          assert.equal(viewer.status.kind, "accepted");
        }
      });
    }
  }
});

test("each current selection reads once; filtering consumes the accepted snapshot", async () => {
  const viewer = new SavedBatchReport(() => {});
  let reads = 0;
  const selected = { name: "same.json", arrayBuffer: async () => { reads += 1; return bytes(success(String(reads))); } };
  await viewer.selectFile(selected);
  const first = viewer.accepted;
  for (const filter of ["read", "all", "success", "failure", "decode", "format"]) {
    viewer.setFilter(filter); void viewer.rows;
    assert.equal(viewer.toCsv(), csvHeader + '"1","","success","1","","",""\r\n');
    assert.equal(viewer.accepted, first);
    assert.equal(reads, 1);
  }
  await viewer.selectFile(null);
  assert.equal(viewer.accepted, first);
  await viewer.selectFile(selected);
  assert.equal(reads, 2);
  assert.equal(viewer.accepted.report.results[0].formatted, "2");
  assert.equal(viewer.filter, "format");
});

test("CSV requires accepted data; a zero report exports only headers without changing state", async () => {
  let changes = 0;
  const viewer = new SavedBatchReport(() => { changes += 1; });
  assert.throws(() => viewer.toCsv(), /No accepted report/);
  await viewer.selectFile(file("zero.json", bytes(zero)));
  const accepted = viewer.accepted;
  const status = viewer.status;
  const before = changes;
  assert.equal(viewer.toCsv(), csvHeader);
  assert.equal(viewer.accepted, accepted);
  assert.equal(viewer.status, status);
  assert.equal(changes, before);
});

test("CSV bytes preserve quotes, commas, mixed line breaks, Unicode, empty strings and outcome fields", async () => {
  const report = {
    total: 3, succeeded: 2, failed: 1, extra: "not exported",
    results: [
      { position: 1, file: ' ./a,"quoted".json\r\n ', ok: true,
        formatted: '\uFEFF  Ω e\u0301 😀\nline two\rline three\r\n"end",\t ', error: "ignored" },
      { position: 2, file: "", ok: true, formatted: "", extra: "\ud800" },
      { position: 3, file: "=1+1", ok: false, formatted: "ignored",
        error: { stage: "decode", name: "+Name", message: "-Message\n@next", extra: "ignored" } },
    ],
  };
  const expected = csvHeader +
    '"1"," ./a,""quoted"".json\r\n ","success","\uFEFF  Ω e\u0301 😀\nline two\rline three\r\n""end"",\t ","","",""\r\n' +
    '"2","","success","","","",""\r\n' +
    '"3","=1+1","failure","","decode","+Name","-Message\n@next"\r\n';
  const viewer = new SavedBatchReport(() => {});
  const input = bytes(report);
  const original = Buffer.from(input);
  await viewer.selectFile(file("literal.json", input));
  const accepted = viewer.accepted;
  const status = viewer.status;
  const csv = viewer.toCsv();
  assert.equal(csv, expected);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8", endings: "transparent" });
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.from(expected, "utf8"));
  assert.equal(blob.type, "text/csv;charset=utf-8");
  assert.equal(csv.charCodeAt(0), 0x22); // Quoted header, not an encoding BOM.
  assert.equal(viewer.accepted, accepted);
  assert.equal(viewer.status, status);
  assert.deepEqual(plain(accepted.report), report);
  assert.deepEqual(input, original);
});

test("CSV never adds spreadsheet formula guards or changes literal field text", async () => {
  const viewer = new SavedBatchReport(() => {});
  for (const value of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", " =1", "000123", "2026-10-30", "\u0000", "\u000b\u000c\u0085\u2028\u2029"]) {
    const report = failure();
    Object.assign(report.results[0], { file: value });
    Object.assign(report.results[0].error, { name: value, message: value });
    await viewer.selectFile(file("formula.json", bytes(report)));
    assert.equal(viewer.toCsv(), csvHeader + '"1","' + value + '","failure","","read","' + value + '","' + value + '"\r\n');
    const valid = success(value);
    valid.results[0].file = value;
    await viewer.selectFile(file("formula.json", bytes(valid)));
    assert.equal(viewer.toCsv(), csvHeader + '"1","' + value + '","success","' + value + '","","",""\r\n');
  }
});

test("unpaired surrogates refuse the whole CSV, not report acceptance, in every exported string field", async () => {
  for (const value of ["\ud800", "\udfff", "x\ud800y", "\udfff\ud800"]) {
    for (const field of ["file", "formatted", "name", "message"]) {
      const report = ["name", "message"].includes(field) ? failure() : success();
      const target = ["name", "message"].includes(field) ? report.results[0].error : report.results[0];
      target[field] = value;
      const viewer = new SavedBatchReport(() => {});
      await viewer.selectFile(file("surrogate.json", bytes(report)));
      assert.equal(viewer.status.kind, "accepted");
      const accepted = viewer.accepted;
      const status = viewer.status;
      assert.throws(() => viewer.toCsv(), /unpaired UTF-16 surrogate; UTF-8 cannot preserve it losslessly/);
      assert.equal(viewer.accepted, accepted);
      assert.equal(viewer.status, status);
      assert.deepEqual(plain(viewer.accepted.report), report);
    }
  }
});

test("CSV retains accepted snapshot through pending, failed and cancelled selections; valid reads replace it", async () => {
  const viewer = new SavedBatchReport(() => {});
  await viewer.selectFile(file("keep.json", bytes(success("keep"))));
  const accepted = viewer.accepted;
  const expected = csvHeader + '"1","","success","keep","","",""\r\n';
  const pending = deferred();
  const work = viewer.selectFile(pending.file);
  assert.equal(viewer.toCsv(), expected);
  pending.reject(new Error("read failed"));
  await work;
  assert.equal(viewer.toCsv(), expected);
  await viewer.selectFile(file("invalid.json", Buffer.from("invalid")));
  assert.equal(viewer.toCsv(), expected);
  await viewer.selectFile(null);
  assert.equal(viewer.toCsv(), expected);
  assert.equal(viewer.accepted, accepted);
  await viewer.selectFile(file("replacement.json", bytes(zero)));
  assert.equal(viewer.toCsv(), csvHeader);
});
