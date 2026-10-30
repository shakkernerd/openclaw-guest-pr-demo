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
  const runInput = (input, ...args) => {
    const result = spawnSync(process.execPath, [command, ...args], { cwd: directory, input, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const run = (...args) => runInput(undefined, ...args);
  const bytes = name => fs.readFileSync(path.join(directory, name));
  return { directory, working, returned, put, run, runInput, bytes };
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


// Independent expected classifications; do not use the preview engine as the
// only oracle. Keep every before/after value and the returned record order.
function expectedPlan(f) {
  const entry = (id, kind, currentIndex, returnedIndex) => ({ id, kind,
    before: currentIndex === null ? null
      : { record: f.working.records[currentIndex], review: f.working.reviews[id] },
    after: { record: f.returned.records[returnedIndex], review: f.returned.reviews[id] },
  });
  return { counts: { total: 5, eligible: 2, unchanged: 1, unknown: 1, conflict: 1 }, entries: [
    entry("notes", "eligible", 3, 0), entry("changed", "conflict", 2, 1),
    entry("__proto__", "eligible", 0, 2), entry("same", "unchanged", 1, 3),
    entry("constructor", "unknown", null, 4),
  ] };
}

function assertPlan(result, expected) {
  success(result);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  // Also checks complete serialization, property/entry order and final newline.
  assert.equal(result.stdout, JSON.stringify(expected, null, 2) + "\n");
}

test("plan emits complete ordered values identically from files or either stdin input without writes", t => {
  const f = fixtures(t);
  // BOM, indentation and CRLF in the input layout must not be rewritten.
  f.put("working.json", "\uFEFF" + JSON.stringify(f.working, null, 2).replaceAll("\n", "\r\n") + "\r\n");
  f.put("returned.json", JSON.stringify(f.returned, null, 4) + "\n");
  const before = [f.bytes("working.json"), f.bytes("returned.json")];
  const names = fs.readdirSync(f.directory);
  const expected = expectedPlan(f);
  for (const result of [
    f.run("working.json", "returned.json", "--plan"),
    f.run("working.json", "returned.json", "--plan"),
    f.runInput(before[1], "working.json", "-", "--plan"),
    f.runInput(before[0], "-", "returned.json", "--plan"),
    // Unrequested stdin is ignored when both input paths are supplied.
    f.runInput("not JSON", "working.json", "returned.json", "--plan"),
  ]) assertPlan(result, expected);
  for (const result of [f.runInput(before[1], "working.json", "-"),
    f.runInput(before[0], "-", "returned.json")]) {
    success(result);
    assert.equal(result.stdout, summary + "\nRead-only preview. No files written.\n");
  }
  assert.deepEqual(fs.readdirSync(f.directory), names);
  assert.deepEqual([f.bytes("working.json"), f.bytes("returned.json")], before);
});

test("plan retains owner normalization, exact IDs, type/membership semantics and empty snapshots", t => {
  const f = fixtures(t);
  const records = JSON.parse('[{"id":" A ","title":"Typed parcel","value":3},{"id":"a","title":"Missing field"},{"id":"empty","title":"Empty field","value":""},{"id":"same","title":"Own fields","__proto__":{"n":null}}]');
  const snapshot = (records, notes) => ({ format: "record-review", version: 1, records,
    reviews: Object.fromEntries(records.map(({ id }) => [id, { decision: "approved", notes, ignored: true }])),
    ignoredEnvelope: true });
  const working = snapshot(records, "keep");
  const returned = snapshot([
    { ...records[2], value: null }, { id: "A", title: "Exact ID, not trimmed" },
    { ...records[0], value: "3" }, { ...records[1], value: null },
    JSON.parse('{"__proto__":{"n":null},"title":"Own fields","id":"same"}'),
  ], "  \r\n雪 e\u0301 <em>x</em>  ");
  f.put("typed.json", working); f.put("typed-return.json", returned);
  const before = [f.bytes("typed.json"), f.bytes("typed-return.json")];
  const kinds = ["conflict", "unknown", "conflict", "conflict", "eligible"];
  const expected = { counts: { total: 5, eligible: 1, unchanged: 0, unknown: 1, conflict: 3 },
    entries: returned.records.map((record, index) => ({ id: record.id, kind: kinds[index],
      before: index === 1 ? null : { record: records[[2, -1, 0, 1, 3][index]],
        review: { decision: "approved", notes: "keep" } },
      after: { record, review: { decision: "approved", notes: returned.reviews[record.id].notes } },
    })) };
  assertPlan(f.run("typed.json", "typed-return.json", "--plan"), expected);
  assert.deepEqual([f.bytes("typed.json"), f.bytes("typed-return.json")], before);
  const empty = { format: "record-review", version: 1, records: [], reviews: {} };
  f.put("empty.json", empty);
  assertPlan(f.runInput(JSON.stringify(empty), "empty.json", "-", "--plan"),
    { counts: { total: 0, eligible: 0, unchanged: 0, unknown: 0, conflict: 0 }, entries: [] });
  assertPlan(f.run("working.json", "empty.json", "--plan"),
    { counts: { total: 0, eligible: 0, unchanged: 0, unknown: 0, conflict: 0 }, entries: [] });
});

test("plan rejects complete invalid file or stdin inputs with owner diagnostics and no partial stdout", t => {
  const f = fixtures(t);
  const duplicate = structuredClone(f.returned);
  duplicate.records.push(duplicate.records[0]);
  const invalidUnknown = structuredClone(f.returned);
  invalidUnknown.reviews.constructor.notes = null;
  const invalidConflict = structuredClone(f.returned);
  invalidConflict.reviews.changed.decision = "maybe";
  const invalids = [
    ["", "Choose a JSON file or paste JSON first."],
    ["{", "Invalid JSON. Check commas, quotes, and brackets. Nothing was replaced."],
    ["null", 'Expected a records array or a version 1 "record-review" export.'],
    ["[]", 'needs a saved version 1 "record-review" snapshot, not a records array.'],
    [{ ...f.returned, records: {} }, "Records must be a JSON array."],
    [{ ...f.returned, reviews: [] }, "Export reviews must be an object keyed by record ID."],
    [{ ...f.returned, reviews: {} }, "Export must contain exactly one review for every record."],
    [duplicate, 'Record 6 repeats id "notes".'],
    [invalidUnknown, 'Invalid decision or notes for id "constructor".'],
    [invalidConflict, 'Invalid decision or notes for id "changed".'],
  ];
  const original = [f.bytes("working.json"), f.bytes("returned.json")];
  for (const [invalid, diagnostic] of invalids) {
    f.put("invalid.json", invalid);
    const bytes = f.bytes("invalid.json");
    const names = fs.readdirSync(f.directory);
    for (const [args, input, label] of [
      [["invalid.json", "returned.json", "--plan"], undefined, 'Working review "invalid.json"'],
      [["working.json", "invalid.json", "--plan"], undefined, 'Returned review "invalid.json"'],
      [["-", "returned.json", "--plan"], bytes, "Working review (stdin)"],
      [["working.json", "-", "--plan"], bytes, "Returned review (stdin)"],
    ]) {
      const result = f.runInput(input, ...args);
      failure(result);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.startsWith("Error: " + label + ": "), result.stderr);
      assert.ok(result.stderr.split("\n\nUsage:")[0].includes(diagnostic), result.stderr);
    }
    assert.deepEqual(fs.readdirSync(f.directory), names);
    assert.deepEqual(f.bytes("invalid.json"), bytes);
  }
  assert.deepEqual([f.bytes("working.json"), f.bytes("returned.json")], original);
});

test("plan usage rejects ambiguous stdin and apply combinations before reads, and labels missing paths", t => {
  const f = fixtures(t);
  const names = fs.readdirSync(f.directory);
  for (const args of [
    ["-", "-", "--plan"], ["-", "-"],
    ["working.json", "-", "--apply", "out.json"], ["-", "returned.json", "--apply", "out.json"],
    ["working.json", "returned.json", "--plan", "--apply", "out.json"],
    ["working.json", "returned.json", "--apply", "out.json", "--plan"],
    ["working.json", "returned.json", "--plan", "out.json"],
    ["working.json", "returned.json", "--plan", "--plan"],
    ["working.json", "returned.json", "--output", "out.json"],
  ]) {
    const result = f.runInput("{bad", ...args);
    failure(result);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /Invalid JSON|could not be read/);
  }
  for (const [args, label] of [
    [["missing.json", "returned.json", "--plan"], "Working review"],
    [["working.json", "missing.json", "--plan"], "Returned review"],
  ]) {
    const result = f.run(...args);
    failure(result);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.startsWith('Error: ' + label + ' "missing.json" could not be read:'));
  }
  const help = f.run("--help");
  success(help);
  assert.match(help.stdout, /--plan/);
  assert.match(help.stdout, /stdin through EOF/);
  assert.deepEqual(fs.readdirSync(f.directory), names);
});

test("plan accepts absolute paths, spaces, and explicitly prefixed dash filenames", t => {
  const f = fixtures(t);
  f.put("-", f.working);
  f.put("-returned review.json", f.returned);
  const before = [f.bytes("-"), f.bytes("-returned review.json")];
  assertPlan(f.run("./-", path.join(f.directory, "-returned review.json"), "--plan"), expectedPlan(f));
  assertPlan(f.run(path.join(f.directory, "-"), "./-returned review.json", "--plan"), expectedPlan(f));
  assert.deepEqual([f.bytes("-"), f.bytes("-returned review.json")], before);
});

test("plan delegates parsing and preview only, with frozen owner states and stdout-only writes", t => {
  const f = fixtures(t);
  const review = require("./review-state.js");
  const freeze = value => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const calls = [], states = [], output = [];
  const owner = {
    parseSnapshotJSON(text, purpose) {
      calls.push(purpose);
      const state = freeze(review.parseSnapshotJSON(text, purpose));
      states.push(state);
      return state;
    },
    previewReviewUpdates(current, incoming) {
      calls.push("preview");
      assert.equal(current, states[0]); assert.equal(incoming, states[1]);
      return freeze(review.previewReviewUpdates(current, incoming));
    },
  };
  const only = api => new Proxy(api, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), "Forbidden API: " + String(key));
    return target[key];
  } });
  const processStub = { argv: ["node", command, "working.json", "returned.json", "--plan"] };
  require("node:vm").runInNewContext(fs.readFileSync(command, "utf8"), {
    require(name) {
      if (name === "./review-state.js") return only(owner);
      assert.equal(name, "node:fs");
      return only({ readFileSync(file, encoding) {
        assert.equal(encoding, "utf8");
        return f.bytes(file).toString(encoding);
      }, writeFileSync(fd, text, encoding) {
        assert.equal(fd, 1); // Never a path, input descriptor, or state write.
        assert.equal(encoding, "utf8");
        output.push(text);
      } });
    },
    process: processStub,
    console: { log: assert.fail, error: assert.fail },
  });
  assert.deepEqual(calls, ["Working review", "Returned review", "preview"]);
  assert.equal(processStub.exitCode, undefined);
  assert.deepEqual(output, [JSON.stringify(expectedPlan(f), null, 2) + "\n"]);
  assert.deepEqual(states, [f.working, f.returned]);
});


test("plan reports unwritable stdout without changing inputs", t => {
  const f = fixtures(t);
  const before = [f.bytes("working.json"), f.bytes("returned.json")];
  const names = fs.readdirSync(f.directory);
  // Same complete mixed plan and stdin intake for the valid and failed sinks.
  assertPlan(f.runInput(before[1], "working.json", "-", "--plan"), expectedPlan(f));
  const fd = fs.openSync(path.join(f.directory, "working.json"), "r");
  let result;
  try {
    assert.throws(() => fs.writeSync(fd, "x"), { code: "EBADF" });
    result = spawnSync(process.execPath, [command, "working.json", "-", "--plan"], {
      cwd: f.directory, input: before[1], encoding: "utf8", timeout: 10000,
      stdio: ["pipe", fd, "pipe"],
    });
  } finally { fs.closeSync(fd); }
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.deepEqual([f.bytes("working.json"), f.bytes("returned.json")], before);
  assert.deepEqual(fs.readdirSync(f.directory), names);
  assert.equal(result.status, 1, "a failed plan delivery must not report success");
  assert.equal(result.stdout, null); // The inherited descriptor is not captured.
  assert.match(result.stderr, /Error: Could not write plan to stdout:.*EBADF/);
  assert.match(result.stderr, /Usage:/);
});
