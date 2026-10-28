"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFile, writeFile, mkdtemp, rm } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { auditExports, auditFiles, InputError } = require("./index.js");

const fixture = name => path.join(__dirname, "examples", name);
const cli = path.join(__dirname, "cli.js");
const options = Object.freeze({ exceptionsOnly: true });
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000 });

test("mixed exceptions-only view keeps global totals, all evidence and complete affected timelines", async () => {
  const filename = fixture("mixed.jsonl");
  const before = await readFile(filename);
  const sources = Object.freeze([Object.freeze({ filename, text: before.toString("utf8") })]);
  const full = auditExports(sources);
  const filtered = auditExports(sources, options);
  assert.equal(filtered.view, "exceptions-only");
  assert.deepEqual(filtered.summary, {
    inputRecords: 11, uniqueEvents: 9, retryDuplicates: 2, parcels: 5,
    conflictingEventIds: 1, contradictoryParcels: 1, exceptions: 2,
  });
  assert.deepEqual(filtered.summary, full.summary);
  assert.deepEqual(filtered.exceptions, full.exceptions);
  assert.deepEqual(filtered.parcels.map(parcel => parcel.parcelId), ["TERMINAL", "X-LEFT", "X-RIGHT"]);
  assert.deepEqual(filtered.parcels, full.parcels.filter(parcel => !["CLEAN", "RETRY-ONLY"].includes(parcel.parcelId)));
  const left = filtered.parcels.find(parcel => parcel.parcelId === "X-LEFT");
  assert.deepEqual(left.timeline.map(event => event.eventId), ["left-created", "shared-id"]);
  assert.deepEqual(left.timeline[0].sources.map(source => source.line), [6, 8]);
  assert.equal(left.timeline[0].conflictingEventId, false);
  const conflict = filtered.exceptions.find(exception => exception.code === "EVENT_ID_CONFLICT");
  assert.deepEqual(conflict.variants.map(event => event.parcelId), ["X-LEFT", "X-RIGHT"]);
  assert.deepEqual(await auditFiles([filename], options), filtered);
  assert.deepEqual(await readFile(filename), before);
  assert.deepEqual(options, { exceptionsOnly: true });
});

test("default report shape and bytes remain unchanged; explicit false means full", async () => {
  const files = [fixture("mixed.jsonl")];
  const full = await auditFiles(files);
  assert.deepEqual(Object.keys(full), ["schemaVersion", "summary", "parcels", "exceptions"]);
  assert.equal(full.schemaVersion, 1);
  assert.equal(full.parcels.length, 5);
  assert.deepEqual(await auditFiles(files, {}), full);
  assert.deepEqual(await auditFiles(files, { exceptionsOnly: false }), full);
  const sources = [{ filename: files[0], text: await readFile(files[0], "utf8") }];
  assert.deepEqual(auditExports(sources), full);
  assert.deepEqual(auditExports(sources, { exceptionsOnly: false }), full);
  const result = run(files);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${JSON.stringify(full, null, 2)}\n`);
});

test("clean parcels and benign retries alone are omitted, but their totals remain", () => {
  const event = { eventId: "retry", parcelId: "clean", type: "created", occurredAt: "2026-10-28T08:00:00Z" };
  const sources = [{ filename: "clean.jsonl", text: `${JSON.stringify(event)}\n${JSON.stringify(event)}\n` }];
  const report = auditExports(sources, options);
  assert.equal(report.view, "exceptions-only");
  assert.deepEqual(report.parcels, []);
  assert.deepEqual(report.exceptions, []);
  assert.deepEqual(report.summary, {
    inputRecords: 2, uniqueEvents: 1, retryDuplicates: 1, parcels: 1,
    conflictingEventIds: 0, contradictoryParcels: 0, exceptions: 0,
  });
  const empty = auditExports([{ filename: "empty", text: "" }], options);
  assert.equal(empty.view, "exceptions-only");
  assert.equal(empty.summary.parcels, 0);
  assert.deepEqual(empty.parcels, []);
});

test("filtered reports are deterministic across multiple file orders in both APIs and CLI", async () => {
  const files = [fixture("export-a.jsonl"), fixture("export-b.jsonl"), fixture("mixed.jsonl")];
  const bytes = await Promise.all(files.map(file => readFile(file)));
  const sources = files.map((filename, index) => ({ filename, text: bytes[index].toString("utf8") }));
  const expected = auditExports(sources, options);
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const filenames = order.map(index => files[index]);
    assert.deepEqual(auditExports(order.map(index => sources[index]), options), expected);
    assert.deepEqual(await auditFiles(filenames, options), expected);
    const result = run(["--exceptions-only", ...filenames]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
  }
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), bytes);
});

test("malformed records on otherwise clean parcels cannot disappear through filtering", async t => {
  const clean = { eventId: "clean", parcelId: "CLEAN", type: "created", occurredAt: "2026-10-28T08:00:00Z" };
  const text = `${JSON.stringify(clean)}\n${JSON.stringify({ ...clean, eventId: "bad", occurredAt: "2026-02-30T00:00:00Z" })}\n`;
  const filename = "z-clean-but-malformed.jsonl";
  const mixedFile = fixture("mixed.jsonl");
  const mixed = { filename: mixedFile, text: await readFile(mixedFile, "utf8") };
  for (const sources of [[{ filename, text }], [mixed, { filename, text }]]) {
    assert.throws(() => auditExports(sources, options), error =>
      error instanceof InputError && error.filename === filename && error.line === 2);
  }
  const directory = await mkdtemp(path.join(tmpdir(), "parcel-audit-invalid-view-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, bytes] of [
    ["bad-date.jsonl", Buffer.from(text)],
    ["bad-utf8.jsonl", Buffer.concat([Buffer.from(JSON.stringify(clean) + "\n"), Buffer.from([0xff])])],
    ["bad-json.jsonl", Buffer.from(JSON.stringify(clean) + "\n{\n")],
  ]) {
    const file = path.join(directory, name);
    await writeFile(file, bytes);
    await assert.rejects(auditFiles([mixedFile, file], options), error =>
      error instanceof InputError && error.filename === file && error.line === 2);
    const result = run(["--exceptions-only", mixedFile, file]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(`${JSON.stringify(file)}:2:`), result.stderr);
    assert.deepEqual(await readFile(file), bytes);
  }
});

test("both APIs reject invalid options rather than silently selecting the wrong view", async () => {
  const sources = [{ filename: "empty", text: "" }];
  for (const invalid of [null, true, "exceptions-only", [], { exceptionsOnly: "true" }, { exceptionsOnly: 1 }, { exceptionsOnly: undefined }, { exceptionOnly: true }]) {
    assert.throws(() => auditExports(sources, invalid), TypeError);
    await assert.rejects(auditFiles([fixture("mixed.jsonl")], invalid), TypeError);
  }
});

test("CLI flag, help, exit status and literal filenames follow the documented view contract", async t => {
  const filename = fixture("mixed.jsonl");
  for (const args of [["--exceptions-only", filename], [filename, "--exceptions-only"], ["--exceptions-only", "--exceptions-only", filename]]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), await auditFiles([filename], options));
  }
  const clean = run(["--exceptions-only", fixture("export-a.jsonl")]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).view, "exceptions-only");
  assert.deepEqual(JSON.parse(clean.stdout).parcels, []);
  assert.equal(JSON.parse(clean.stdout).summary.parcels, 2);
  assert.match(run(["--help"]).stdout, /--exceptions-only/);
  for (const args of [["--exceptions-only"], ["--exceptions-only=true", filename], ["--exceptions-only", "--help"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "parcel-audit-flag-name-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await readFile(filename);
  const literalFile = path.join(directory, "--exceptions-only");
  await writeFile(literalFile, bytes);
  const result = spawnSync(process.execPath, [cli, "--", "--exceptions-only"], { cwd: directory, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(!Object.hasOwn(JSON.parse(result.stdout), "view"));
  assert.deepEqual(await readFile(literalFile), bytes);
});
