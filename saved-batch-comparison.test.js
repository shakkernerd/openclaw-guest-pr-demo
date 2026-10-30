"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ TextDecoder });
for (const path of ["saved-batch-report.js", "saved-batch-comparison.js"]) {
  vm.runInContext(readFileSync(join(__dirname, path), "utf8"), context);
}
const Comparison = vm.runInContext("SavedBatchComparison", context);
const codec = vm.runInContext("savedBatchReportCodec", context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const success = (file, formatted = "") => ({ file, ok: true, formatted });
const failure = (file, stage = "format", name = "Error", message = "bad") => ({ file, ok: false, error: { stage, name, message } });
const document = (rows) => ({ total: rows.length, succeeded: rows.filter((row) => row.ok).length,
  failed: rows.filter((row) => !row.ok).length, results: rows.map((row, i) => ({ ...row, position: i + 1 })) });
const bytes = (report) => Buffer.from(JSON.stringify(report));
const report = (rows) => codec.decode(bytes(document(rows)));
const file = (rows, name = "report.json") => new File([bytes(document(rows))], name);
const mapping = (originalPosition, rerunPosition) => ({ originalPosition, rerunPosition });
const compare = (a, b, mappings) => Comparison.compare(report(a), report(b), mappings);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { file: { name: "pending.json", arrayBuffer: () => promise }, resolve, reject };
}
async function loaded() {
  const model = new Comparison();
  await model.side("original").selectFile(file([failure("old")]));
  await model.side("rerun").selectFile(file([success("new")]));
  model.addMapping(1, 1);
  return model;
}

test("supplied reports: no filename inference; explicit failures-only mapping retains every original occurrence", async () => {
  const original = readFileSync(join(__dirname, "saved-batch-report-fixtures/comparison-original.json"));
  const rerun = readFileSync(join(__dirname, "saved-batch-report-fixtures/comparison-rerun.json"));
  assert.equal(createHash("sha256").update(original).digest("hex"), "2f5788a7894330892e9fdba1c3cf0048bc74954e7734e8644378453e7555e498");
  assert.equal(createHash("sha256").update(rerun).digest("hex"), "da6ed57e9bc272253356c944b94e5d8a914b15b241ebd81627ae9613112e973d");
  const model = new Comparison();
  await model.side("original").selectFile(new File([original], "original.json"));
  await model.side("rerun").selectFile(new File([rerun], "rerun.json"));
  assert.equal(model.result.counts.paired, 0);
  assert.equal(model.result.counts.originalOnly, 5);
  assert.equal(model.result.counts.rerunOnly, 2);
  assert.equal(model.result.rows.length, 7);
  const before = model.side("original").accepted;
  const after = model.side("rerun").accepted;
  model.addMapping(2, 1);
  model.addMapping(4, 2);
  assert.deepEqual(plain(model.result.counts), { paired: 2, originalOnly: 3, rerunOnly: 0, ambiguousOccurrences: 2,
    "failure-to-success": 2, "success-to-failure": 0, "success-same": 0, "success-changed": 0, "failure-same": 0, "failure-changed": 0 });
  assert.deepEqual(plain(model.result.rows.map((row) => [row.original.position, row.rerun?.position || null, row.kind])), [
    [1, null, "original-only"], [2, 1, "failure-to-success"], [3, null, "original-only"],
    [4, 2, "failure-to-success"], [5, null, "original-only"],
  ]);
  for (const row of model.result.rows.filter((row) => row.basis)) {
    assert.equal(row.basis, "explicit"); assert.equal(row.pathChanged, true); assert.equal(row.positionChanged, true);
  }
  assert.equal(model.side("original").accepted, before);
  assert.equal(model.side("rerun").accepted, after);
  assert.equal(model.result.rows[0].original.formatted, "  Example Recipient α  \n10 Example Street\nDemo City");
  assert.notEqual(model.result.rows[0].original, model.result.rows[4].original);
  assert.deepEqual(plain(before.report), JSON.parse(original));
  assert.deepEqual(plain(after.report), JSON.parse(rerun));
});

test("unique exact paths use full-report counts, not position, spelling guesses or content", () => {
  const result = compare([success("a", "same"), success("b"), success("./c"), success("NAME"), success("x-old-id"), success("draft")],
    [success("b"), success("a", "same"), success("c"), success("name"), success("x-new-id"), success("draft.corrected")]);
  assert.equal(result.counts.paired, 2);
  assert.deepEqual(plain(result.rows.slice(0, 2).map((row) => [row.rerun.position, row.basis, row.positionChanged, row.pathChanged])),
    [[2, "unique-exact-path", true, false], [1, "unique-exact-path", true, false]]);
  assert.equal(compare([success("dir/a")], [success("other/a")]).counts.paired, 0);
  assert.equal(compare([success("é")], [success("e\u0301")]).counts.paired, 0);
  assert.equal(compare([success("")], [success("")]).counts.paired, 1);
});

test("duplicates never collapse or become unique after explicit mapping; asymmetric groups remain ambiguous", () => {
  for (const [left, right] of [[2, 2], [2, 1], [1, 2], [3, 2]]) {
    const a = Array.from({ length: left }, () => success("same"));
    const b = Array.from({ length: right }, () => success("same"));
    const unpaired = compare(a, b);
    assert.equal(unpaired.counts.paired, 0);
    assert.equal(unpaired.rows.length, left + right);
    assert.ok(unpaired.rows.every((row) => row.ambiguous));
    const paired = compare(a, b, [mapping(1, 1)]);
    assert.equal(paired.counts.paired, 1);
    assert.equal(paired.rows.length, left + right - 1);
    assert.ok(paired.rows.slice(1).every((row) => row.ambiguous));
  }
  const result = compare([success("x"), failure("x")], [failure("x"), success("x")], [mapping(1, 2), mapping(2, 1)]);
  assert.deepEqual(plain(result.rows.map((row) => row.kind)), ["success-same", "failure-same"]);
});

test("all outcome categories, exact strings and full error tuple; unknown fields ignored", () => {
  const a = [failure("fixed"), success("regressed"), success("same", ""), success("changed", "a\r\nb"),
    failure("still"), failure("stage"), failure("name"), failure("message")];
  const b = [success("fixed"), failure("regressed"), { ...success("same", ""), extra: "ignored", error: "ignored" },
    success("changed", "a\nb"), failure("still"), failure("stage", "read"), failure("name", "format", "Other"),
    failure("message", "format", "Error", "bad ")];
  assert.deepEqual(plain(compare(a, b).rows.map((row) => row.kind)), ["failure-to-success", "success-to-failure", "success-same",
    "success-changed", "failure-same", "failure-changed", "failure-changed", "failure-changed"]);
  for (const [x, y] of [["x", " x"], ["x\n", "x"], ["é", "e\u0301"], ["", "\uFEFF"], ["\ud800", "\ufffd"]]) {
    assert.equal(compare([success("a", x)], [success("a", y)]).rows[0].kind, "success-changed");
  }
  assert.equal(compare([{ ...failure("a"), formatted: "ignored", extra: 1 }],
    [{ ...failure("a"), formatted: "different", extra: 2 }]).rows[0].kind, "failure-same");
});

test("explicit pairing takes priority, without reusing auto counterparts; path changes are independent", () => {
  const result = compare([success("a", "same"), success("b", "same")], [success("a", "same"), success("b", "same")], [mapping(1, 2)]);
  assert.equal(result.counts.paired, 1);
  assert.equal(result.rows[0].kind, "success-same");
  assert.equal(result.rows[0].pathChanged, true);
  assert.equal(result.rows[0].positionChanged, true);
  assert.equal(result.rows[1].kind, "original-only");
  assert.equal(result.rows[2].kind, "rerun-only");
});

test("reject invalid and many-to-one mappings atomically; removal is explicit", async () => {
  const model = await loaded();
  const mappings = model.mappings;
  const result = model.result;
  for (const pair of [[1, 1], [0, 1], [1, 2], [1.5, 1], ["1", 1], [1, NaN]]) {
    assert.throws(() => model.addMapping(...pair));
    assert.equal(model.mappings, mappings); assert.equal(model.result, result);
  }
  for (const maps of [[mapping(1, 1), mapping(2, 1)], [mapping(1, 1), mapping(1, 2)]]) {
    assert.throws(() => compare([success("a"), success("b")], [success("c"), success("d")], maps), /only one/);
  }
  model.removeMapping(1);
  assert.equal(model.mappings.length, 0);
  assert.equal(model.result.counts.paired, 0);
  assert.throws(() => new Comparison().addMapping(1, 1), /Accept both/);
});

test("unaccepted, empty reports, and one-sided results stay distinct; summaries reconcile occurrences", async () => {
  const model = new Comparison();
  assert.equal(model.result, null);
  await model.side("original").selectFile(file([]));
  assert.equal(model.result, null);
  await model.side("rerun").selectFile(file([]));
  assert.equal(model.result.rows.length, 0);
  for (const [a, b] of [[[], [success("x")]], [[failure("y")], []], [[success("x"), success("x")], [success("x"), failure("z")]]]) {
    const result = compare(a, b);
    assert.equal(result.counts.paired + result.counts.originalOnly, a.length);
    assert.equal(result.counts.paired + result.counts.rerunOnly, b.length);
    assert.equal(result.rows.length, a.length + b.length - result.counts.paired);
  }
});

test("both sides retain accepted reports and mappings through pending, failed, invalid and cancelled reads", async () => {
  for (const side of ["original", "rerun"]) {
    const model = await loaded();
    const accepted = model.side(side).accepted;
    const mappings = model.mappings;
    const result = model.result;
    const revision = model.revision;
    const pending = deferred();
    const work = model.side(side).selectFile(pending.file);
    assert.equal(model.result, result); assert.equal(model.mappings, mappings);
    pending.reject(new Error("read failure")); await work;
    await model.side(side).selectFile(new File(["not JSON"], "invalid.json"));
    await model.side(side).selectFile(null);
    assert.equal(model.side(side).accepted, accepted);
    assert.equal(model.result, result); assert.equal(model.mappings, mappings); assert.equal(model.revision, revision);
    // Even same-name, same-data acceptance is a replacement, not a status change.
    await model.side(side).selectFile(file(side === "original" ? [failure("old")] : [success("new")]));
    assert.notEqual(model.side(side).accepted, accepted);
    assert.equal(model.mappings.length, 0); assert.equal(model.result.counts.paired, 0);
    assert.equal(model.revision, revision + 1);
  }
});

test("stale success/error/invalid reads cannot clear mappings after cancellation or replacement on either side", async () => {
  for (const side of ["original", "rerun"]) for (const settlement of ["success", "invalid", "error"]) for (const newer of ["cancel", "invalid", "accepted"]) {
    const model = await loaded();
    const pending = deferred();
    const work = model.side(side).selectFile(pending.file);
    if (newer === "cancel") await model.side(side).selectFile(null);
    else if (newer === "invalid") await model.side(side).selectFile(new File(["invalid"], "invalid"));
    else {
      await model.side(side).selectFile(file(side === "original" ? [failure("old")] : [success("new")]));
      model.addMapping(1, 1);
    }
    const result = model.result, mappings = model.mappings, status = model.side(side).status;
    if (settlement === "error") pending.reject(new Error("obsolete"));
    else pending.resolve(settlement === "invalid" ? Buffer.from("invalid") : bytes(document([])));
    await work;
    assert.equal(model.result, result); assert.equal(model.mappings, mappings); assert.equal(model.side(side).status, status);
  }
});

test("simultaneous independent side reads clear mappings only at each acceptance", async () => {
  const model = await loaded();
  const a = deferred(), b = deferred();
  const aw = model.side("original").selectFile(a.file), bw = model.side("rerun").selectFile(b.file);
  assert.equal(model.mappings.length, 1);
  a.resolve(bytes(document([failure("old")]))); await aw;
  assert.equal(model.mappings.length, 0);
  model.addMapping(1, 1); // Maps the current accepted pair, including the old rerun.
  b.resolve(bytes(document([success("new")]))); await bw;
  assert.equal(model.mappings.length, 0);
});

test("comparison and mappings consume accepted snapshots, not filtered rows or file rereads", async () => {
  let reads = 0;
  const model = new Comparison();
  const input = { name: "same", arrayBuffer: async () => { reads += 1; return bytes(document([success("x"), failure("x")])); } };
  await model.side("original").selectFile(input); await model.side("rerun").selectFile(input);
  model.side("original").setFilter("success"); model.side("rerun").setFilter("failure");
  assert.equal(model.result.counts.paired, 0);
  model.addMapping(1, 1);
  assert.equal(model.result.counts.paired, 1);
  assert.equal(model.result.rows[1].ambiguous, true);
  assert.equal(reads, 2);
  assert.ok(Object.isFrozen(model.result)); assert.ok(Object.isFrozen(model.mappings));
});
