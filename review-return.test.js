"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const command = path.join(__dirname, "review-return.js");
const summary = "Eligible: 2 | Unchanged: 1 | Changed-record conflicts: 1 | Unknown IDs: 1";

function fixtures(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-return-test-"));
  // Only this test's newly allocated directory; never shared fixtures/worktrees.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = JSON.parse('[{"id":"__proto__","title":"Special","__proto__":"own source cell","zero":0,"empty":null,"flag":false,"nested":{"markup":"<em>雪</em>","list":[1,"1",null]}},{"id":"same","title":"Same"},{"id":"changed","title":"Conflict","nested":{"list":[1,2]}},{"id":"notes","title":"Notes only"},{"id":"0007","title":"Local only","value":"0007"}]');
  const working = { format: "record-review", version: 1, records,
    reviews: Object.fromEntries(records.map(({ id }) => [id, { decision: "approved", notes: "Keep " + id }])) };
  const returned = structuredClone(working);
  returned.records = [returned.records[3], returned.records[2], returned.records[0], returned.records[1],
    { id: "constructor", title: "Unknown", quantity: "9007199254740993" }];
  returned.records[1].nested.list.reverse();
  // Object member order alone is not a record conflict.
  returned.records[2].nested = { list: [1, "1", null], markup: "<em>雪</em>" };
  returned.reviews = Object.fromEntries(returned.records.map(({ id }) => [id,
    { decision: "follow-up", notes: 'Returned "quoted"\r\nline\n雪' }]));
  returned.reviews.same = structuredClone(working.reviews.same);
  returned.reviews.notes = { decision: "approved", notes: 'Notes only: "quoted"\r\nline\n雪' };
  returned.reviews.__proto__ = { decision: "unreviewed", notes: "" };
  const put = (name, value) => fs.writeFileSync(path.join(directory, name),
    typeof value === "string" ? value : JSON.stringify(value), "utf8");
  put("working.json", working);
  put("returned.json", returned);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [command, ...args], { cwd: directory, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const bytes = name => fs.readFileSync(path.join(directory, name));
  return { directory, working, returned, put, run, bytes };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}
function failure(result) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Error:.*\n/);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stdout, /Wrote fresh output/);
}

test("real preview reports all categories without changing files", t => {
  const f = fixtures(t);
  const before = [f.bytes("working.json"), f.bytes("returned.json")];
  const names = fs.readdirSync(f.directory);
  const result = f.run("working.json", "returned.json");
  success(result);
  assert.equal(result.stdout, summary + "\nRead-only preview. No files written.\n");
  assert.deepEqual(fs.readdirSync(f.directory), names);
  assert.deepEqual([f.bytes("working.json"), f.bytes("returned.json")], before);
});

test("real apply preserves complete working records/order and all excluded reviews", t => {
  const f = fixtures(t);
  const before = [f.bytes("working.json"), f.bytes("returned.json")];
  const result = f.run("working.json", "returned.json", "--apply", "new result.json");
  success(result);
  assert.ok(result.stdout.startsWith(summary));
  assert.match(result.stdout, /Applied 2 review update\(s\)/);
  const expected = structuredClone(f.working);
  expected.reviews.__proto__ = f.returned.reviews.__proto__;
  expected.reviews.notes = f.returned.reviews.notes;
  const actual = JSON.parse(f.bytes("new result.json"));
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.records.map(Object.keys), f.working.records.map(Object.keys));
  assert.deepEqual([f.bytes("working.json"), f.bytes("returned.json")], before);
  // Reapplying is a new invocation and emits a fresh, unchanged full snapshot.
  success(f.run("new result.json", "returned.json", "--apply", "second.json"));
  assert.deepEqual(f.bytes("second.json"), f.bytes("new result.json"));
});

test("help and invalid arguments explain usage without file effects", t => {
  const f = fixtures(t);
  for (const flag of ["--help", "-h"]) {
    const result = f.run(flag);
    success(result);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--apply result.json/);
  }
  for (const args of [[], ["working.json"], ["working.json", "returned.json", "result.json"],
    ["working.json", "returned.json", "--apply"], ["working.json", "returned.json", "--force", "result.json"],
    ["working.json", "returned.json", "--apply", "result.json", "extra"], ["--help", "returned.json"]]) {
    failure(f.run(...args));
  }
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["returned.json", "working.json"]);
});

test("both complete inputs reject malformed data, including late excluded entries, before output creation", t => {
  const f = fixtures(t);
  const invalid = ["{", "[]", "id,title\na,A", { ...f.returned, version: 2 }];
  const badUnknown = structuredClone(f.returned);
  badUnknown.reviews.constructor.notes = null;
  invalid.push(badUnknown);
  const badConflict = structuredClone(f.returned);
  badConflict.reviews.changed.decision = "invalid";
  invalid.push(badConflict);
  const duplicate = structuredClone(f.returned);
  duplicate.records.push(duplicate.records[0]);
  invalid.push(duplicate);
  const missingReview = structuredClone(f.returned);
  delete missingReview.reviews.same;
  invalid.push(missingReview);
  const badRecord = structuredClone(f.returned);
  badRecord.records.at(-1).title = "";
  invalid.push(badRecord);
  f.put("existing.json", "keep destination bytes");
  for (const value of invalid) {
    f.put("invalid.json", value);
    const invalidBytes = f.bytes("invalid.json");
    for (const inputs of [["invalid.json", "returned.json"], ["working.json", "invalid.json"]]) {
      failure(f.run(...inputs));
      for (const destination of ["absent.json", "existing.json"]) {
        const result = f.run(...inputs, "--apply", destination);
        failure(result);
        assert.doesNotMatch(result.stderr, /already exists|Could not finish writing/);
        assert.equal(fs.existsSync(path.join(f.directory, "absent.json")), false);
        assert.equal(f.bytes("existing.json").toString(), "keep destination bytes");
      }
    }
    assert.deepEqual(f.bytes("invalid.json"), invalidBytes);
  }
});

test("exclusive output refuses existing files, both inputs, aliases, symlinks and hard links", t => {
  const f = fixtures(t);
  const before = [f.bytes("working.json"), f.bytes("returned.json")];
  f.put("existing.json", "never truncate me");
  fs.mkdirSync(path.join(f.directory, "sub"));
  fs.symlinkSync(f.directory, path.join(f.directory, "directory-link"), "dir");
  const targets = ["existing.json", "working.json", "returned.json", "./working.json", "sub/../returned.json",
    path.join(f.directory, "working.json"), "directory-link/returned.json", "sub"];
  for (const name of ["working.json", "returned.json", "existing.json"]) {
    fs.symlinkSync(name, path.join(f.directory, name + ".symlink"));
    fs.linkSync(path.join(f.directory, name), path.join(f.directory, name + ".hardlink"));
    targets.push(name + ".symlink", name + ".hardlink");
  }
  fs.symlinkSync("missing-target.json", path.join(f.directory, "dangling.json"));
  targets.push("dangling.json");
  for (const output of targets) {
    const result = f.run("working.json", "returned.json", "--apply", output);
    failure(result);
    assert.match(result.stderr, /already exists; not overwritten/);
  }
  assert.deepEqual([f.bytes("working.json"), f.bytes("returned.json")], before);
  assert.equal(f.bytes("existing.json").toString(), "never truncate me");
  assert.equal(fs.existsSync(path.join(f.directory, "missing-target.json")), false);
  assert.equal(fs.lstatSync(path.join(f.directory, "dangling.json")).isSymbolicLink(), true);
});

test("unreadable input and output-creation failures are honest, with no success report", t => {
  const f = fixtures(t);
  for (const inputs of [["missing.json", "returned.json"], ["working.json", "missing.json"]]) {
    const result = f.run(...inputs, "--apply", "result.json");
    failure(result);
    assert.match(result.stderr, /could not be read/);
    assert.equal(fs.existsSync(path.join(f.directory, "result.json")), false);
  }
  const result = f.run("working.json", "returned.json", "--apply", "missing-directory/result.json");
  failure(result);
  assert.match(result.stderr, /Could not finish writing/);
  assert.match(result.stderr, /may leave a partial new file/);
  assert.equal(fs.existsSync(path.join(f.directory, "missing-directory")), false);
});

test("apply rereads changed inputs rather than consuming an earlier preview plan", t => {
  const f = fixtures(t);
  success(f.run("working.json", "returned.json"));
  f.working.records[0].flag = "false";
  f.working.reviews.__proto__.notes = "Newer local note";
  f.put("working.json", f.working);
  const result = f.run("working.json", "returned.json", "--apply", "result.json");
  success(result);
  assert.match(result.stdout, /Eligible: 1 .*Changed-record conflicts: 2/);
  const expected = structuredClone(f.working);
  expected.reviews.notes = f.returned.reviews.notes;
  assert.deepEqual(JSON.parse(f.bytes("result.json")), expected);
});

test("empty snapshots and zero-eligible apply still produce one full fresh snapshot", t => {
  const f = fixtures(t);
  const empty = { format: "record-review", version: 1, records: [], reviews: {} };
  f.put("empty.json", "\uFEFF" + JSON.stringify(empty));
  const result = f.run("empty.json", "empty.json", "--apply", "result.json");
  success(result);
  assert.match(result.stdout, /Eligible: 0 .*Unchanged: 0 .*conflicts: 0 .*IDs: 0/);
  assert.match(result.stdout, /Applied 0/);
  assert.deepEqual(JSON.parse(f.bytes("result.json")), empty);
});

test("two real invocations competing for one destination cannot overwrite each other", async t => {
  const f = fixtures(t);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, "working.json", "returned.json", "--apply", "race.json"],
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
  const expected = structuredClone(f.working);
  expected.reviews.__proto__ = f.returned.reviews.__proto__;
  expected.reviews.notes = f.returned.reviews.notes;
  assert.deepEqual(JSON.parse(f.bytes("race.json")), expected);
});
