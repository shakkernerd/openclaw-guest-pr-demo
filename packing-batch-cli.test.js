"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const cli = join(__dirname, "packing-batch-cli.js");
const inputBytes = Buffer.from(' \r\n[ { "count": 3, "id": " box " }, { "id": "α", "count": 1 }, { "id": "zero", "count": 0 } ]\r\n');
const expected = [
  '{',
  '  "parcels": [',
  '    {',
  '      "id": " box ",',
  '      "count": 3,',
  '      "label": "3 items"',
  '    },',
  '    {',
  '      "id": "α",',
  '      "count": 1,',
  '      "label": "1 item"',
  '    },',
  '    {',
  '      "id": "zero",',
  '      "count": 0,',
  '      "label": "0 items"',
  '    }',
  '  ],',
  '  "parcelCount": 3,',
  '  "totalItemCount": 4',
  '}',
  '',
].join("\n");

function run(args = [], input = "", options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input, encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "packing-batch-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function assertRejected(result, diagnostic) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, diagnostic);
}

test("file input produces exact deterministic JSON without rewriting input bytes", (t) => {
  const file = join(temporaryDirectory(t), "packing batch.json");
  writeFileSync(file, inputBytes);
  for (let attempt = 0; attempt < 2; attempt++) {
    // A supplied path takes precedence over unrelated stdin.
    const result = run([file], "not JSON");
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
    assert.deepEqual(readFileSync(file), inputBytes);
  }
});

test("implicit and explicit stdin produce the same exact result as file input", () => {
  for (const args of [[], ["-"]]) {
    const result = run(args, inputBytes);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  }
});

test("empty batches succeed, while empty input is malformed", () => {
  const result = run([], "[]");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, '{\n  "parcels": [],\n  "parcelCount": 0,\n  "totalItemCount": 0\n}\n');
  assertRejected(run([], ""), /packing-batch: malformed JSON input/);
});

test("malformed JSON, trailing data, a BOM and invalid UTF-8 are rejected", () => {
  const inputs = [
    "[", '[{"id":"a","count":1},]', "[] true", "\ufeff[]",
    Buffer.concat([Buffer.from('[{"id":"'), Buffer.from([0xff]), Buffer.from('","count":1}]')]),
  ];
  for (const input of inputs) {
    assertRejected(run([], input), /packing-batch: malformed JSON input \(expected UTF-8\):/);
  }
});

test("invalid batches never emit a success prefix, even when the last record fails", () => {
  const cases = [
    ["{}", /batch must be a JSON array/],
    ['[{"id":"a","count":1},{"id":"b","count":-1}]', /parcels\[1\]\.count/],
    ['[{"id":"a","count":1},{"id":"a","count":2}]', /parcels\[1\]\.id duplicates/],
    ['[{"id":" ","count":1}]', /\.id must be a nonempty, non-whitespace string/],
    ['[{"id":"a","count":"1"}]', /\.count must be a nonnegative safe integer/],
    ['[{"id":"a","count":9007199254740992}]', /\.count must be a nonnegative safe integer/],
    ['[{"id":"a","count":1e400}]', /\.count must be a nonnegative safe integer/],
    ['[{"id":"a","count":1,"extra":true}]', /exactly id and count/],
    ['[{"id":"a","count":9007199254740991},{"id":"b","count":1}]', /totalItemCount exceed Number.MAX_SAFE_INTEGER/],
  ];
  for (const [input, diagnostic] of cases) {
    const result = run([], input);
    assertRejected(result, /packing-batch: invalid batch:/);
    assert.match(result.stderr, diagnostic);
  }
});

test("invalid file input also preserves the original bytes", (t) => {
  const file = join(temporaryDirectory(t), "invalid.json");
  for (const input of [Buffer.from("[\r\n"), Buffer.from('[{"id":"a","count":-1}]\r\n')]) {
    writeFileSync(file, input);
    assertRejected(run([file]), /packing-batch: (malformed JSON input|invalid batch):?/);
    assert.deepEqual(readFileSync(file), input);
  }
});

test("reports file-read and usage failures with nonzero status and empty stdout", (t) => {
  const missing = join(temporaryDirectory(t), "missing.json");
  assertRejected(run([missing]), /packing-batch: cannot read .*missing\.json.*: ENOENT/);
  assertRejected(run(["a.json", "b.json"], "[]"), /packing-batch: usage: node packing-batch-cli\.js \[input\.json\|-\]/);
});

test("reports a real stdin read failure", { skip: process.platform === "win32" && "directory descriptors require POSIX" }, (t) => {
  const fd = openSync(temporaryDirectory(t), "r");
  try {
    assertRejected(run([], undefined, { input: undefined, stdio: [fd, "pipe", "pipe"] }), /packing-batch: cannot read stdin: EISDIR/);
  } finally {
    closeSync(fd);
  }
});

test("writes a complete result larger than a pipe buffer and preserves the safe total", () => {
  const records = Array.from({ length: 3000 }, (_, index) => ({ id: "p" + index, count: index === 0 ? Number.MAX_SAFE_INTEGER : 0 }));
  const result = run([], JSON.stringify(records));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.ok(Buffer.byteLength(result.stdout) > 65536);
  assert.deepEqual(JSON.parse(result.stdout), {
    parcels: records.map((record) => ({ ...record, label: record.count + " items" })),
    parcelCount: records.length,
    totalItemCount: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(result.stdout.endsWith("\n"));
});

test("a full output device is a reported failure, not success", { skip: process.platform !== "linux" && "/dev/full requires Linux" }, () => {
  const fd = openSync("/dev/full", "w");
  try {
    const result = run([], "[]", { stdio: ["pipe", fd, "pipe"] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packing-batch: cannot write stdout: ENOSPC/);
  } finally {
    closeSync(fd);
  }
});

test("a reader closing after partial output causes nonzero exit and an I/O diagnostic", { timeout: 10000 }, async () => {
  const records = Array.from({ length: 5000 }, (_, index) => ({ id: "p" + index + "x".repeat(256), count: 1 }));
  const child = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
  const completed = once(child, "close");
  let stderr = "";
  let receivedBytes = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.once("data", (chunk) => {
    receivedBytes += chunk.length;
    child.stdout.destroy();
  });
  child.stdin.end(JSON.stringify(records));
  const [code, signal] = await completed;
  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.ok(receivedBytes > 0);
  assert.match(stderr, /packing-batch: cannot write stdout: EPIPE/);
});
