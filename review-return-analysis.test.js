"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { parseSnapshotJSON } = require("./review-state.js");
const { analyzeReturns } = require("./review-analysis.js");
const command = path.join(__dirname, "review-return-analysis.js");
const exactNotes = '  "quoted"\r\nline\n雪 e\u0301 <em>x</em>  ';

function fixtures(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-return-analysis-test-"));
  // Only the directory allocated by this test; no shared fixtures or worktrees.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = JSON.parse('[{"id":"__proto__","title":"Special","__proto__":"own cell","nested":{"zero":0,"empty":null,"flag":false}},{"id":"0007","title":"Exact notes"},{"id":"same","title":"Unchanged"},{"id":"decision","title":"Decision only"},{"id":"one","title":"One source"},{"id":"conflict-first","title":"Array conflict","list":[1,2]},{"id":"conflict-second","title":"Type conflict","value":0},{"id":"mixed","title":"Missing versus null"},{"id":"local","title":"Local only"}]');
  const working = { format: "record-review", version: 1, records,
    reviews: Object.fromEntries(records.map(({ id }) => [id, { decision: "approved", notes: "Keep " + id }])) };
  const first = structuredClone(working);
  first.records = [ { id: "unknown-z", title: "Unknown Z" }, first.records[6], first.records[2],
    first.records[3], first.records[0], { id: "constructor", title: "Unknown A" },
    first.records[5], first.records[4], first.records[1], first.records[7] ];
  first.records[1].value = "0";
  first.records[4].nested = { flag: false, empty: null, zero: 0 }; // key order is irrelevant
  first.records[6].list.reverse();
  first.records[9].value = null;
  first.reviews = Object.fromEntries(first.records.map(({ id }) => [id, { decision: "follow-up", notes: exactNotes }]));
  first.reviews.__proto__ = { decision: "unreviewed", notes: "" };
  first.reviews.same = structuredClone(working.reviews.same);
  first.reviews.decision = structuredClone(working.reviews.decision);
  const second = structuredClone(first);
  second.records = second.records.filter(record => record.id !== "one").reverse();
  delete second.reviews.one;
  delete second.records.find(record => record.id === "mixed").value;
  second.reviews["0007"].notes = exactNotes.replace("\r\n", "\n");
  second.reviews.decision.decision = "rejected";
  const put = (name, value) => fs.writeFileSync(path.join(directory, name),
    typeof value === "string" ? value : JSON.stringify(value), "utf8");
  put("working.json", working);
  put("first.json", first);
  put("second.json", second);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [command, ...args], { cwd: directory, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const bytes = name => fs.readFileSync(path.join(directory, name));
  const report = name => JSON.parse(bytes(name));
  const inputBytes = () => ["working.json", "first.json", "second.json"].map(bytes);
  return { directory, working, first, second, put, run, bytes, report, inputBytes };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}
function failure(result) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Error:.*\n/);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, "");
}
function expectedSources() {
  return [
    { ordinal: 1, filename: "first.json",
      counts: { total: 10, eligible: 3, unchanged: 2, conflict: 3, unknown: 2 },
      issues: [ { id: "conflict-first", kind: "conflict" }, { id: "conflict-second", kind: "conflict" },
        { id: "mixed", kind: "conflict" }, { id: "unknown-z", kind: "unknown" }, { id: "constructor", kind: "unknown" } ] },
    { ordinal: 2, filename: "second.json",
      counts: { total: 9, eligible: 4, unchanged: 1, conflict: 2, unknown: 2 },
      issues: [ { id: "conflict-first", kind: "conflict" }, { id: "conflict-second", kind: "conflict" },
        { id: "constructor", kind: "unknown" }, { id: "unknown-z", kind: "unknown" } ] },
  ];
}
function pair(id, status, left, right = left) {
  return { id, status, proposals: [
    { sourceOrdinal: 1, filename: "first.json", ...left },
    { sourceOrdinal: 2, filename: "second.json", ...right },
  ] };
}

test("complete report preserves canonical classifications, exact pairs and both ordering rules", t => {
  const f = fixtures(t);
  const before = f.inputBytes();
  const result = f.run("working.json", "first.json", "second.json", "--output", "report.json");
  success(result);
  assert.match(result.stdout, /Analyzed 2 returned snapshot\(s\); 4 overlapping record\(s\).*No reviews applied/);
  assert.deepEqual(f.report("report.json"), {
    kind: "record-review-return-analysis", working: { filename: "working.json", recordCount: 9 },
    sources: expectedSources(), overlaps: [
      pair("__proto__", "identical", { decision: "unreviewed", notes: "" }),
      pair("0007", "disagreement", { decision: "follow-up", notes: exactNotes },
        { decision: "follow-up", notes: exactNotes.replace("\r\n", "\n") }),
      pair("same", "identical", { decision: "approved", notes: "Keep same" }),
      pair("decision", "disagreement", { decision: "approved", notes: "Keep decision" },
        { decision: "rejected", notes: "Keep decision" }),
    ],
  });
  const inputs = ["working.json", "first.json", "second.json"].map(filename =>
    Object.freeze({ filename, text: f.bytes(filename).toString() }));
  const direct = analyzeReturns(inputs[0], Object.freeze(inputs.slice(1)));
  assert.equal(f.bytes("report.json").toString(), JSON.stringify(direct, null, 2) + "\n");
  assert.deepEqual(f.inputBytes(), before);
  assert.throws(() => parseSnapshotJSON(f.bytes("report.json").toString()), /version 1/);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["first.json", "report.json", "second.json", "working.json"]);
});

test("input permutation changes ordinals, not working-record order or exact proposal values", t => {
  const f = fixtures(t);
  success(f.run("working.json", "first.json", "second.json", "--output", "forward.json"));
  success(f.run("working.json", "second.json", "first.json", "--output", "reverse.json"));
  const forward = f.report("forward.json");
  const reverse = f.report("reverse.json");
  assert.deepEqual(reverse.sources, forward.sources.slice().reverse().map((source, index) => ({ ...source, ordinal: index + 1 })));
  assert.deepEqual(reverse.overlaps, forward.overlaps.map(row => ({ ...row,
    proposals: row.proposals.slice().reverse().map((proposal, index) => ({ ...proposal, sourceOrdinal: index + 1 })) })));
});

test("all proposals participate, but a conflict in one source never becomes a proposal", t => {
  const f = fixtures(t);
  const third = structuredClone(f.second);
  third.reviews.__proto__.notes = " "; // third-only difference, not trim-equivalent
  f.put("third.json", third);
  success(f.run("working.json", "second.json", "second.json", "third.json", "--output", "three.json"));
  const report = f.report("three.json");
  assert.equal(report.sources.length, 3);
  assert.equal(report.overlaps[0].status, "disagreement");
  assert.deepEqual(report.overlaps[0].proposals.map(proposal => proposal.notes), ["", "", " "]);
  assert.deepEqual(report.overlaps[0].proposals.map(proposal => proposal.sourceOrdinal), [1, 2, 3]);
  success(f.run("working.json", "first.json", "second.json", "third.json", "--output", "mixed.json"));
  const mixed = f.report("mixed.json").overlaps.find(row => row.id === "mixed");
  assert.equal(mixed.status, "identical");
  assert.deepEqual(mixed.proposals, [
    { sourceOrdinal: 2, filename: "second.json", decision: "follow-up", notes: exactNotes },
    { sourceOrdinal: 3, filename: "third.json", decision: "follow-up", notes: exactNotes },
  ]);
});

test("duplicate basenames and repeated inputs stay distinguishable by source ordinal", t => {
  const f = fixtures(t);
  fs.mkdirSync(path.join(f.directory, "sub"));
  f.put("sub/first.json", f.second);
  const absolute = path.join(f.directory, "first.json");
  success(f.run(path.join(f.directory, "working.json"), absolute, "sub/first.json", absolute, "--output", "report.json"));
  const report = f.report("report.json");
  assert.deepEqual(report.working, { filename: "working.json", recordCount: 9 });
  assert.deepEqual(report.sources.map(({ ordinal, filename }) => ({ ordinal, filename })),
    [1, 2, 3].map(ordinal => ({ ordinal, filename: "first.json" })));
  const notes = report.overlaps.find(row => row.id === "0007");
  assert.equal(notes.status, "disagreement");
  assert.deepEqual(notes.proposals, [exactNotes, exactNotes.replace("\r\n", "\n"), exactNotes]
    .map((value, index) => ({ sourceOrdinal: index + 1, filename: "first.json", decision: "follow-up", notes: value })));
  assert.equal(report.overlaps.find(row => row.id === "one").status, "identical");
});

test("one return, empty snapshots, BOM, spaces and prefixed hyphen paths work without inferred proposals", t => {
  const f = fixtures(t);
  f.put("-working file.json", "\uFEFF" + JSON.stringify(f.working));
  success(f.run("./-working file.json", "first.json", "--output", "one report.json"));
  const report = f.report("one report.json");
  assert.deepEqual(report.working, { filename: "-working file.json", recordCount: 9 });
  assert.deepEqual(report.sources, expectedSources().slice(0, 1));
  assert.deepEqual(report.overlaps, []);
  const empty = { format: "record-review", version: 1, records: [], reviews: {} };
  f.put("empty.json", empty);
  success(f.run("empty.json", "empty.json", "empty.json", "--output", "./-empty report.json"));
  assert.deepEqual(f.report("-empty report.json"), {
    kind: "record-review-return-analysis", working: { filename: "empty.json", recordCount: 0 },
    sources: [1, 2].map(ordinal => ({ ordinal, filename: "empty.json",
      counts: { total: 0, eligible: 0, unchanged: 0, conflict: 0, unknown: 0 }, issues: [] })), overlaps: [],
  });
  success(f.run("empty.json", "first.json", "first.json", "--output", "unknown.json"));
  assert.deepEqual(f.report("unknown.json").overlaps, []);
  assert.deepEqual(f.report("unknown.json").sources[0].issues, f.first.records.map(({ id }) => ({ id, kind: "unknown" })));
});

test("help and invalid argument forms never create an output", t => {
  const f = fixtures(t);
  const before = f.inputBytes();
  for (const flag of ["--help", "-h"]) {
    const result = f.run(flag);
    success(result);
    assert.match(result.stdout, /Usage:.*\n/);
    assert.match(result.stdout, /--output report.json/);
  }
  for (const args of [[], ["working.json"], ["working.json", "--output", "report.json"],
    ["working.json", "first.json"], ["working.json", "first.json", "report.json"],
    ["working.json", "first.json", "--output"], ["working.json", "first.json", "--apply", "report.json"],
    ["working.json", "first.json", "--output", "report.json", "extra"],
    ["working.json", "first.json", "--output", "x.json", "--output", "report.json"],
    ["working.json", "first.json", "--output", "-report.json"],
    ["working.json", "", "--output", "report.json"], ["--help", "first.json", "--output", "report.json"]]) {
    failure(f.run(...args));
  }
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["first.json", "second.json", "working.json"]);
  assert.deepEqual(f.inputBytes(), before);
});

test("every input position fully validates late excluded entries before any output-file effect", t => {
  const f = fixtures(t);
  const before = f.inputBytes();
  const invalid = ["{", "[]", "id,title\na,A", { ...f.first, version: 2 }];
  for (const mutate of [
    value => { value.reviews.constructor.notes = null; },
    value => { value.reviews["mixed"].decision = "invalid"; },
    value => { value.records.push(value.records[0]); },
    value => { delete value.reviews.same; },
    value => { value.reviews.extra = { decision: "approved", notes: "extra" }; },
    value => { value.records.at(-1).title = ""; },
  ]) {
    const value = structuredClone(f.first);
    mutate(value);
    invalid.push(value);
  }
  f.put("existing.json", "keep destination bytes");
  for (const value of invalid) {
    f.put("invalid.json", value);
    const invalidBytes = f.bytes("invalid.json");
    for (const index of [0, 1, 2]) {
      const inputs = ["working.json", "first.json", "second.json"];
      inputs[index] = "invalid.json";
      for (const output of ["absent.json", "existing.json"]) {
        const result = f.run(...inputs, "--output", output);
        failure(result);
        assert.doesNotMatch(result.stderr, /already exists|Could not finish writing/);
        assert.equal(fs.existsSync(path.join(f.directory, "absent.json")), false);
        assert.equal(f.bytes("existing.json").toString(), "keep destination bytes");
      }
    }
    assert.deepEqual(f.bytes("invalid.json"), invalidBytes);
  }
  assert.deepEqual(f.inputBytes(), before);
});

test("exclusive creation protects all inputs, existing destinations, path aliases and links", t => {
  const f = fixtures(t);
  const before = f.inputBytes();
  f.put("existing.json", "never truncate");
  fs.mkdirSync(path.join(f.directory, "sub"));
  fs.symlinkSync(f.directory, path.join(f.directory, "directory-link"), "dir");
  const outputs = ["existing.json", "sub"];
  for (const name of ["working.json", "first.json", "second.json", "existing.json"]) {
    fs.symlinkSync(name, path.join(f.directory, name + ".symlink"));
    fs.linkSync(path.join(f.directory, name), path.join(f.directory, name + ".hardlink"));
    outputs.push(name, "./" + name, "sub/../" + name, path.join(f.directory, name),
      "directory-link/" + name, name + ".symlink", name + ".hardlink");
  }
  fs.symlinkSync("missing-target.json", path.join(f.directory, "dangling.json"));
  outputs.push("dangling.json");
  for (const output of outputs) {
    const result = f.run("working.json", "first.json", "second.json", "--output", output);
    failure(result);
    assert.match(result.stderr, /already exists; not overwritten/);
  }
  assert.deepEqual(f.inputBytes(), before);
  assert.equal(f.bytes("existing.json").toString(), "never truncate");
  assert.equal(fs.existsSync(path.join(f.directory, "missing-target.json")), false);
  assert.equal(fs.lstatSync(path.join(f.directory, "dangling.json")).isSymbolicLink(), true);
  success(f.run("working.json.symlink", "first.json.hardlink", "second.json.symlink", "--output", "report.json"));
  assert.deepEqual(f.report("report.json").sources.map(source => source.filename), ["first.json.hardlink", "second.json.symlink"]);
  assert.deepEqual(f.inputBytes(), before);
});

test("read and output failures are honest and do not claim completion", t => {
  const f = fixtures(t);
  for (const index of [0, 1, 2]) {
    const inputs = ["working.json", "first.json", "second.json"];
    inputs[index] = "missing.json";
    const result = f.run(...inputs, "--output", "report.json");
    failure(result);
    assert.match(result.stderr, /could not be read/);
    assert.equal(fs.existsSync(path.join(f.directory, "report.json")), false);
  }
  const result = f.run("working.json", "first.json", "second.json", "--output", "missing-directory/report.json");
  failure(result);
  assert.match(result.stderr, /Could not finish writing/);
  assert.match(result.stderr, /may leave a partial new file/);
  assert.equal(fs.existsSync(path.join(f.directory, "missing-directory")), false);
});

test("a later invocation reads changed files afresh without changing an earlier report", t => {
  const f = fixtures(t);
  success(f.run("working.json", "first.json", "second.json", "--output", "earlier.json"));
  const earlier = f.bytes("earlier.json");
  f.working.records[0].title = "Changed locally";
  f.put("working.json", f.working);
  success(f.run("working.json", "first.json", "second.json", "--output", "later.json"));
  assert.deepEqual(f.bytes("earlier.json"), earlier);
  assert.deepEqual(f.report("later.json").overlaps.map(row => row.id), ["0007", "same", "decision"]);
  assert.equal(f.report("later.json").sources[0].counts.conflict, 4);
});

test("two real commands competing for one fresh path cannot overwrite each other", async t => {
  const f = fixtures(t);
  const before = f.inputBytes();
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, "working.json", "first.json", "second.json", "--output", "race.json"],
      { cwd: f.directory, timeout: 10000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(result => result.status).sort(), [0, 1]);
  assert.ok(results.every(result => result.signal === null));
  success(results.find(result => result.status === 0));
  const refused = results.find(result => result.status === 1);
  failure(refused);
  assert.match(refused.stderr, /already exists; not overwritten/);
  success(f.run("working.json", "first.json", "second.json", "--output", "comparison.json"));
  assert.deepEqual(f.bytes("race.json"), f.bytes("comparison.json"));
  assert.deepEqual(f.inputBytes(), before);
});


test("real CLI delegates once to the production shared owner with complete ordered input text", t => {
  const f = fixtures(t);
  const ownerPath = require.resolve("./review-analysis.js");
  // Instrument Node's module boundary in this child only. No production hook,
  // alternate policy, test-only export, or replacement of the actual analysis.
  f.put("trace-owner.cjs", `
    const fs = require("node:fs");
    const ownerPath = ${JSON.stringify(ownerPath)};
    const owner = require(ownerPath);
    require.cache[ownerPath].exports = { analyzeReturns(working, returned) {
      fs.appendFileSync("owner-calls.jsonl", JSON.stringify([working, ...returned]) + "\\n");
      return owner.analyzeReturns(working, returned);
    } };
  `);
  const args = ["--require", path.join(f.directory, "trace-owner.cjs"), command,
    "working.json", "second.json", "first.json", "second.json", "--output", "delegated.json"];
  const result = spawnSync(process.execPath, args, { cwd: f.directory, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error); success(result);
  const calls = f.bytes("owner-calls.jsonl").toString().trim().split("\n");
  assert.equal(calls.length, 1);
  const inputs = JSON.parse(calls[0]);
  assert.deepEqual(inputs.map(input => input.filename), ["working.json", "second.json", "first.json", "second.json"]);
  for (const input of inputs) {
    assert.equal(input.text, f.bytes(input.filename).toString());
    assert.equal(input.purpose, "Input " + JSON.stringify(input.filename));
  }
  assert.equal(f.bytes("delegated.json").toString(),
    JSON.stringify(analyzeReturns(inputs[0], inputs.slice(1)), null, 2) + "\n");
});
