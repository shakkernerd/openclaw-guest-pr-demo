"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Synthetic saved reports plus one saved-capture reader regression; never run the producer.
const observation = (stream, frame, record) => ({ stream, frame, record });
const summary = mode => ({ mode, maxItemsPerBox: 4, totalItems: 2, boxCount: 1,
  fullBoxes: 0, partialBoxes: 1, unusedItemSlots: "2" });
function report() {
  return {
    observed: {
      stdout: { frames: 1, accepted: 1, fragments: 0, readError: null },
      stderr: { frames: 1, accepted: 1, fragments: 0, readError: null },
      summaries: 1, rejections: 0, completions: 1, fatals: 0,
    },
    rows: [{ line: 7, outcomes: [observation("stdout", 1,
      { line: 7, mixed: summary("mixed"), "single-sku": summary("single-sku") })] }],
    terminalEvents: [observation("stderr", 1, { version: 1, type: "complete", exitCode: 0 })],
    issues: [],
    limits: ["Saved limit: do not infer pairing or process result.", "Keep this second limit distinct."],
  };
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function save(dir, value, name = "report.json") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
function cli(args, options = {}) {
  const run = spawnSync(process.execPath, [path.join(__dirname, "render-batch-report.js"), ...args], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], ...options,
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  return run;
}
function html(args, options) {
  const run = cli(args, options);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  return run.stdout;
}
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const articles = html => [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(match => match[1]);

test("actual CLI: deterministic standalone HTML, copied summaries, limits and untouched input", t => {
  const input = report();
  input.rows[0].outcomes[0].record.mixed.unusedItemSlots = "99999999999999999999999999";
  input.rows[0].outcomes[0].record.mixed.boxCount = 0; // No arithmetic repair.
  const file = save(directory(t), input);
  const before = fs.readFileSync(file);
  const output = html([file]);
  assert.equal(html([file]), output);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.match(output, /^<!doctype html>\n<html lang="en">/);
  assert.match(output, /<meta name="viewport"/);
  assert.match(output, /@media print/);
  assert.match(output, /@page/);
  assert.doesNotMatch(output, /<(?:script|link|img|iframe|object|embed|form)\b/i);
  assert.match(output, /default-src 'none'/);
  assert.match(output, /99999999999999999999999999/);
  assert.match(output, /Input line 7/);
  assert.match(output, /stdout · frame 1/);
  assert.match(output, /stderr · frame 1/);
  assert.match(output, /<dt>exitCode<\/dt><dd><span class="value">0<\/span>/);
  assert.match(output, /captured completion \(including exitCode 0\) is not an observed process exit/);
  assert.match(output, /No reader issues were recorded. This is not proof/);
  for (const limit of input.limits) assert.ok(output.includes('<li>' + escape(limit) + '</li>'));
});

test("raw warning text from the real reader preserves bare CR as a JSON string", t => {
  const dir = directory(t);
  const stdout = path.join(dir, "stdout.capture");
  const stderr = path.join(dir, "diagnostics.capture");
  const capture = Buffer.from([0x41, 0x0d, 0x42, 0x0a]); // A, bare CR, B, LF.
  const diagnostics = '{"version":1,"type":"complete","exitCode":0}\n';
  fs.writeFileSync(stdout, capture);
  fs.writeFileSync(stderr, diagnostics);
  const reader = spawnSync(process.execPath, [path.join(__dirname, "read-batch-captures.js"), stdout, stderr], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ifError(reader.error);
  assert.equal(reader.signal, null);
  assert.equal(reader.status, 0, reader.stderr);
  assert.equal(reader.stderr, "");
  const saved = path.join(dir, "reader-report.json");
  fs.writeFileSync(saved, reader.stdout); // Use the actual unchanged reader output.
  const input = JSON.parse(reader.stdout);
  assert.deepEqual(input.issues, [{ code: "malformed-json", stream: "stdout", frame: 1, text: "A\rB" }]);
  const output = html([saved]);
  assert.ok(output.includes('<dt>text (JSON string)</dt><dd><pre>&quot;A\\rB&quot;</pre></dd>'));
  assert.ok(!output.includes("A\rB"), "no literal CR in raw warning HTML");
  assert.ok(output.includes('<dt>code</dt><dd><span class="value">malformed-json</span></dd>'));
  assert.ok(output.includes('<dt>type</dt><dd><span class="value">complete</span></dd>'));
  assert.deepEqual(fs.readFileSync(stdout), capture);
  assert.equal(fs.readFileSync(stderr, "utf8"), diagnostics);
  assert.equal(fs.readFileSync(saved, "utf8"), reader.stdout);
});

test("multiple reports and repeated paths remain separate, ordered, with local warnings", t => {
  const dir = directory(t);
  const first = report();
  first.issues = [{ code: "first-only", stream: "stdout", frame: 2, text: "first text" }];
  const second = report();
  second.issues = [{ code: "second-only", stream: "stderr", error: "ENOENT" }];
  second.observed.stderr.readError = "ENOENT";
  const paths = [save(dir, first, "first.json"), save(dir, second, "second.json")];
  const sections = articles(html([...paths, paths[0]]));
  assert.equal(sections.length, 3);
  assert.match(sections[0], /first-only/);
  assert.doesNotMatch(sections[0], /second-only/);
  assert.match(sections[1], /second-only/);
  assert.doesNotMatch(sections[1], /first-only/);
  assert.match(sections[1], /ENOENT/);
  assert.match(sections[2], /first-only/);
  assert.ok(sections[0].includes(escape(paths[0])));
  assert.ok(sections[1].includes(escape(paths[1])));
});

test("duplicates, conflicts, overlap and all terminal records retain identity and details", t => {
  const input = report();
  const original = input.rows[0].outcomes[0];
  const changed = structuredClone(original);
  changed.frame = 2;
  changed.record.mixed.totalItems = 99;
  input.rows[0].outcomes.push(changed, observation("stderr", 3,
    { version: 1, type: "record-error", line: 7, message: "  rejection\n Ω  " }));
  input.terminalEvents.push(observation("stderr", 4,
    { version: 1, type: "complete", exitCode: 1 }), observation("stderr", 5,
    { version: 1, type: "fatal-error", operation: "write-diagnostics", code: "EIO" }));
  input.issues = [
    { code: "conflicting-outcomes", stream: "stdout", frame: 2, line: 7 },
    { code: "overlapping-outcomes", stream: "stderr", frame: 3, previous: { stream: "stdout", frame: 1 } },
    { code: "summary-disagreement", stream: "stdout", frame: 2, field: "totalItems" },
    { code: "incomplete-fragment", stream: "stdout", frame: 3, text: "{tail\n  " },
    { code: "fatal-observed", stream: "stderr", frame: 5 },
  ];
  const output = html([save(directory(t), input)]);
  assert.equal((output.match(/class="observation"/g) || []).length, 6);
  assert.equal((output.match(/class="issue"/g) || []).length, 5);
  assert.match(output, /Observation 2 · stdout · frame 2/);
  assert.match(output, /Observation 3 · stderr · frame 3/);
  assert.ok(output.includes("  rejection\n Ω  "));
  assert.ok(output.includes('<dt>text (JSON string)</dt><dd><pre>' +
    escape(JSON.stringify(input.issues[3].text)) + '</pre></dd>'));
  assert.ok(output.includes(escape(JSON.stringify(input.issues[1].previous, null, 2))));
  assert.match(output, /write-diagnostics/);
  assert.ok(output.indexOf('class="value">complete') < output.indexOf('class="value">fatal-error'));
  for (const issue of input.issues) assert.ok(output.includes(escape(issue.code)));
});

test("all text surfaces are escaped, including filenames, keys, nested details and limits", t => {
  const attack = '</style><script>alert("x")</script><img src=x onerror="alert(1)">&\' Ω';
  const input = report();
  input.observed.stdout.readError = attack;
  input.rows[0].outcomes[0].record.mixed[attack] = attack;
  input.rows[0].outcomes[0].record[attack] = { [attack]: attack };
  input.rows[0].outcomes.push(observation("stderr", 2, { message: attack }));
  input.terminalEvents[0].record.type = attack;
  input.issues = [{ code: attack, stream: "stdout", text: attack, previous: { [attack]: attack } }];
  input.limits = [attack];
  const file = save(directory(t), input, '<img onerror="x">&\'.json');
  const output = html([file]);
  assert.ok(output.includes(escape(file)));
  assert.ok(output.includes('<dt>' + escape(attack) + '</dt>'));
  assert.ok(output.includes('<li>' + escape(attack) + '</li>'));
  assert.ok(output.includes(escape(JSON.stringify({ [attack]: attack }, null, 2))));
  assert.doesNotMatch(output, /<(?:script|img)\b/i);
  assert.equal((output.match(/<\/style>/g) || []).length, 1);
  assert.ok(!output.includes(attack));
});

test("empty evidence and missing limits never become a success claim", t => {
  const input = report();
  input.rows = [];
  input.terminalEvents = [];
  input.limits = [];
  input.issues = [{ code: "missing-completion", stream: "stderr" }];
  const output = html([save(directory(t), input)]);
  assert.match(output, /No input-line observations supplied/);
  assert.match(output, /No terminal observations supplied/);
  assert.match(output, /No limits were supplied/);
  assert.match(output, /No process-result verdict/);
  assert.match(output, /missing-completion/);
});

test("misuse exits 2 without output; explicit dash-leading path works", t => {
  for (const args of [[], ["-"], ["--help"], [""], ["absent", "--flag"]]) {
    const run = cli(args);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /^Usage: node examples\/render-batch-report\.js/);
  }
  const cwd = directory(t);
  save(cwd, report(), "-report.json");
  assert.match(html(["./-report.json"], { cwd }), /Batch capture handoff/);
});

test("unreadable, invalid JSON and unsupported shape fail before any HTML, even after valid inputs", t => {
  const dir = directory(t);
  const good = save(dir, report());
  const missing = cli([good, path.join(dir, "absent")]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /input 2: cannot read \(ENOENT\)/);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{unsafe raw text");
  const invalid = cli([good, bad]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "render-batch-report: input 2: invalid JSON\n");
  const shapes = [null, [], {}, { ...report(), extra: "not silently lost" }];
  for (const mutate of [r => delete r.observed.stdout, r => r.rows[0].outcomes[0].frame = 0,
    r => r.rows[0].outcomes[0].record = null, r => r.issues.push(null), r => r.limits = [5],
    r => r.observed.summaries = -1, r => r.rows[0].extra = true]) {
    const input = report(); mutate(input); shapes.push(input);
  }
  for (const input of shapes) {
    const run = cli([good, save(dir, input, "shape.json")]);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "render-batch-report: input 2: unsupported report shape\n");
  }
});

const descriptorCheck = { skip: process.platform !== "linux" || !fs.existsSync("/dev/full")
  ? "requires Linux /dev/full" : false };
test("real output and usage write failures return 1; unavailable diagnostics remain best effort", descriptorCheck, t => {
  const file = save(directory(t), report());
  const fd = fs.openSync("/dev/full", "w");
  try {
    const output = cli([file], { stdio: ["ignore", fd, "pipe"] });
    assert.equal(output.status, 1);
    assert.equal(output.stdout, null);
    assert.equal(output.stderr, "render-batch-report: cannot write HTML (ENOSPC)\n");
    const usage = cli([], { stdio: ["ignore", "pipe", fd] });
    assert.equal(usage.status, 1);
    assert.equal(usage.stdout, "");
    const both = cli([file], { stdio: ["ignore", fd, fd] });
    assert.equal(both.status, 1);
  } finally { fs.closeSync(fd); }
});
