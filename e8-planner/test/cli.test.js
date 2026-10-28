"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseCsv } = require("../csv.js");
const cli = path.resolve(__dirname, "../cli.js");
const sample = path.resolve(__dirname, "../sample");
const VH = "name,skills,available_from,available_to,max_hours\n";
const SH = "id,starts_at,ends_at,skill,people_needed\n";
const people = VH + '"Chen, ""Mei""",repair,2026-10-31T09:00Z,2026-10-31T12:00Z,2\n';
const shifts = SH + "fix,2026-10-31T09:00Z,2026-10-31T10:00Z,repair,1\n";

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "e8-planner-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "volunteers.csv"), people);
  fs.writeFileSync(path.join(cwd, "shifts.csv"), shifts);
  return cwd;
}
function run(cwd, args = [], env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
const get = (cwd, name) => fs.readFileSync(path.join(cwd, "planner-output", name), "utf8");

test("CLI help is useful without reading input files or creating output", (t) => {
  const cwd = setup(t);
  fs.unlinkSync(path.join(cwd, "volunteers.csv"));
  const result = run(cwd, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--require-full/);
  assert.match(result.stdout, /Exit codes:/);
  assert.equal(result.stderr, "");
  assert.ok(!fs.existsSync(path.join(cwd, "planner-output")));
});

test("default paths write escaped CSV and a readable report matching stdout", (t) => {
  const cwd = setup(t);
  const result = run(cwd, ["--require-full"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const rows = parseCsv(get(cwd, "assignments.csv"));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].cells[1], 'Chen, "Mei"');
  assert.equal(result.stdout, get(cwd, "report.txt"));
  assert.match(result.stdout, /Coverage: 1\/1 person-slots filled; 0 uncovered/);
  assert.match(result.stdout, /None — every requested person-slot is filled/);
});

test("sample CLI produces gaps; --require-full returns 2 but still writes both outputs", (t) => {
  const cwd = setup(t);
  const args = ["--volunteers", path.join(sample, "volunteers.csv"), "--shifts", path.join(sample, "shifts.csv")];
  const normal = run(cwd, [...args, "--out-dir", "normal"]);
  const strict = run(cwd, [...args, "--out-dir", "strict", "--require-full"]);
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(strict.status, 2, strict.stderr);
  assert.equal(strict.stdout, normal.stdout);
  assert.equal(strict.stderr, "");
  assert.match(strict.stdout, /Coverage: 12\/16 person-slots filled; 4 uncovered/);
  for (const file of ["assignments.csv", "report.txt"]) {
    assert.equal(fs.readFileSync(path.join(cwd, "normal", file), "utf8"), fs.readFileSync(path.join(cwd, "strict", file), "utf8"));
  }
});

test("timezone/locale do not affect byte-for-byte results", (t) => {
  const cwd = setup(t);
  const a = run(cwd, ["--out-dir", "one"], { TZ: "Pacific/Honolulu", LANG: "C" });
  const b = run(cwd, ["--out-dir", "two"], { TZ: "Asia/Tokyo", LANG: "tr_TR.UTF-8" });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal(fs.readFileSync(path.join(cwd, "one/assignments.csv"), "utf8"), fs.readFileSync(path.join(cwd, "two/assignments.csv"), "utf8"));
});

test("invalid input fails with a row diagnostic before any output directory exists", (t) => {
  const cwd = setup(t);
  fs.writeFileSync(path.join(cwd, "shifts.csv"), shifts.replace("2026-10-31T09:00Z", "2026-10-31T09:00"));
  const result = run(cwd);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /shifts\.csv:2 starts_at: invalid ISO time/);
  assert.ok(!fs.existsSync(path.join(cwd, "planner-output")));
});

for (const args of [["--bogus"], ["--volunteers"], ["unexpected.csv"], ["--out-dir="], ["--volunteers", "missing.csv"]]) {
  test("usage or missing-file error: " + JSON.stringify(args), (t) => {
    const cwd = setup(t);
    const result = run(cwd, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Planner error:/);
    assert.ok(!fs.existsSync(path.join(cwd, "planner-output")));
  });
}

test("invalid UTF-8 is rejected rather than silently replacing volunteer names", (t) => {
  const cwd = setup(t);
  fs.writeFileSync(path.join(cwd, "volunteers.csv"), Buffer.from([0xff, 0xfe]));
  const result = run(cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /volunteers\.csv:/);
  assert.ok(!fs.existsSync(path.join(cwd, "planner-output")));
});

test("existing outputs are preserved, not silently replaced", (t) => {
  const cwd = setup(t);
  assert.equal(run(cwd).status, 0);
  const before = [get(cwd, "assignments.csv"), get(cwd, "report.txt")];
  const second = run(cwd);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EEXIST/);
  assert.deepEqual([get(cwd, "assignments.csv"), get(cwd, "report.txt")], before);
});

test("conflict with second output rolls back the first newly reserved file", (t) => {
  const cwd = setup(t);
  fs.mkdirSync(path.join(cwd, "planner-output"));
  fs.writeFileSync(path.join(cwd, "planner-output/report.txt"), "keep this report\n");
  const result = run(cwd);
  assert.equal(result.status, 1);
  assert.equal(get(cwd, "report.txt"), "keep this report\n");
  assert.ok(!fs.existsSync(path.join(cwd, "planner-output/assignments.csv")));
});

test("a failure after the first output is written closes handles and removes both new files", (t) => {
  const cwd = setup(t);
  const { main } = require("../cli.js");
  const write = fs.writeFileSync;
  const descriptors = [];
  let diagnostic = "";
  t.mock.method(fs, "writeFileSync", (...args) => {
    if (typeof args[0] === "number") {
      descriptors.push(args[0]);
      if (descriptors.length === 2) throw new Error("simulated disk write failure");
    }
    return write(...args);
  });
  t.mock.method(process.stderr, "write", (text) => { diagnostic += text; return true; });
  const status = main(["--volunteers", path.join(cwd, "volunteers.csv"),
    "--shifts", path.join(cwd, "shifts.csv"), "--out-dir", path.join(cwd, "planner-output")]);
  assert.equal(status, 1);
  assert.match(diagnostic, /simulated disk write failure/);
  assert.equal(descriptors.length, 2);
  for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  assert.deepEqual(fs.readdirSync(path.join(cwd, "planner-output")), []);
  assert.equal(fs.readFileSync(path.join(cwd, "volunteers.csv"), "utf8"), people);
  assert.equal(fs.readFileSync(path.join(cwd, "shifts.csv"), "utf8"), shifts);
});

test("output paths cannot overwrite an input CSV, even through a symlink", (t) => {
  const cwd = setup(t);
  fs.mkdirSync(path.join(cwd, "planner-output"));
  fs.symlinkSync(path.join(cwd, "volunteers.csv"), path.join(cwd, "planner-output/assignments.csv"));
  const result = run(cwd);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(cwd, "volunteers.csv"), "utf8"), people);
  assert.ok(fs.lstatSync(path.join(cwd, "planner-output/assignments.csv")).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(cwd, "planner-output/report.txt")));
});

test("an input named assignments.csv is never clobbered by the output", (t) => {
  const cwd = setup(t);
  fs.writeFileSync(path.join(cwd, "assignments.csv"), people);
  const result = run(cwd, ["--volunteers", "assignments.csv", "--out-dir", "."]);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(cwd, "assignments.csv"), "utf8"), people);
  assert.ok(!fs.existsSync(path.join(cwd, "report.txt")));
});

test("non-directory output fails cleanly", (t) => {
  const cwd = setup(t);
  fs.writeFileSync(path.join(cwd, "not-a-directory"), "keep me");
  const result = run(cwd, ["--out-dir", "not-a-directory"]);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(cwd, "not-a-directory"), "utf8"), "keep me");
});

test("header-only inputs are valid and still produce both outputs", (t) => {
  const cwd = setup(t);
  fs.writeFileSync(path.join(cwd, "volunteers.csv"), VH);
  fs.writeFileSync(path.join(cwd, "shifts.csv"), SH);
  const result = run(cwd, ["--require-full"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseCsv(get(cwd, "assignments.csv")).length, 1);
  assert.match(get(cwd, "report.txt"), /Coverage: 0\/0/);
});
