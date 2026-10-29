"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const command = join(__dirname, "format-address-drafts.js");
// Exact supplied interchange bytes, represented as escaped UTF-8 text literals.
// CRLF layout, the encoding BOM and literal FEFF are data, never normalized.
const identities = [
  ["bom-valid.json", 35, "37d514bd87afbdaedfaba61cf8d81a6aac45605ea3a3fe21abdc897b233fc235",
    '\ufeff[\r\n  "\ufeffinside",\r\n  "  Ω  "\r\n]'],
  ["valid-crlf-layout.json", 87, "5c116139575fe8012f62e582dc97fa4a42a5ef912b5981a39efbcc0f41551e95",
    '[\r\n  "  De\u0301pôt Ω 🧭  ",\r\n  "Floor A\\nFloor B",\r\n  "",\r\n  "  De\u0301pôt Ω 🧭  "\r\n]'],
  ["empty.json", 2, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "[]"],
  ["cr-value.json", 21, "75556616c7215f10fe879b75ed67e4f67d6bb76f77bf549480788e603a1bc870",
    '["Keep", "CR\\rValue"]'],
];

function run(files, t) {
  const fixtures = mkdtempSync(join(tmpdir(), "format-address-drafts-"));
  try {
    const materialized = [];
    const before = identities.map(([file, size, hash, text]) => {
      writeFileSync(join(fixtures, file), Buffer.from(text, "utf8"));
      const bytes = readFileSync(join(fixtures, file));
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(bytes.length, size);
      assert.equal(actualHash, hash);
      materialized.push({ file, bytes: bytes.length, sha256: actualHash });
      return bytes;
    });
    t.diagnostic("Materialized immutable input identities: " + JSON.stringify(materialized));
    const entries = readdirSync(fixtures);
    const result = spawnSync(process.execPath, [command, ...files], {
      cwd: fixtures,
      encoding: "utf8",
      // Even usable stdin must not become an implicit input file.
      input: '["Not an argv file"]',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.deepEqual(readdirSync(fixtures), entries);
    identities.forEach(([file], index) => {
      assert.deepEqual(readFileSync(join(fixtures, file)), before[index]);
    });
    return result;
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
}

function assertReport(actual, expected, exitCode) {
  assert.equal(actual.status, exitCode);
  assert.equal(actual.stderr, "");
  assert.deepEqual(JSON.parse(actual.stdout), expected);
  // Exactly one complete document and one literal trailing LF, no extra output.
  assert.ok(actual.stdout.endsWith("\n"));
  assert.equal(actual.stdout.split("\n").length, 2);
}

test("all-success batch preserves supplied spellings and duplicate occurrences", (t) => {
  assertReport(run(["./bom-valid.json", "bom-valid.json", "bom-valid.json"], t), {
    total: 3, succeeded: 3, failed: 0,
    results: [
      { position: 1, file: "./bom-valid.json", ok: true, formatted: "\ufeffinside\n  Ω  " },
      { position: 2, file: "bom-valid.json", ok: true, formatted: "\ufeffinside\n  Ω  " },
      { position: 3, file: "bom-valid.json", ok: true, formatted: "\ufeffinside\n  Ω  " },
    ],
  }, 0);
});

test("mixed batch keeps read, decode and format failures in order and continues", (t) => {
  assertReport(run([
    "bom-valid.json", "valid-crlf-layout.json", "not-present-address-draft.json",
    "cr-value.json", "empty.json", "bom-valid.json",
  ], t), {
    total: 6, succeeded: 2, failed: 4,
    results: [
      { position: 1, file: "bom-valid.json", ok: true, formatted: "\ufeffinside\n  Ω  " },
      { position: 2, file: "valid-crlf-layout.json", ok: false, error: {
        stage: "format", name: "RangeError", message: "lines[1] must not contain line breaks",
      } },
      { position: 3, file: "not-present-address-draft.json", ok: false, error: {
        stage: "read", name: "Error",
        message: "ENOENT: no such file or directory, open 'not-present-address-draft.json'",
      } },
      { position: 4, file: "cr-value.json", ok: false, error: {
        stage: "decode", name: "RangeError",
        message: "draft[1] contains CR; textareas cannot preserve CR",
      } },
      { position: 5, file: "empty.json", ok: false, error: {
        stage: "format", name: "RangeError", message: "lines must not be empty",
      } },
      { position: 6, file: "bom-valid.json", ok: true, formatted: "\ufeffinside\n  Ω  " },
    ],
  }, 1);
});

test("no arguments prints usage only to stderr and ignores stdin", (t) => {
  const actual = run([], t);
  assert.equal(actual.status, 2);
  assert.equal(actual.stdout, "");
  assert.equal(actual.stderr, "Usage: node format-address-drafts.js FILE...\n");
});

test("a report larger than a pipe buffer is not truncated at exit", (t) => {
  const files = Array(1024).fill("bom-valid.json");
  const actual = run(files, t);
  assert.ok(Buffer.byteLength(actual.stdout) > 65536);
  assertReport(actual, {
    total: 1024, succeeded: 1024, failed: 0,
    results: files.map((file, index) => ({
      position: index + 1, file, ok: true, formatted: "\ufeffinside\n  Ω  ",
    })),
  }, 0);
});
