"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { compareJson } = require("./json-diff.js");

// Synthetic fixtures stay outside the source tree, retained for inspection.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "json-diff-test-"));
const cli = path.join(__dirname, "json-diff.js");
const emptyReport = '{"added":[],"removed":[],"changed":[]}\n';
let sequence = 0;
function execute(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function fixtures(left, right) {
  const paths = ["left", "right"].map(side => path.join(scratch, `${++sequence}-${side}.json`));
  const bytes = [left, right].map(value => Buffer.from(value));
  paths.forEach((file, i) => fs.writeFileSync(file, bytes[i]));
  return { paths, unchanged() {
    paths.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i], file));
  } };
}
function run(left, right, status) {
  const input = fixtures(left, right);
  const result = execute(input.paths);
  input.unchanged();
  assert.equal(result.status, status, result.stderr);
  if (status !== 2) assert.equal(result.stderr, "");
  else assert.equal(result.stdout, "");
  return result;
}
function fails(left, right, message) {
  assert.equal(run(left, right, 2).stderr, `json-diff: ${message}\n`);
}

test("CLI reports complete typed differences and literal keys without changing inputs", () => {
  const left = '{"":0,"gone":null,"array":[false,{"x":1},"tail"],"empty":"","type":[],"nested":{"a/b":{"~key":false}},"__proto__":{"constructor":"old"},"constructor":{"prototype":[]},"0":"object-key","toString":"literal","value":"__proto__","false":false,"emptyArray":[],"emptyObject":{}}';
  const right = '{"added":{"n":null,"f":false,"s":"","a":[],"o":{},"__proto__":{"constructor":"data"}},"array":[true,{"x":2}],"empty":null,"type":{},"nested":{"a/b":{"~key":true}},"__proto__":{"constructor":"new"},"constructor":{"prototype":[null]},"0":0,"toString":"literal","value":"constructor","false":0,"emptyArray":null,"emptyObject":false,"":false}';
  assert.deepEqual(JSON.parse(run(left, right, 1).stdout), {
    added: [
      { path: ["added"], value: JSON.parse('{"__proto__":{"constructor":"data"},"a":[],"f":false,"n":null,"o":{},"s":""}') },
      { path: ["constructor", "prototype", 0], value: null },
    ],
    removed: [{ path: ["array", 2], value: "tail" }, { path: ["gone"], value: null }],
    changed: [
      { path: [""], before: 0, after: false },
      { path: ["0"], before: "object-key", after: 0 },
      { path: ["__proto__", "constructor"], before: "old", after: "new" },
      { path: ["array", 0], before: false, after: true },
      { path: ["array", 1, "x"], before: 1, after: 2 },
      { path: ["empty"], before: "", after: null },
      { path: ["emptyArray"], before: [], after: null },
      { path: ["emptyObject"], before: {}, after: false },
      { path: ["false"], before: false, after: 0 },
      { path: ["nested", "a/b", "~key"], before: false, after: true },
      { path: ["type"], before: [], after: {} },
      { path: ["value"], before: "__proto__", after: "constructor" },
    ],
  });
});

test("root replacements, positional arrays and deterministic contained object ordering", () => {
  const object = '{"z":{},"10":"ten","2":"two","__proto__":{"b":false,"a":null}}';
  const reordered = '{"__proto__":{"a":null,"b":false},"2":"two","10":"ten","z":{}}';
  const first = run("[]", object, 1).stdout;
  assert.equal(first, run("[]", reordered, 1).stdout);
  assert.deepEqual(JSON.parse(first), { added: [], removed: [], changed: [
    { path: [], before: [], after: JSON.parse(object) },
  ] });
  assert.deepEqual(JSON.parse(run("[1,2]", "[2,1]", 1).stdout).changed, [
    { path: [0], before: 1, after: 2 }, { path: [1], before: 2, after: 1 },
  ]);
});

test("equal control follows native numbers, duplicate keys and order-independent objects", () => {
  const left = '{"b":{"constructor":[],"__proto__":{}},"a":[1.0,1e0,-0,1e-4000,0.10000000000000001,9007199254740991,-9007199254740991],"duplicate":1,"duplicate":2}';
  const right = '{"duplicate":2,"a":[1,1,0,0,0.1,9007199254740991,-9007199254740991],"b":{"__proto__":{},"constructor":[]}}';
  assert.equal(run(left, right, 0).stdout, emptyReport);
  const before = Buffer.from("-0");
  const after = Buffer.from("false");
  assert.deepEqual(compareJson(before, after), {
    report: '{"added":[],"removed":[],"changed":[{"path":[],"before":0,"after":false}]}\n',
    different: true,
  });
  assert.equal(before.toString(), "-0");
  assert.equal(after.toString(), "false");
  assert.throws(() => compareJson("null", after), /left: expected a Buffer/);
});

test("invalid encoding, syntax and unsafe numbers never produce a report", () => {
  fails(Buffer.from([0x22, 0xc3, 0x28, 0x22]), "null", "left: invalid UTF-8");
  fails("null", '{"secret":', "right: invalid JSON");
  fails("\ufeffnull", "null", "left: invalid JSON");
  fails("", "null", "left: invalid JSON");
  fails('{"bad":[1e400]}', '{"bad":[1e400]}', "left: nonfinite number");
  fails("{}", '{"added":-1e400}', "right: nonfinite number");
  fails("9007199254740992", "9007199254740993", "left: unsafe integer");
  fails("null", "-9007199254740992", "right: unsafe integer");
});

test("input bytes, depth and parsed value limits accept boundaries and reject excess", () => {
  const atBytes = "null" + " ".repeat(131072 - 4);
  assert.equal(run(atBytes, "null", 0).stdout, emptyReport);
  fails(atBytes + " ", "null", "left: input exceeds 131072 bytes");
  assert.throws(() => compareJson(Buffer.from("null"), Buffer.alloc(131073)), /right: input exceeds 131072 bytes/);
  const nested = depth => "[".repeat(depth) + "0" + "]".repeat(depth);
  assert.equal(run(nested(64), nested(64), 0).stdout, emptyReport);
  fails("null", nested(65), "right: depth exceeds 64");
  const atValues = JSON.stringify(Array(9999).fill(0));
  assert.equal(run(atValues, atValues, 0).stdout, emptyReport);
  fails(JSON.stringify(Array(10000).fill(0)), "null", "left: value count exceeds 10000");
});

test("comparison budget includes equal paths and fails before publishing accumulated entries", () => {
  function document(prefix, count) {
    const value = { a: Array(9000).fill(0) };
    for (let i = 0; i < count; i++) value[prefix + i] = null;
    return JSON.stringify(value);
  }
  const left = document("l", 499);
  const atLimit = JSON.parse(run(left, document("r", 499), 1).stdout);
  assert.equal(atLimit.added.length, 499);
  assert.equal(atLimit.removed.length, 499);
  assert.deepEqual(atLimit.changed, []);
  fails(left, document("r", 500), "comparison count exceeds 10000");
});

test("complete report byte budget includes UTF-8 values, framing and newline", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ added: [], removed: [], changed: [
    { path: [], before: "", after: "" },
  ] }) + "\n");
  const leftText = "é".repeat(65520);
  const left = JSON.stringify(leftText);
  const rightText = "x".repeat(262144 - overhead - Buffer.byteLength(leftText));
  const report = run(left, JSON.stringify(rightText), 1).stdout;
  assert.equal(Buffer.byteLength(report), 262144);
  assert.deepEqual(JSON.parse(report).changed, [
    { path: [], before: leftText, after: rightText },
  ]);
  fails(left, JSON.stringify(rightText + "x"), "report exceeds 262144 bytes");
});

test("usage, file reads and stdout alias errors are visible and preserve inputs", () => {
  const usage = execute([]);
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.equal(usage.stderr, "json-diff: usage: node json-diff.js LEFT.json RIGHT.json\n");
  const input = fixtures("null", "false");
  const missing = execute([input.paths[0], path.join(scratch, "missing.json")]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "json-diff: right: cannot read file (ENOENT)\n");
  const directory = execute([scratch, input.paths[1]]);
  assert.equal(directory.status, 2);
  assert.equal(directory.stdout, "");
  assert.match(directory.stderr, /left: (input must be a regular file|cannot read file \(EISDIR\))/);
  const output = fs.openSync(input.paths[1], "a");
  try {
    const alias = execute(input.paths, { stdio: ["ignore", output, "pipe"] });
    assert.equal(alias.status, 2);
    assert.equal(alias.stderr, "json-diff: stdout: aliases an input file\n");
  } finally { fs.closeSync(output); }
  input.unchanged();
});

test("stderr diagnostics preserve inputs across early failures", t => {
  t.diagnostic("fixtures: " + scratch);
  const large = "null" + " ".repeat(131069);
  const cases = [
    { text: ["{", "null"], sink: 0, error: "left: invalid JSON" },
    { text: ["null", "{"], sink: 1, error: "right: invalid JSON" },
    { text: [large, "null"], sink: 0, error: "left: input exceeds 131072 bytes" },
    { text: [large, "null"], sink: 1, link: true, error: "left: input exceeds 131072 bytes" },
    { text: ["null", "null"], sink: 0, missing: 1, error: "right: cannot read file (ENOENT)" },
    { text: ["null", "null"], sink: 1, missing: 0, error: "left: cannot read file (ENOENT)" },
  ];
  for (const item of cases) {
    const input = fixtures(...item.text);
    const args = [...input.paths];
    if (item.missing !== undefined) args[item.missing] = path.join(scratch, `missing-${sequence}.json`);
    const control = execute(args);
    assert.equal(control.status, 2);
    assert.equal(control.stdout, "");
    assert.equal(control.stderr, `json-diff: ${item.error}\n`);
    input.unchanged();
    const sink = item.link ? path.join(scratch, `stderr-link-${sequence}`) : input.paths[item.sink];
    if (item.link) fs.linkSync(input.paths[item.sink], sink);
    const fd = fs.openSync(sink, "a");
    try {
      const alias = execute(args, { stdio: ["ignore", "pipe", fd] });
      assert.equal(alias.status, 2);
      assert.equal(alias.stdout, "");
      input.paths.forEach((file, i) => assert.equal(
        fs.readFileSync(file).equals(Buffer.from(item.text[i])), true, `${item.error}: stderr alias modified input ${i}`));
    } finally { fs.closeSync(fd); }
  }

  // A normal file sink must still receive diagnostics; a read-only one must not throw.
  const invalid = fixtures("{", "null");
  const log = path.join(scratch, "independent-stderr");
  for (const mode of ["wx", "r"]) {
    const fd = fs.openSync(log, mode);
    try {
      const result = execute(invalid.paths, { stdio: ["ignore", "pipe", fd] });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
    } finally { fs.closeSync(fd); }
    assert.equal(fs.readFileSync(log, "utf8"), "json-diff: left: invalid JSON\n");
    invalid.unchanged();
  }

  // A stdout-alias error must not be written back through aliased stderr either.
  const valid = fixtures("null", "false");
  const fd = fs.openSync(valid.paths[0], "a");
  try {
    assert.equal(execute(valid.paths, { stdio: ["ignore", fd, fd] }).status, 2);
    valid.unchanged();
  } finally { fs.closeSync(fd); }
});

test("POSIX FIFO rejection and Linux write failure", { skip: process.platform === "win32" }, t => {
  const input = fixtures("null", "false");
  const fifo = path.join(scratch, "fifo");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5000 });
  assert.ifError(created.error);
  assert.equal(created.status, 0, created.stderr);
  const result = execute([fifo, input.paths[1]]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "json-diff: left: input must be a regular file\n");
  if (fs.existsSync("/dev/full")) {
    const full = fs.openSync("/dev/full", "w");
    try {
      const failed = execute(input.paths, { stdio: ["ignore", full, "pipe"] });
      assert.equal(failed.status, 2);
      assert.equal(failed.stderr, "json-diff: stdout: cannot write (ENOSPC)\n");
    } finally { fs.closeSync(full); }
  } else {
    t.diagnostic("/dev/full unavailable: write-failure check not run");
  }
  input.unchanged();
});
