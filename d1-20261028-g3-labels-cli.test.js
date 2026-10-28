"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const cliPath = join(__dirname, "d1-20261028-g3-labels-cli.js");

function runCli(input, args = [], cwd = __dirname) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    input,
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function inputFile(t, content, name = "counts.json") {
  const directory = mkdtempSync(join(__dirname, ".d1-20261028-g3-cli-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, name);
  writeFileSync(filename, content, "utf8");
  return filename;
}

async function runCliWithOpenStdin(t, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  // Deliberately leave the stdin pipe open: these modes must not wait for EOF.
  const [status, signal] = await once(child, "close");
  assert.equal(signal, null);
  return { status, stdout, stderr };
}

function assertHelp(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Usage: node d1-20261028-g3-labels-cli\.js \[--help\|-h\] \[input\.json\]\n/);
  assert.match(result.stdout, /nonnegative safe integers from a file or stdin/);
  assert.match(result.stdout, /Omit input\.json to read stdin/);
  assert.match(result.stdout, /Saved file: node d1-20261028-g3-labels-cli\.js counts\.json/);
  assert.match(result.stdout, /-h, --help/);
  assert.match(result.stdout, /Example:\nnode d1-20261028-g3-labels-cli\.js <<'JSON'\n\[0,1,3\]\nJSON\n$/);
}

for (const flag of ["--help", "-h"]) {
  test(`labels CLI prints help for ${flag} with empty stdin`, () => {
    assertHelp(runCli("", [flag]));
  });

  test(`labels CLI ignores valid and malformed stdin with ${flag}`, () => {
    for (const input of ["[0,1,3]", "not JSON"]) {
      assertHelp(runCli(input, [flag]));
    }
  });

  test(`labels CLI exits for ${flag} without waiting for stdin to close`, async (t) => {
    assertHelp(await runCliWithOpenStdin(t, [flag]));
  });

  test(`labels CLI honors ${flag} before opening a missing file`, async (t) => {
    const missing = `${inputFile(t, "[]")}.missing`;
    assertHelp(await runCliWithOpenStdin(t, [flag, missing]));
    assertHelp(runCli("not JSON", [missing, flag]));
  });
}

test("labels CLI treats help flags inside JSON as invalid counts, not options", () => {
  for (const flag of ["--help", "-h"]) {
    const result = runCli(JSON.stringify([0, flag]));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "labels: counts[1] must be a finite integer number\n");
  }
});

const validCases = [
  ["ordinary counts", "[0,1,3]", "0 items\n1 item\n3 items\n"],
  ["an empty array", "[]", ""],
  ["whitespace around JSON", " \t\r\n [1, 0] \r\n\t", "1 item\n0 items\n"],
  ["the maximum safe integer", "[9007199254740991]", "9007199254740991 items\n"],
  ["negative zero", "[-0]", "0 items\n"],
];

for (const [name, input, expectedStdout] of validCases) {
  test(`labels CLI accepts ${name}`, () => {
    const result = runCli(input);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, expectedStdout);
    assert.equal(result.stderr, "");
  });

  test(`labels CLI accepts ${name} from a file and ignores stdin`, (t) => {
    const result = runCli("not JSON", [inputFile(t, input)]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, expectedStdout);
    assert.equal(result.stderr, "");
  });
}

const jsonError = "invalid JSON; expected an array of nonnegative safe integers";
const arrayError = "counts must be an array";
const typeError = "counts[1] must be a finite integer number";
const rangeError = "counts[1] must be a nonnegative safe integer";
const invalidCases = [
  ["empty input", "", jsonError],
  ["malformed JSON", "[0,1,", jsonError],
  ["multiple JSON values", "[0] [1]", jsonError],
  ["a scalar number", "1", arrayError],
  ["a scalar string", '"1"', arrayError],
  ["JSON null", "null", arrayError],
  ["a JSON object", '{"count":1}', arrayError],
  ["a string in a mixed batch", '[0,"1",2]', typeError],
  ["null in a mixed batch", "[0,null,2]", typeError],
  ["a boolean in a mixed batch", "[0,true,2]", typeError],
  ["a fractional count", "[0,1.5,2]", typeError],
  ["a JSON number that overflows to infinity", "[0,1e309,2]", typeError],
  ["a negative integer", "[0,-1,2]", rangeError],
  ["an unsafe integer", "[0,9007199254740992,2]", rangeError],
];

for (const [name, input, expectedError] of invalidCases) {
  test(`labels CLI rejects ${name} with stderr only and exit code 1`, () => {
    const result = runCli(input);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `labels: ${expectedError}\n`);
  });

  test(`labels CLI rejects ${name} in a file without falling back to stdin`, (t) => {
    const result = runCli("[1]", [inputFile(t, input)]);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `labels: ${expectedError}\n`);
  });
}

test("labels CLI writes no partial stdout when the last count is invalid", () => {
  const counts = [...Array(1000).fill(1), -1];
  const result = runCli(JSON.stringify(counts));

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "labels: counts[1000] must be a nonnegative safe integer\n");
});

test("labels CLI writes no partial stdout for a file with a late invalid count", (t) => {
  const counts = [...Array(1000).fill(1), -1];
  const result = runCli("[1]", [inputFile(t, JSON.stringify(counts))]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "labels: counts[1000] must be a nonnegative safe integer\n");
});

test("labels CLI reads a relative filename containing spaces", (t) => {
  const filename = inputFile(t, "[1,3]", "parcel counts.json");
  const result = runCli("not JSON", ["parcel counts.json"], dirname(filename));

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "1 item\n3 items\n");
  assert.equal(result.stderr, "");
});

test("labels CLI reads a file without waiting for stdin to close", async (t) => {
  const result = await runCliWithOpenStdin(t, [inputFile(t, "[1]")]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "1 item\n");
  assert.equal(result.stderr, "");
});

test("labels CLI reports a missing file without falling back to stdin", (t) => {
  const missing = `${inputFile(t, "[]")}.missing`;
  const result = runCli("[1]", [missing]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `labels: cannot read input file ${JSON.stringify(missing)}: file not found\n`);
});

test("labels CLI reports a directory instead of a readable input file", (t) => {
  const directory = dirname(inputFile(t, "[]"));
  const result = runCli("[1]", [directory]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `labels: cannot read input file ${JSON.stringify(directory)}: path is a directory\n`);
});

test("labels CLI reports permission denied for an unreadable file", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("POSIX read permissions require a non-root process");
    return;
  }
  // Mounted worktrees may ignore mode bits; use the OS temporary filesystem.
  const directory = mkdtempSync(join(tmpdir(), "d1-20261028-g3-permission-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "counts.json");
  writeFileSync(filename, "[1]", "utf8");
  chmodSync(filename, 0o000);
  let result;
  try {
    result = runCli("[1]", [filename]);
  } finally {
    chmodSync(filename, 0o600);
  }

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `labels: cannot read input file ${JSON.stringify(filename)}: permission denied\n`);
});

test("labels CLI rejects more than one filename", (t) => {
  const filename = inputFile(t, "[1]");
  const result = runCli("[1]", [filename, filename]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "labels: expected at most one input filename; use --help for usage\n");
});
