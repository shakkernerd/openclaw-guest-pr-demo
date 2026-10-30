"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const R = require("./review-state.js");
const fixtureDirectory = path.join(__dirname, "test-fixtures/review-reconcile");
const files = ["baseline.json", "current.json", "returned.json"].map(name => path.join(fixtureDirectory, name));
const inputs = () => files.map(file => JSON.parse(fs.readFileSync(file, "utf8")));
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const snapshot = records => ({ format: "record-review", version: 1, records,
  reviews: Object.fromEntries(records.map(({ id }) => [id, { decision: "unreviewed", notes: "" }])) });
const row = id => ({ id, title: "Synthetic " + id });
const run = (args, options = {}, command = "review-reconcile.js") => {
  const result = spawnSync(process.execPath, [path.join(__dirname, command), ...args], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
};
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}
function failure(result, diagnostic) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, diagnostic);
  assert.match(result.stderr, /Usage:/);
}
function side(state, index) {
  const record = state.records[index];
  return { record, review: state.reviews[record.id] };
}
function expectedFixturePlan() {
  const [b, c, r] = inputs();
  return { kind: "record-review-reconciliation",
    counts: { total: 5, proposed: 1, preserved: 1, unchanged: 1, converged: 1, conflict: 1, unknown: 0, missing: 0 },
    entries: [
      { id: "split", kind: "conflict", issues: ["review-diverged"], baseline: side(b, 4), current: side(c, 4), returned: side(r, 0), proposed: null },
      { id: "9007199254740993", kind: "converged", issues: [], baseline: side(b, 3), current: side(c, 3), returned: side(r, 1), proposed: null },
      { id: "__proto__", kind: "proposed", issues: [], baseline: side(b, 1), current: side(c, 2), returned: side(r, 2), proposed: { decision: "unreviewed", notes: "" } },
      { id: "0", kind: "unchanged", issues: [], baseline: side(b, 0), current: side(c, 1), returned: side(r, 3), proposed: null },
      { id: "constructor", kind: "preserved", issues: [], baseline: side(b, 2), current: side(c, 0), returned: side(r, 4), proposed: null },
    ] };
}

test("owner covers all three-way review outcomes, exact values and returned order without mutation", () => {
  const states = inputs();
  const before = structuredClone(states);
  states.forEach(freeze);
  const plan = R.planReviewReconciliation(...states);
  assert.deepEqual(plan, expectedFixturePlan());
  assert.deepEqual(states, before);
  const zero = plan.entries[3].baseline.record;
  assert.deepEqual(zero, { id: "0", title: "Zero", zero: 0, negativeZero: -0,
    empty: "", nil: null, flag: false, list: [0, "0", "", null, false] });
  assert.equal(plan.entries[2].returned.record.__proto__.constructor, "literal");
  assert.equal(plan.entries[1].current.review.notes, "  \r\n雪 e\u0301 <b>literal</b>\t");
});

test("owner treats complete review pairs atomically, including exact note differences", () => {
  const base = snapshot([row("a")]);
  for (const [currentReview, returnedReview, kind] of [
    [{ decision: "unreviewed", notes: "" }, { decision: "unreviewed", notes: "note" }, "proposed"],
    [{ decision: "approved", notes: "" }, { decision: "unreviewed", notes: "" }, "preserved"],
    [{ decision: "approved", notes: "same" }, { decision: "approved", notes: "same" }, "converged"],
    [{ decision: "approved", notes: "" }, { decision: "rejected", notes: "" }, "conflict"],
    [{ decision: "approved", notes: "" }, { decision: "unreviewed", notes: "note" }, "conflict"],
    [{ decision: "unreviewed", notes: "x\n" }, { decision: "unreviewed", notes: "x\r\n" }, "conflict"],
    [{ decision: "unreviewed", notes: "é" }, { decision: "unreviewed", notes: "e\u0301" }, "conflict"],
    [{ decision: "unreviewed", notes: " " }, { decision: "unreviewed", notes: "" }, "preserved"],
  ]) {
    const current = { ...base, reviews: { a: currentReview } };
    const returned = { ...base, reviews: { a: returnedReview } };
    const entry = R.planReviewReconciliation(base, current, returned).entries[0];
    assert.equal(entry.kind, kind);
    assert.deepEqual(entry.current.review, currentReview);
    assert.deepEqual(entry.returned.review, returnedReview);
    assert.deepEqual(entry.proposed, kind === "proposed" ? returnedReview : null);
  }
});

test("source changes on current, returned or both always conflict, even with identical reviews", () => {
  const pairs = [
    [{ value: 0 }, { value: "0" }], [{ value: 0 }, { value: -0 }],
    [{ value: "" }, { value: null }], [{ value: false }, { value: 0 }],
    [{}, { value: "" }], [{}, { value: null }],
    [{ value: [0, "0"] }, { value: ["0", 0] }],
    [{ value: { nested: 0 } }, { value: { nested: "0" } }],
    [JSON.parse('{"__proto__":"first"}'), JSON.parse('{"__proto__":"second"}')],
    [{ title: "First" }, { title: "Second" }],
  ];
  for (const [original, changed] of pairs) {
    const baseline = snapshot([{ ...row("a"), ...original }]);
    const modified = snapshot([{ ...row("a"), ...changed }]);
    for (const [current, returned, issues] of [
      [modified, baseline, ["current-source-changed"]],
      [baseline, modified, ["returned-source-changed"]],
      [modified, modified, ["current-source-changed", "returned-source-changed"]],
    ]) {
      const entry = R.planReviewReconciliation(freeze(baseline), freeze(current), freeze(returned)).entries[0];
      assert.equal(entry.kind, "conflict");
      assert.deepEqual(entry.issues, issues);
      assert.deepEqual(entry.baseline.record, baseline.records[0]);
      assert.deepEqual(entry.current.record, current.records[0]);
      assert.deepEqual(entry.returned.record, returned.records[0]);
      assert.equal(entry.proposed, null);
    }
  }
  const baseline = snapshot([{ ...row("a"), nested: { x: 0, y: [false, ""] } }]);
  const returned = snapshot([{ nested: { y: [false, ""], x: 0 }, title: "Synthetic a", id: "a" }]);
  returned.reviews.a.notes = "proposal";
  assert.equal(R.planReviewReconciliation(baseline, baseline, returned).entries[0].kind, "proposed");
});

test("all missing/unknown identity combinations remain visible, with deterministic absent-return order", () => {
  const b = snapshot([row("base-only"), row("missing-current"), row("missing-return"), row("changed-absent")]);
  const c = snapshot([row("current-only"), row("missing-return"), row("new-on-both"), { ...row("changed-absent"), value: 0 }]);
  const r = snapshot([row("return-only"), row("missing-current"), row("new-on-both")]);
  const plan = R.planReviewReconciliation(b, c, r);
  assert.deepEqual(plan.counts, { total: 7, proposed: 0, preserved: 0, unchanged: 0, converged: 0, conflict: 1, unknown: 3, missing: 3 });
  assert.deepEqual(plan.entries, [
    { id: "return-only", kind: "unknown", issues: ["unknown-baseline", "missing-current"], baseline: null, current: null, returned: side(r, 0), proposed: null },
    { id: "missing-current", kind: "missing", issues: ["missing-current"], baseline: side(b, 1), current: null, returned: side(r, 1), proposed: null },
    { id: "new-on-both", kind: "unknown", issues: ["unknown-baseline"], baseline: null, current: side(c, 2), returned: side(r, 2), proposed: null },
    { id: "current-only", kind: "unknown", issues: ["unknown-baseline", "missing-returned"], baseline: null, current: side(c, 0), returned: null, proposed: null },
    { id: "missing-return", kind: "missing", issues: ["missing-returned"], baseline: side(b, 2), current: side(c, 1), returned: null, proposed: null },
    { id: "changed-absent", kind: "conflict", issues: ["missing-returned", "current-source-changed"], baseline: side(b, 3), current: side(c, 3), returned: null, proposed: null },
    { id: "base-only", kind: "missing", issues: ["missing-current", "missing-returned"], baseline: side(b, 0), current: null, returned: null, proposed: null },
  ]);
  const changedReturn = snapshot([{ ...row("missing-current"), value: "" }]);
  const entry = R.planReviewReconciliation(b, snapshot([]), changedReturn).entries[0];
  assert.equal(entry.kind, "conflict");
  assert.deepEqual(entry.issues, ["missing-current", "returned-source-changed"]);
  const exact = R.planReviewReconciliation(snapshot([row(" A ")]), snapshot([row("A")]), snapshot([row("a")]));
  assert.deepEqual(exact.entries.map(entry => entry.id), ["a", "A", " A "]);
  assert.equal(exact.counts.proposed, 0);
  assert.deepEqual(R.planReviewReconciliation(snapshot([]), snapshot([]), snapshot([])), {
    kind: "record-review-reconciliation",
    counts: { total: 0, proposed: 0, preserved: 0, unchanged: 0, converged: 0, conflict: 0, unknown: 0, missing: 0 }, entries: [],
  });
});

test("owner validates every complete side and normalizes reviews through the existing boundary", () => {
  const good = snapshot([row("a")]);
  const badUnknown = snapshot([row("not-in-baseline")]);
  badUnknown.reviews["not-in-baseline"].notes = 0;
  const badConflict = snapshot([{ ...row("a"), changed: true }]);
  badConflict.reviews.a.decision = "maybe";
  for (const invalid of [null, [], { ...good, version: 2 }, { ...good, reviews: {} },
    snapshot([{ title: "Missing ID" }]), snapshot([row(0)]), snapshot([row("")]),
    { ...good, records: [row("a"), row("a")] }, { ...good, reviews: { unknown: good.reviews.a } }, badUnknown, badConflict]) {
    for (let index = 0; index < 3; index++) {
      const states = [good, good, good]; states[index] = invalid;
      assert.throws(() => R.planReviewReconciliation(...states));
    }
  }
  const extra = structuredClone(good);
  extra.reviews.a.extra = "not review metadata";
  extra.ignoredEnvelope = true;
  const entry = R.planReviewReconciliation(extra, good, extra).entries[0];
  assert.equal(entry.kind, "unchanged");
  for (const side of [entry.baseline, entry.current, entry.returned]) {
    assert.deepEqual(side.review, { decision: "unreviewed", notes: "" });
  }
});

test("real CLI emits the full owner contract from files and each stdin position without rewriting bytes", () => {
  const bytes = files.map(file => fs.readFileSync(file));
  const names = fs.readdirSync(fixtureDirectory);
  const results = [run(files, { input: "ignored non-JSON stdin" })];
  for (let index = 0; index < 3; index++) {
    const args = [...files]; args[index] = "-";
    results.push(run(args, { input: "\uFEFF" + bytes[index].toString().replaceAll("\n", "\r\n") }));
  }
  for (const result of results) {
    success(result);
    assert.deepEqual(JSON.parse(result.stdout), expectedFixturePlan());
    assert.ok(result.stdout.endsWith("\n"));
    assert.equal(result.stdout, results[0].stdout);
  }
  assert.deepEqual(files.map(file => fs.readFileSync(file)), bytes);
  assert.deepEqual(fs.readdirSync(fixtureDirectory), names);
});

test("real CLI refuses non-finite plan numbers without output while preserving finite values and negative zero", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-reconcile-numbers-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const finiteText = '{"format":"record-review","version":1,"records":[{"id":"numeric","title":"Numeric","value":1e308,"nested":[-0,"1e400","-0",{"finite":-1e308}]}],"reviews":{"numeric":{"decision":"unreviewed","notes":"Infinity"}}}';
  // Raw numeric JSON is essential: stringifying Infinity would already lose it.
  const overflowText = finiteText.replace('"finite":-1e308', '"finite":1e400');
  const finiteFile = path.join(directory, "finite.json");
  const overflowFile = path.join(directory, "overflow.json");
  fs.writeFileSync(finiteFile, finiteText, { flag: "wx" });
  fs.writeFileSync(overflowFile, overflowText, { flag: "wx" });
  const accepted = run([finiteFile, finiteFile, finiteFile]);
  success(accepted);
  const entry = JSON.parse(accepted.stdout).entries[0];
  assert.equal(entry.kind, "unchanged");
  for (const side of [entry.baseline, entry.current, entry.returned]) {
    assert.deepEqual(side.record, { id: "numeric", title: "Numeric", value: 1e308,
      nested: [-0, "1e400", "-0", { finite: -1e308 }] });
    assert.deepEqual(side.review, { decision: "unreviewed", notes: "Infinity" });
  }
  failure(run([overflowFile, overflowFile, overflowFile]), /Cannot serialize plan: non-finite number/);
  assert.deepEqual(fs.readFileSync(finiteFile), Buffer.from(finiteText));
  assert.deepEqual(fs.readFileSync(overflowFile), Buffer.from(overflowText));
});

test("real CLI exposes changed source and missing IDs, with no replacement snapshot", () => {
  const [baseline, current, returned] = inputs();
  current.records[2].__proto__.constructor = "changed source";
  const c = run([files[0], "-", files[2]], { input: JSON.stringify(current) });
  success(c);
  let entry = JSON.parse(c.stdout).entries.find(entry => entry.id === "__proto__");
  assert.equal(entry.kind, "conflict");
  assert.deepEqual(entry.issues, ["current-source-changed"]);
  assert.equal(entry.current.record.__proto__.constructor, "changed source");
  assert.equal(entry.proposed, null);
  returned.records[2].__proto__.constructor = "changed return";
  returned.records = returned.records.filter(record => record.id !== "constructor");
  delete returned.reviews.constructor;
  returned.records.unshift(row("unknown"));
  returned.reviews.unknown = { decision: "approved", notes: "" };
  const r = run([files[0], files[1], "-"], { input: JSON.stringify(returned) });
  success(r);
  const plan = JSON.parse(r.stdout);
  entry = plan.entries.find(entry => entry.id === "__proto__");
  assert.equal(entry.kind, "conflict");
  assert.deepEqual(entry.issues, ["returned-source-changed"]);
  assert.deepEqual(plan.entries[0], { id: "unknown", kind: "unknown", issues: ["unknown-baseline", "missing-current"],
    baseline: null, current: null, returned: { record: row("unknown"), review: { decision: "approved", notes: "" } }, proposed: null });
  assert.equal(plan.entries.at(-1).id, "constructor");
  assert.equal(plan.entries.at(-1).kind, "missing");
  assert.equal(plan.entries.at(-1).returned, null);
  assert.equal(Object.hasOwn(plan, "records"), false);
  assert.equal(Object.hasOwn(plan, "reviews"), false);
  assert.deepEqual(inputs()[0], baseline);
});

test("real CLI rejects malformed complete inputs and all write modes before emitting any plan", () => {
  const before = files.map(file => fs.readFileSync(file));
  const badUnknown = snapshot([row("new")]); badUnknown.reviews.new.notes = null;
  for (const invalid of ["", "{", "[]", JSON.stringify(badUnknown)]) {
    for (let index = 0; index < 3; index++) {
      const args = [...files]; args[index] = "-";
      failure(run(args, { input: invalid }), new RegExp(["Baseline", "Current", "Returned"][index] + " review \\(stdin\\)"));
    }
  }
  for (const args of [[], files.slice(0, 2), [...files, "--apply", files[0]], [...files, "--output", files[1]],
    [...files, "--plan"], ["-", "-", files[2]], ["--bad", files[1], files[2]]]) {
    failure(run(args, { input: "{bad" }), /Expected baseline|only one input/);
  }
  for (let index = 0; index < 3; index++) {
    const args = [...files]; args[index] = path.join(fixtureDirectory, "does-not-exist.json");
    failure(run(args), /could not be read/);
  }
  for (const flag of ["--help", "-h"]) {
    const result = run([flag]); success(result);
    assert.match(result.stdout, /no apply mode or output-file option/);
    assert.match(result.stdout, /no chronology, real reviewer identity or human approval/);
  }
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
});

test("real CLI accepts prefixed dash/space paths, preserves BOM/CRLF bytes, and reports stdout failures", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-reconcile-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const names = ["-baseline.json", "current review.json", "returned.json"];
  const bytes = files.map(file => Buffer.from("\uFEFF" + fs.readFileSync(file, "utf8").replaceAll("\n", "\r\n")));
  names.forEach((name, index) => fs.writeFileSync(path.join(directory, name), bytes[index], { flag: "wx" }));
  const args = ["./-baseline.json", path.join(directory, names[1]), names[2]];
  const result = run(args, { cwd: directory }); success(result);
  assert.deepEqual(JSON.parse(result.stdout), expectedFixturePlan());
  const fd = fs.openSync(path.join(directory, names[0]), "r");
  try {
    assert.throws(() => fs.writeSync(fd, "x"), { code: "EBADF" });
    const failed = run(args, { cwd: directory, stdio: ["pipe", fd, "pipe"] });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Could not write plan to stdout/);
  } finally { fs.closeSync(fd); }
  assert.deepEqual(names.map(name => fs.readFileSync(path.join(directory, name))), bytes);
  assert.deepEqual(fs.readdirSync(directory).sort(), [...names].sort());
});

test("existing real two-way counts, plan and exclusive fresh apply remain baseline-unaware controls", t => {
  const before = files.map(file => fs.readFileSync(file));
  const counts = run(files.slice(1), {}, "review-return.js"); success(counts);
  assert.equal(counts.stdout, "Eligible: 3 | Unchanged: 2 | Changed-record conflicts: 0 | Unknown IDs: 0\nRead-only preview. No files written.\n");
  const result = run([...files.slice(1), "--plan"], {}, "review-return.js"); success(result);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.counts, { total: 5, eligible: 3, unchanged: 2, unknown: 0, conflict: 0 });
  assert.deepEqual(plan.entries.map(({ id, kind }) => [id, kind]), [
    ["split", "eligible"], ["9007199254740993", "unchanged"], ["__proto__", "eligible"], ["0", "unchanged"], ["constructor", "eligible"],
  ]);
  assert.deepEqual(plan.entries[2].after.review, { decision: "unreviewed", notes: "" });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-reconcile-two-way-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "applied.json");
  const applied = run([...files.slice(1), "--apply", output], {}, "review-return.js"); success(applied);
  assert.match(applied.stdout, /Applied 3 review update\(s\)/);
  const expected = inputs()[1];
  expected.reviews.split = { decision: "unreviewed", notes: "returned note only" };
  expected.reviews.__proto__ = { decision: "unreviewed", notes: "" };
  expected.reviews.constructor = { decision: "unreviewed", notes: "" };
  // The legacy serializer canonicalizes negative zero; its behavior stays intact.
  expected.records[1].negativeZero = 0;
  const outputBytes = fs.readFileSync(output);
  assert.deepEqual(JSON.parse(outputBytes), expected);
  failure(run([...files.slice(1), "--apply", output], {}, "review-return.js"), /already exists; not overwritten/);
  assert.deepEqual(fs.readFileSync(output), outputBytes);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
});
