"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const command = path.join(__dirname, "capture-batch-run.js");
const producer = path.join(__dirname, "..", "packaging-batch-cli.js");
const reader = path.join(__dirname, "read-batch-captures.js");
const good = JSON.stringify({ items: [{ sku: "new fixture Ω", quantity: 5 }], maxItemsPerBox: 3 });
const mixed = " \t\r\n" + good + "\r\n{bad\r\n" + good;
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const frames = bytes => bytes.toString("utf8").trimEnd().split("\n").filter(Boolean).map(JSON.parse);

function fixture(t, producerHook = "", wrapperHook = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-batch-run-test-"));
  // Only this test's newly owned directory is removed, never supplied/old paths.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const starts = path.join(dir, "starts");
  const preload = path.join(dir, "observe-start.cjs");
  // A Node loader fixture, not a replacement producer or a production test flag.
  fs.writeFileSync(preload, [
    'const fs = require("node:fs");',
    "if (process.argv[1] === " + JSON.stringify(producer) + ") {",
    "fs.appendFileSync(" + JSON.stringify(starts) + ", 'start\\n');",
    producerHook,
    "}",
    "if (process.argv[1] === " + JSON.stringify(command) + ") {",
    wrapperHook,
    "}",
  ].join("\n"));
  return {
    dir, env: { ...process.env, NODE_OPTIONS: "--require " + JSON.stringify(preload) },
    count: () => fs.existsSync(starts) ? fs.readFileSync(starts, "utf8").split("\n").length - 1 : 0,
  };
}

function run(script, args, fixture) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: fixture.dir, env: fixture.env, stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}

function capture(f, args) {
  const result = run(command, args, f);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout, Buffer.alloc(0));
  return result;
}

for (const scenario of [
  { name: "success", input: " \t\r\n" + good + "\r\n" + good, status: 0, lines: [2, 3], completions: 1 },
  { name: "unsuccessful batch continues", input: mixed, status: 1, lines: [2, 4], completions: 1 },
  { name: "fail-fast retains prefix", input: mixed, status: 1, lines: [2], completions: 0, failFast: true },
]) {
  test("real command: " + scenario.name + ", one start, exact bytes, reader compatibility", t => {
    const f = fixture(t);
    const input = path.join(f.dir, "--orders ; Ω.jsonl");
    fs.writeFileSync(input, scenario.input);
    const flags = scenario.failFast ? ["--fail-fast"] : [];
    // A separate, explicit reference run is test evidence, not a wrapper retry.
    const reference = run(producer, ["--diagnostics=jsonl", ...flags, "--", input], f);
    assert.equal(reference.status, scenario.status);
    assert.equal(reference.signal, null);
    assert.equal(f.count(), 1);
    const out = path.join(f.dir, "new output");
    const result = capture(f, [...flags, "--", path.basename(input), path.basename(out)]);
    assert.equal(result.status, scenario.status);
    assert.deepEqual(result.stderr, Buffer.alloc(0));
    assert.equal(f.count(), 2); // Exactly one additional actual producer process.
    assert.deepEqual(fs.readFileSync(input), Buffer.from(scenario.input));
    assert.deepEqual(fs.readdirSync(out).sort(), ["attempt.json", "result.json", "stderr.jsonl", "stdout.jsonl"]);
    for (const stream of ["stdout", "stderr"]) {
      assert.deepEqual(fs.readFileSync(path.join(out, stream + ".jsonl")), reference[stream]);
    }
    assert.deepEqual(json(path.join(out, "attempt.json")), {
      version: 1, state: "prepared", executable: process.execPath,
      args: [producer, "--diagnostics=jsonl", ...flags, "--", fs.realpathSync.native(input)], cwd: f.dir,
    });
    assert.deepEqual(json(path.join(out, "result.json")), {
      version: 1, state: "observed", exitCode: scenario.status, signal: null, launchError: null,
    });
    assert.deepEqual(frames(reference.stdout).map(record => record.line), scenario.lines);
    assert.equal(frames(reference.stderr).filter(record => record.type === "complete").length, scenario.completions);
    if (scenario.status === 1) {
      assert.deepEqual(frames(reference.stderr).filter(record => record.type === "record-error").map(record => record.line), [3]);
    }
    const reportRun = run(reader, [path.join(out, "stdout.jsonl"), path.join(out, "stderr.jsonl")], f);
    assert.equal(reportRun.status, 0); // Reader status, not producer success.
    const report = JSON.parse(reportRun.stdout);
    assert.equal(report.observed.summaries, scenario.lines.length);
    assert.equal(report.observed.completions, scenario.completions);
    assert.deepEqual(report.issues.map(issue => issue.code), scenario.failFast ? ["missing-completion"] : []);
    assert.equal(f.count(), 2);
  });
}

test("existing attempts, empty directories and files are refused without launch or mutation", t => {
  const f = fixture(t);
  const input = path.join(f.dir, "orders");
  fs.writeFileSync(input, mixed);
  const attempt = path.join(f.dir, "prior-attempt");
  assert.equal(capture(f, [input, attempt]).status, 1);
  const snapshot = fs.readdirSync(attempt).sort().map(name => [name, fs.readFileSync(path.join(attempt, name))]);
  const empty = path.join(f.dir, "empty");
  fs.mkdirSync(empty);
  const file = path.join(f.dir, "file");
  const sentinel = Buffer.from([0, 255, 13, 10, 42]);
  fs.writeFileSync(file, sentinel);
  const targets = [attempt, empty, file];
  if (process.platform !== "win32") {
    const link = path.join(f.dir, "link");
    const dangling = path.join(f.dir, "dangling");
    fs.symlinkSync(attempt, link);
    fs.symlinkSync(path.join(f.dir, "absent"), dangling);
    targets.push(link, dangling);
  }
  for (const target of targets) {
    const refused = capture(f, [input, target]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr.toString(), /EEXIST/);
    assert.equal(f.count(), 1);
  }
  assert.deepEqual(fs.readdirSync(attempt).sort().map(name => [name, fs.readFileSync(path.join(attempt, name))]), snapshot);
  assert.deepEqual(fs.readdirSync(empty), []);
  assert.deepEqual(fs.readFileSync(file), sentinel);
  assert.equal(fs.existsSync(path.join(f.dir, "absent")), false);
});

test("argument errors and missing parent never launch; help is side-effect free", t => {
  const f = fixture(t);
  for (const args of [[], ["one"], ["a", "b", "c"], ["-", "out"], ["--", "-", "out"],
    ["", "out"], ["--fail-fast", "--fail-fast", "a", "out"], ["--unknown", "a", "out"], ["--help", "out"]]) {
    const result = capture(f, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr.toString(), /Usage:/);
  }
  assert.equal(capture(f, ["missing-input", "missing-parent/output"]).status, 1);
  assert.equal(fs.existsSync(path.join(f.dir, "missing-parent")), false);
  assert.equal(fs.existsSync(path.join(f.dir, "out")), false);
  const help = run(command, ["--help"], f);
  assert.equal(help.status, 0);
  assert.match(help.stdout.toString(), /Usage:/);
  assert.equal(help.stderr.length, 0);
  assert.equal(f.count(), 0);
});

test("missing input is a real producer exit, not a launch failure; no retry", t => {
  const f = fixture(t);
  const out = path.join(f.dir, "attempt");
  const result = capture(f, ["absent-orders", out]);
  assert.equal(result.status, 1);
  assert.equal(f.count(), 1);
  assert.equal(fs.readFileSync(path.join(out, "stdout.jsonl")).length, 0);
  assert.deepEqual(frames(fs.readFileSync(path.join(out, "stderr.jsonl"))), [
    { version: 1, type: "fatal-error", operation: "read-input", code: "ENOENT" },
  ]);
  assert.deepEqual(json(path.join(out, "result.json")), {
    version: 1, state: "observed", exitCode: 1, signal: null, launchError: null,
  });
});

test("setup-created input is refused; still-missing input remains producer-owned", t => {
  const f = fixture(t);
  let starts = 0;
  for (const [index, name] of ["stdout.jsonl", "stderr.jsonl", "attempt.json", "", "result.json", "nested/orders"].entries()) {
    const out = path.join(f.dir, "attempt-" + index);
    const result = capture(f, [path.join(out, name), out]);
    assert.equal(result.status, 1);
    if (index < 4) {
      assert.match(result.stderr.toString(), /input appeared during capture setup/);
      assert.equal(fs.existsSync(path.join(out, "result.json")), false);
    } else {
      starts += 1;
      assert.equal(result.stderr.length, 0);
      assert.deepEqual(json(path.join(out, "result.json")), {
        version: 1, state: "observed", exitCode: 1, signal: null, launchError: null,
      });
      assert.equal(frames(fs.readFileSync(path.join(out, "stderr.jsonl")))[0].code, "ENOENT");
    }
    assert.equal(json(path.join(out, "attempt.json")).state, "prepared");
    assert.equal(fs.readFileSync(path.join(out, "stdout.jsonl")).length, 0);
    assert.equal(f.count(), starts);
  }
});

test("a dangling input alias cannot become a capture and falsely succeed", {
  skip: process.platform === "win32" ? "requires unprivileged symlinks" : false,
}, t => {
  const f = fixture(t);
  for (const name of ["stdout.jsonl", "stderr.jsonl", "attempt.json"]) {
    const out = path.join(f.dir, name + "-attempt");
    const input = path.join(f.dir, name + "-input");
    fs.symlinkSync(path.join(out, name), input);
    const result = capture(f, [input, out]);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /input appeared during capture setup/);
    assert.equal(f.count(), 0);
    assert.equal(fs.existsSync(path.join(out, "result.json")), false);
    assert.equal(json(path.join(out, "attempt.json")).state, "prepared");
    assert.equal(fs.readFileSync(path.join(out, "stdout.jsonl")).length, 0);
    assert.equal(fs.readFileSync(path.join(out, "stderr.jsonl")).length, 0);
    assert.equal(capture(f, [input, out]).status, 1); // Partial attempt is retained.
    assert.equal(f.count(), 0);
  }
});

test("OS launch failure is recorded without a fictitious exit or signal", t => {
  // Alter only this test observer's Node executable property before its main.
  // spawn itself remains real: the OS rejects this newly owned absent path.
  const f = fixture(t, "", 'process.execPath = require("node:path").join(__dirname, "absent-node");');
  const out = path.join(f.dir, "attempt");
  assert.equal(capture(f, ["orders", out]).status, 1);
  assert.equal(f.count(), 0);
  const result = json(path.join(out, "result.json"));
  assert.equal(result.state, "observed");
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.launchError.code, "ENOENT");
  assert.equal(typeof result.launchError.message, "string");
  for (const stream of ["stdout", "stderr"]) assert.equal(fs.readFileSync(path.join(out, stream + ".jsonl")).length, 0);
});

const posix = { skip: process.platform === "win32" ? "requires POSIX signal semantics" : false };
test("real child signal and arbitrary partial bytes remain separate observations", posix, t => {
  const f = fixture(t, [
    "fs.writeSync(1, Buffer.from([0, 255, 13, 10, 195]));",
    "fs.writeSync(2, Buffer.from([254, 0, 10, 13]));",
    'process.kill(process.pid, "SIGTERM");',
  ].join("\n"));
  const out = path.join(f.dir, "attempt");
  assert.equal(capture(f, ["orders", out]).status, 1);
  assert.equal(f.count(), 1);
  assert.deepEqual(fs.readFileSync(path.join(out, "stdout.jsonl")), Buffer.from([0, 255, 13, 10, 195]));
  assert.deepEqual(fs.readFileSync(path.join(out, "stderr.jsonl")), Buffer.from([254, 0, 10, 13]));
  assert.deepEqual(json(path.join(out, "result.json")), {
    version: 1, state: "observed", exitCode: null, signal: "SIGTERM", launchError: null,
  });
});

test("interrupted observer leaves an unfinished attempt and refuses its reuse", posix, t => {
  const f = fixture(t, 'process.kill(process.ppid, "SIGTERM"); process.exit(0);');
  const out = path.join(f.dir, "attempt");
  const interrupted = run(command, ["orders", out], f);
  assert.equal(interrupted.status, null);
  assert.equal(interrupted.signal, "SIGTERM");
  assert.equal(f.count(), 1);
  assert.equal(json(path.join(out, "attempt.json")).state, "prepared");
  assert.equal(fs.existsSync(path.join(out, "result.json")), false);
  const snapshot = fs.readdirSync(out).sort().map(name => [name, fs.readFileSync(path.join(out, name))]);
  assert.equal(capture(f, ["orders", out]).status, 1);
  assert.equal(f.count(), 1);
  assert.deepEqual(fs.readdirSync(out).sort().map(name => [name, fs.readFileSync(path.join(out, name))]), snapshot);
});

// Filesystem-aware path regressions; small owned files only, no streaming aliases.
function pathFixture(t) {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "physical"));
  fs.mkdirSync(path.join(f.dir, "physical", "deep"));
  fs.symlinkSync("physical/deep", path.join(f.dir, "jump"));
  return f;
}
function assertSaved(out, reference) {
  for (const stream of ["stdout", "stderr"]) {
    assert.deepEqual(fs.readFileSync(path.join(out, stream + ".jsonl")), reference[stream]);
  }
  assert.deepEqual(json(path.join(out, "result.json")), {
    version: 1, state: "observed", exitCode: reference.status, signal: null, launchError: null,
  });
}

test("path selection: input symlink followed by .. selects the filesystem-named file", posix, t => {
  const f = pathFixture(t);
  fs.writeFileSync(path.join(f.dir, "physical", "orders"), good + "\n");
  fs.writeFileSync(path.join(f.dir, "orders"), '{"items":[],"maxItemsPerBox":4}\n');
  const input = "jump/../orders"; // Never path.join/resolve the supplied traversal.
  const reference = run(producer, ["--diagnostics=jsonl", "--", input], f);
  const out = path.join(f.dir, "capture");
  assert.equal(capture(f, [input, out]).status, 0);
  assertSaved(out, reference);
  assert.equal(json(path.join(out, "attempt.json")).args.at(-1),
    fs.realpathSync.native(path.join(f.dir, "physical", "orders")));
  assert.equal(f.count(), 2); // One explicit control and one capture invocation.
});

test("path selection: output symlink followed by .. creates the intended directory", posix, t => {
  const f = pathFixture(t);
  fs.writeFileSync(path.join(f.dir, "orders"), good + "\n");
  const reference = run(producer, ["--diagnostics=jsonl", "orders"], f);
  assert.equal(capture(f, ["orders", "jump/../capture"]).status, 0);
  const out = path.join(f.dir, "physical", "capture");
  assert.equal(fs.existsSync(out), true);
  assert.equal(fs.existsSync(path.join(f.dir, "capture")), false);
  assertSaved(out, reference);
  assert.equal(f.count(), 2);
});

test("path selection: an existing requested output through symlink/.. is refused", posix, t => {
  const f = pathFixture(t);
  fs.writeFileSync(path.join(f.dir, "orders"), good + "\n");
  const out = path.join(f.dir, "physical", "capture");
  fs.mkdirSync(out);
  const sentinel = Buffer.from([0, 255, 13, 10]);
  fs.writeFileSync(path.join(out, "sentinel"), sentinel);
  const result = capture(f, ["orders", "jump/../capture"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /EEXIST/);
  assert.equal(f.count(), 0);
  assert.deepEqual(fs.readdirSync(out), ["sentinel"]);
  assert.deepEqual(fs.readFileSync(path.join(out, "sentinel")), sentinel);
  assert.equal(fs.existsSync(path.join(f.dir, "capture")), false);
});

test("path selection: missing traversal remains a producer error, not a different valid file", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "orders"), good + "\n");
  const input = "absent/../orders";
  const reference = run(producer, ["--diagnostics=jsonl", "--", input], f);
  assert.equal(reference.status, 1);
  const out = path.join(f.dir, "capture");
  assert.equal(capture(f, [input, out]).status, 1);
  assertSaved(out, reference);
  assert.equal(fs.readFileSync(path.join(out, "stdout.jsonl")).length, 0);
  assert.equal(frames(reference.stderr)[0].code, "ENOENT");
  assert.equal(f.count(), 2);
});

test("path selection: ordinary input symlinks and relative output-parent symlinks work", posix, t => {
  const f = pathFixture(t);
  fs.writeFileSync(path.join(f.dir, "physical", "orders"), good + "\n");
  fs.symlinkSync("physical/orders", path.join(f.dir, "input-link"));
  const reference = run(producer, ["--diagnostics=jsonl", "input-link"], f);
  assert.equal(capture(f, ["./input-link", "./jump/capture"]).status, 0);
  assertSaved(path.join(f.dir, "physical", "deep", "capture"), reference);
  assert.equal(f.count(), 2);
});

test("path selection: a filesystem read error remains producer-owned", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "not-readable-as-a-file"));
  const input = "not-readable-as-a-file";
  const reference = run(producer, ["--diagnostics=jsonl", input], f);
  assert.equal(reference.status, 1);
  assert.equal(frames(reference.stderr)[0].code, "EISDIR");
  const out = path.join(f.dir, "capture");
  assert.equal(capture(f, [input, out]).status, 1);
  assertSaved(out, reference);
  assert.equal(f.count(), 2);
});

for (const linked of [false, true]) {
  test("path selection: owned /proc/self/fd/1 input" + (linked ? " through a symlink" : " directly"), {
    skip: process.platform !== "linux" ? "requires Linux procfs" : false,
  }, t => {
    const f = fixture(t, "", [
      'const seen = { target: fs.readlinkSync("/proc/self/fd/1"), regular: fs.fstatSync(1).isFile(),',
      '  bytes: fs.readFileSync(process.argv[2]).toString("hex") };',
      'fs.writeFileSync(require("node:path").join(__dirname, "seen.json"), JSON.stringify(seen), { flag: "wx" });',
    ].join("\n"));
    const file = path.join(f.dir, "orders");
    const original = Buffer.from(good + "\n");
    fs.writeFileSync(file, original);
    const input = linked ? path.join(f.dir, "input-link") : "/proc/self/fd/1";
    if (linked) fs.symlinkSync("/proc/self/fd/1", input);
    const reference = run(producer, ["--diagnostics=jsonl", file], f);
    const out = path.join(f.dir, "capture");
    const fd = fs.openSync(file, "r+");
    let result;
    try {
      result = spawnSync(process.execPath, [command, input, out], {
        cwd: f.dir, env: f.env, stdio: ["ignore", fd, "pipe"], timeout: 5000,
      });
    } finally { fs.closeSync(fd); }
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stderr.length, 0);
    assert.deepEqual(json(path.join(f.dir, "seen.json")), {
      target: file, regular: true, bytes: original.toString("hex"),
    });
    assert.deepEqual(fs.readFileSync(file), original);
    assertSaved(out, reference);
    assert.equal(json(path.join(out, "attempt.json")).args.at(-1), fs.realpathSync.native(file));
    assert.equal(f.count(), 2);
  });
}
