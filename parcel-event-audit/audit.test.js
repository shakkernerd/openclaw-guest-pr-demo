"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { auditExports, auditFiles, InputError } = require("./index.js");

const cli = path.join(__dirname, "cli.js");
const fixtures = name => path.join(__dirname, "examples", name);
const event = (overrides = {}) => ({
  eventId: "event-1", parcelId: "parcel-1", type: "created",
  occurredAt: "2026-10-28T08:00:00Z", ...overrides,
});
const source = (filename, events) => ({ filename, text: events.map(value => JSON.stringify(value)).join("\n") });
const audit = events => auditExports([source("input.jsonl", events)]);
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000, ...options });
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "parcel-event-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("sorts parcels and out-of-order timelines; preserves distinct IDs", () => {
  const report = audit([
    event({ eventId: "late", type: "delivered", occurredAt: "2026-10-28T10:00:00Z" }),
    event({ eventId: "z" }), event({ eventId: "a" }),
    event({ eventId: "other", parcelId: "A" }),
  ]);
  assert.deepEqual(report.parcels.map(value => value.parcelId), ["A", "parcel-1"]);
  assert.deepEqual(report.parcels[1].timeline.map(value => value.eventId), ["a", "z", "late"]);
  assert.deepEqual(report.parcels[1].terminalEvidence, ["delivered"]);
  assert.equal(report.summary.retryDuplicates, 0);
  assert.equal(report.summary.exceptions, 0);
});

test("coalesces equivalent timestamps and key order, retaining every original source", () => {
  const input = [
    source("z.jsonl", [event(), event()]),
    { filename: "a.jsonl", text: '{"occurredAt":"2026-10-28T09:00:00.000+01:00","type":"created","parcelId":"parcel-1","eventId":"event-1"}\r\n' },
  ];
  const before = structuredClone(input);
  const report = auditExports(input);
  assert.deepEqual(input, before);
  assert.deepEqual(report.summary, {
    inputRecords: 3, uniqueEvents: 1, retryDuplicates: 2, parcels: 1,
    conflictingEventIds: 0, contradictoryParcels: 0, exceptions: 0,
  });
  assert.deepEqual(report.parcels[0].timeline[0].sources, [
    { filename: "a.jsonl", line: 1, occurredAt: "2026-10-28T09:00:00.000+01:00" },
    { filename: "z.jsonl", line: 1, occurredAt: "2026-10-28T08:00:00Z" },
    { filename: "z.jsonl", line: 2, occurredAt: "2026-10-28T08:00:00Z" },
  ]);
  assert.equal(report.parcels[0].timeline[0].occurredAt, "2026-10-28T08:00:00.000Z");
  assert.deepEqual(auditExports(input.toReversed()), report);
});

for (const [name, change] of [
  ["parcel", { parcelId: "parcel-2" }],
  ["type", { type: "in_transit" }],
  ["instant", { occurredAt: "2026-10-28T08:00:00.001Z" }],
]) {
  test(`conflicting ID with a different ${name} retains every variant and retry`, () => {
    const report = audit([event(), event(change), event(change)]);
    assert.equal(report.summary.conflictingEventIds, 1);
    assert.equal(report.summary.uniqueEvents, 2);
    assert.equal(report.summary.retryDuplicates, 1);
    assert.equal(report.exceptions[0].code, "EVENT_ID_CONFLICT");
    assert.equal(report.exceptions[0].variants.length, 2);
    assert.deepEqual(report.exceptions[0].variants.map(value => value.sources.length).sort(), [1, 2]);
    assert.ok(report.parcels.flatMap(value => value.timeline).every(value => value.conflictingEventId));
  });
}

for (const sameId of [false, true]) {
  for (const cancelTime of ["07:00:00", "08:00:00", "09:00:00"]) {
    test(`delivery and cancellation are contradictory (${sameId ? "same" : "distinct"} ID, ${cancelTime})`, () => {
      const report = audit([event({ type: "delivered" }), event({
        eventId: sameId ? "event-1" : "event-2", type: "cancelled",
        occurredAt: `2026-10-28T${cancelTime}Z`,
      })]);
      assert.equal(report.summary.contradictoryParcels, 1);
      assert.equal(report.summary.conflictingEventIds, sameId ? 1 : 0);
      assert.equal(report.summary.exceptions, sameId ? 2 : 1);
      assert.deepEqual(report.parcels[0].terminalEvidence, ["delivered", "cancelled"]);
      const contradiction = report.exceptions.at(-1);
      assert.equal(contradiction.code, "DELIVERY_CANCELLATION_CONTRADICTION");
      assert.equal(contradiction.delivered[0].sources[0].line, 1);
      assert.equal(contradiction.cancelled[0].sources[0].line, 2);
      assert.ok(!Object.hasOwn(report.parcels[0], "status"));
    });
  }
}

test("terminal events on different parcels are not a contradiction", () => {
  const report = audit([event({ type: "delivered" }), event({
    eventId: "event-2", parcelId: "parcel-2", type: "cancelled",
  })]);
  assert.equal(report.summary.exceptions, 0);
});

test("all file-order permutations yield byte-identical reports including ties and exceptions", () => {
  const sources = [
    source("z", [event({ eventId: "__proto__", parcelId: "constructor", type: "cancelled" })]),
    source("a", [event({ eventId: "__proto__", parcelId: "constructor", type: "delivered" })]),
    source("b", [event(), event({ parcelId: "Z" }), event()]),
  ];
  const expected = JSON.stringify(auditExports(sources));
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.equal(JSON.stringify(auditExports(order.map(index => sources[index]))), expected);
  }
});

test("record reorder changes only physical provenance, not reconciled evidence", () => {
  const events = [event(), event({ type: "delivered" }), event({ type: "cancelled" }), event()];
  const withoutSources = report => JSON.parse(JSON.stringify(report, (key, value) => key === "sources" ? undefined : value));
  assert.deepEqual(withoutSources(audit(events)), withoutSources(audit(events.toReversed())));
});

test("UTC calendar crossings, leap years, fractions, and early years are exact", () => {
  for (const [input, expected] of [
    ["2024-03-01T00:30:00+01:00", "2024-02-29T23:30:00.000Z"],
    ["2000-02-29T23:30:00-01:00", "2000-03-01T00:30:00.000Z"],
    ["2026-10-28T08:00:00.1Z", "2026-10-28T08:00:00.100Z"],
    ["2026-10-28T08:00:00.12+00:00", "2026-10-28T08:00:00.120Z"],
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
  ]) assert.equal(audit([event({ occurredAt: input })]).parcels[0].timeline[0].occurredAt, expected);
});

for (const value of [
  "2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
  "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z",
  "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z",
  "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+00:60",
  "2026-01-01T00:00:00-00:00", "2026-01-01T00:00:00", "2026-01-01",
  "2026-01-01t00:00:00z", "2026-01-01T00:00:00.1234Z", "2026-01-01T00:00:00Z junk",
  "0000-01-01T00:00:00Z", "0001-01-01T00:00:00+01:00", "9999-12-31T23:00:00-02:00", 123,
]) {
  test(`rejects unsupported timestamp ${JSON.stringify(value)} with source and line`, () => {
    assert.throws(() => audit([event(), event({ occurredAt: value })]), error => {
      assert.ok(error instanceof InputError);
      assert.equal(error.filename, "input.jsonl");
      assert.equal(error.line, 2);
      assert.match(error.message, /occurredAt/);
      return true;
    });
  });
}

for (const [name, invalid] of [
  ["null", null], ["array", []], ["string", "event"], ["missing fields", {}],
  ["unknown field", event({ note: "not silently ignored" })],
  ["unknown type", event({ type: "DELIVERED" })], ["numeric ID", event({ eventId: 42 })],
  ["empty ID", event({ eventId: "" })], ["padded ID", event({ parcelId: " parcel" })],
  ["control character", event({ parcelId: "a\nb" })],
  ["unpaired surrogate", event({ eventId: "\ud800" })],
]) {
  test(`rejects invalid schema: ${name}`, () => {
    assert.throws(() => audit([invalid]), InputError);
  });
}

test("rejects malformed JSON, blank lines, BOM, and repeated or escaped member names", () => {
  const normal = JSON.stringify(event());
  for (const text of [
    "{", normal + " trailing", normal + normal, "\n", normal + "\n\n", "\ufeff" + normal,
    normal.replace('{', '{"eventId":"overwritten",'),
    normal.replace('{', String.raw`{"event\u0049d":"overwritten",`),
  ]) {
    assert.throws(() => auditExports([{ filename: "bad.jsonl", text }]), InputError);
  }
  // The string value contains escaped quotes and a colon, not another member.
  assert.equal(audit([event({ eventId: 'literal \"eventId\": text' })]).summary.uniqueEvents, 1);
});

test("empty exports are valid; LF/CRLF and an optional final newline preserve line numbers", () => {
  assert.deepEqual(auditExports([{ filename: "empty", text: "" }]).summary, {
    inputRecords: 0, uniqueEvents: 0, retryDuplicates: 0, parcels: 0,
    conflictingEventIds: 0, contradictoryParcels: 0, exceptions: 0,
  });
  const normal = JSON.stringify(event());
  for (const ending of ["", "\n", "\r\n"]) {
    const report = auditExports([{ filename: "lines", text: ` ${normal} \r\n${normal}${ending}` }]);
    assert.deepEqual(report.parcels[0].timeline[0].sources.map(value => value.line), [1, 2]);
  }
});

test("validates API arguments without mutating them or silently recounting sources", async () => {
  for (const value of [undefined, null, [], {}, [null], [{ filename: "", text: "" }]]) {
    assert.throws(() => auditExports(value), TypeError);
  }
  assert.throws(() => auditExports([{ filename: "a", text: 1 }]), TypeError);
  assert.throws(() => auditExports([{ filename: "a", text: "" }, { filename: "a", text: "" }]), InputError);
  await assert.rejects(auditFiles([]), TypeError);
  await assert.rejects(auditFiles(["a", "a"]), InputError);
});

test("real fixtures reconcile identically via both APIs and remain byte-for-byte unchanged", async () => {
  const paths = [fixtures("export-a.jsonl"), fixtures("export-b.jsonl")];
  const before = await Promise.all(paths.map(filename => readFile(filename)));
  const report = await auditFiles(paths);
  assert.deepEqual(report.summary, {
    inputRecords: 6, uniqueEvents: 5, retryDuplicates: 1, parcels: 2,
    conflictingEventIds: 1, contradictoryParcels: 1, exceptions: 2,
  });
  assert.deepEqual(report, auditExports(paths.map((filename, i) => ({ filename, text: before[i].toString("utf8") }))));
  assert.deepEqual(await auditFiles(paths.toReversed()), report);
  assert.deepEqual(await Promise.all(paths.map(filename => readFile(filename))), before);
});

test("file API diagnoses missing files, directories, malformed text, and invalid UTF-8", async t => {
  const dir = await temporary(t);
  await assert.rejects(auditFiles([path.join(dir, "absent")]), error => error instanceof InputError && error.line === null && error.reason === "ENOENT");
  await assert.rejects(auditFiles([dir]), /regular file/);
  await assert.rejects(auditFiles([fixtures("malformed.jsonl")]), error => error instanceof InputError && error.line === 2);
  const invalid = path.join(dir, "invalid-utf8.jsonl");
  await writeFile(invalid, Buffer.concat([Buffer.from(JSON.stringify(event()) + "\n"), Buffer.from([0xff])]));
  await assert.rejects(auditFiles([invalid]), error => error instanceof InputError && error.line === 2 && error.reason === "invalid UTF-8");
  const bom = path.join(dir, "bom.jsonl");
  await writeFile(bom, "\ufeff" + JSON.stringify(event()));
  await assert.rejects(auditFiles([bom]), /invalid JSON/);
});

test("CLI emits deterministic reports with status 0 for clean and 1 for exceptions", () => {
  const a = fixtures("export-a.jsonl");
  const b = fixtures("export-b.jsonl");
  const clean = run([a]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stderr, "");
  assert.equal(JSON.parse(clean.stdout).summary.exceptions, 0);
  const mixed = run([a, b]);
  assert.equal(mixed.status, 1, mixed.stderr);
  assert.equal(mixed.stderr, "");
  assert.equal(JSON.parse(mixed.stdout).summary.exceptions, 2);
  assert.equal(run([b, a]).stdout, mixed.stdout);
});

test("CLI reports are byte-identical across host timezones and locales", () => {
  const args = [fixtures("export-a.jsonl"), fixtures("export-b.jsonl")];
  const environments = [
    { TZ: "UTC", LANG: "C" },
    { TZ: "America/New_York", LANG: "en_US.UTF-8" },
    { TZ: "Asia/Kolkata", LANG: "tr_TR.UTF-8" },
  ];
  const results = environments.map(env => run(args, { env: { ...process.env, ...env } }));
  for (const result of results) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, results[0].stdout);
  }
});

test("CLI rejects invalid usage or any invalid file with status 2 and no partial JSON", () => {
  for (const args of [[], ["--wat"], ["--"], [fixtures("missing.jsonl")],
    [fixtures("export-a.jsonl"), fixtures("malformed.jsonl")],
    [fixtures("export-a.jsonl"), fixtures("export-a.jsonl")]]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^parcel-event-audit: /);
    assert.doesNotMatch(result.stderr, /at main/);
  }
  assert.match(run([fixtures("malformed.jsonl")]).stderr, /malformed\.jsonl":2: occurredAt/);
});

test("CLI supports help and literal leading-dash filenames, without rewriting inputs", async t => {
  for (const flag of ["-h", "--help"]) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage:/);
    assert.equal(result.stderr, "");
  }
  const dir = await temporary(t);
  const file = path.join(dir, "-events.jsonl");
  const bytes = Buffer.from(JSON.stringify(event()) + "\n");
  await writeFile(file, bytes);
  const result = run(["--", "-events.jsonl"], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).parcels[0].timeline[0].sources[0].filename, "-events.jsonl");
  assert.deepEqual(await readFile(file), bytes);
});

test("imports do not execute the CLI or write stdout", () => {
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(cli)}); require(${JSON.stringify(__dirname)});`], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("CLI diagnoses a broken stdout pipe with exit 2, without a stack trace", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [cli, fixtures("export-a.jsonl")], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 2, stderr);
  assert.match(stderr, /^parcel-event-audit: stdout: EPIPE\n$/);
});

test("read-only file API rejects special devices", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(auditFiles(["/dev/null"]), error => error instanceof InputError && error.line === null && /regular file/.test(error.reason));
});
