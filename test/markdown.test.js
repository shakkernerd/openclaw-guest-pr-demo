"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createBrief, renderBrief } = require("../lib/review-handoff.js");
const root = path.join(__dirname, "..");
const s = fs.readFileSync(path.join(root, "examples/inputs/review-selection-dispatch-evidence.json"));
const r = fs.readFileSync(path.join(root, "examples/inputs/comparison.json"));
const appendixHeading = "## Reference appendix — complete selected facts and provenance";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => Buffer.from(JSON.stringify(value));
const tick = String.fromCharCode(96);
function literal(value) {
  const json = JSON.stringify(value);
  const runs = json.match(new RegExp(tick + "+", "g")) ?? [];
  const delimiter = tick.repeat(runs.reduce((n, run) => Math.max(n, run.length + 1), 1));
  return delimiter + " " + json + " " + delimiter;
}
function sections(md) {
  const index = md.indexOf(appendixHeading);
  assert.ok(index > 0);
  return [md.slice(0, index), md.slice(index)];
}
function blocks(md) {
  const result = []; const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^~{3,}json$/.test(lines[i])) continue;
    const fence = lines[i].slice(0, -4); const json = [];
    while (++i < lines.length && lines[i] !== fence) json.push(lines[i]);
    assert.ok(i < lines.length); result.push(JSON.parse(json.join("\n")));
  }
  return result;
}
function pair(selection, report) {
  const bytes = encode(report);
  selection.comparison.bytes = bytes.length;
  selection.comparison.sha256 = hash(bytes);
  return [encode(selection), bytes];
}

test("skim header leads with exact label, IDs, scope and review-only meaning, not JSON blocks", () => {
  const [top] = sections(renderBrief(s, r));
  assert.ok(top.startsWith("# " + literal("Dispatch evidence follow-up") + "\n"));
  const header = top.slice(0, top.indexOf("\n## "));
  for (const text of [literal("MAR-014"), literal("MAR-015"), "**Outside requested scope:** 8 records.", "Review request only", "Unselected records imply no approval"]) assert.ok(header.includes(text), text);
  assert.equal(top.includes("~~~json"), false);
  assert.doesNotMatch(top, /MAR-DUP|datasetSha256|sourceSha256/);
  assert.ok(top.indexOf("MAR-014") < top.indexOf("MAR-015"));
});

test("skim comparisons preserve status/notes and report changes with compact physical references", () => {
  const [top] = sections(renderBrief(s, r));
  const report = JSON.parse(r);
  for (const side of ["current", "incoming"]) {
    const facts = report.records[3][side];
    assert.ok(top.includes("**" + (side === "current" ? "Current" : "Incoming") + ":** status " + literal(facts.status) + "; note " + literal(facts.note)));
  }
  for (const change of report.records[3].changes) assert.ok(top.includes(literal(change.path)));
  assert.ok(top.includes(literal(report.records[3].changes[1].current) + " → " + literal(report.records[3].changes[1].incoming)));
  for (const [filename, occurrence, line] of [["march-sales-export.csv", "original:15", 15], ["revised-march-sales-export.csv", "revised:15", 15], ["march-sales-export.csv", "original:16", 16]]) {
    assert.ok(top.includes(literal(filename) + " · occurrence " + literal(occurrence) + " · physical line(s) " + literal(line)));
  }
  const missing = top.slice(top.indexOf("## " + literal("MAR-015")));
  assert.ok(missing.includes("status " + literal("Needs review") + "; note " + literal("")));
  assert.match(missing, /\*\*Incoming: ABSENT\*\*/);
  assert.ok(missing.includes("snapshot is " + literal(null)));
  assert.match(missing, /Not a deletion or approval/);
  assert.match(missing, /No field-level changes listed/);
  assert.match(missing, /Incoming: absent snapshot; no source references on this side/);
});

test("appendix retains every selected record and original purpose/identity/provenance value", () => {
  const brief = createBrief(s, r);
  const [, appendix] = sections(renderBrief(s, r));
  const data = blocks(appendix);
  assert.deepEqual(data[0], { purpose: brief.purpose, reviewContext: brief.reviewContext, createdAtLocalClock: brief.createdAtLocalClock, selectionMeaning: brief.selectionMeaning });
  assert.deepEqual(data[1], brief.comparison);
  assert.deepEqual(data.slice(2, -1), brief.records);
  assert.deepEqual(data.at(-1), { sharedHistory: brief.sharedHistory, authentication: brief.authentication, notices: brief.notices, reportContext: brief.reportContext });
});

test("empty selection stays useful with purpose, zero requested, all outside and identity", () => {
  const selection = JSON.parse(s); selection.selectedCount = 0; selection.selectedRecords = [];
  const bytes = encode(selection); const [top, appendix] = sections(renderBrief(bytes, r));
  assert.ok(top.startsWith("# " + literal(selection.reviewContext.purposeLabel)));
  assert.match(top, /Selected records \(0\).*none/);
  assert.match(top, /Outside requested scope:\*\* 10 records/);
  assert.match(top, /No records selected for review/);
  assert.match(top, /does not mean the comparison has no differences/);
  assert.doesNotMatch(top, /MAR-014|MAR-015|Reported changes/);
  assert.deepEqual(blocks(appendix)[1], selection.comparison);
  assert.equal(blocks(appendix).length, 3);
  selection.reviewContext.purposeLabel = "";
  assert.ok(renderBrief(encode(selection), r).startsWith("# " + literal("")));
  delete selection.reviewContext;
  assert.match(renderBrief(encode(selection), r), /Purpose label: not supplied/);
});

test("hostile text and exact whitespace remain literal, with full facts recoverable", () => {
  const selection = JSON.parse(s); const report = JSON.parse(r);
  const attack = "  Ω e\u0301 " + tick.repeat(4) + "\n# not a heading\n~~~~~\n<img src=x> [link](https://example.invalid) | \\\"  ";
  selection.reviewContext.purposeLabel = attack;
  const record = report.records[4];
  record.current.orderId = attack;
  record.current.note = attack;
  record.current.sourceEvidence[0].filename = attack;
  record.current.sourceEvidence[0].occurrenceKey = "";
  record.current.sourceEvidence[0].line = 0;
  record.current.sourceEvidence[0].endLine = 2;
  const [selectedBytes, reportBytes] = pair(selection, report);
  const [top, appendix] = sections(renderBrief(selectedBytes, reportBytes));
  assert.ok(top.includes(literal(attack)));
  assert.doesNotMatch(top, /^# not a heading|^~~~~~|^<img/m);
  assert.ok(top.includes("occurrence " + literal("") + " · physical line(s) " + literal(0) + "–" + literal(2)));
  assert.deepEqual(blocks(appendix)[3].reportRecord, record);
  assert.equal(blocks(appendix)[0].reviewContext.purposeLabel, attack);
});

test("side-specific references do not collapse differences or invent absent metadata", () => {
  const selection = JSON.parse(s); const report = JSON.parse(r);
  report.records[3].incoming.sourceEvidence[0].endLine = 17;
  delete report.records[4].current.sourceEvidence[0].line;
  report.records[4].current.sourceEvidence[0].endLine = null;
  const bytes = pair(selection, report);
  const [top] = sections(renderBrief(...bytes));
  assert.ok(top.includes("Incoming: " + literal("march-sales-export.csv") + " · occurrence " + literal("original:15") + " · physical line(s) " + literal(15) + "–" + literal(17)));
  assert.ok(top.includes("physical line(s) not supplied–" + literal(null)));
});

test("actual CLI creates revised Markdown and identical JSON; empty Markdown also works", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-presentation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selectionPath = path.join(root, "examples/inputs/review-selection-dispatch-evidence.json");
  const comparisonPath = path.join(root, "examples/inputs/comparison.json");
  const cli = path.join(root, "bin/review-handoff.js");
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000 });
  const base = ["--selection", selectionPath, "--comparison", comparisonPath];
  const out = path.join(dir, "skim.md");
  let result = run([...base, "--format", "markdown", "--output", out]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
  assert.equal(fs.readFileSync(out, "utf8"), renderBrief(s, r));
  result = run([...base, "--format", "json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Buffer.from(result.stdout), fs.readFileSync(path.join(root, "examples/generated/dispatch-brief.json")));
  const empty = JSON.parse(s); empty.selectedCount = 0; empty.selectedRecords = [];
  const emptyPath = path.join(dir, "empty-selection.json"); fs.writeFileSync(emptyPath, JSON.stringify(empty));
  result = run(["--selection", emptyPath, "--comparison", comparisonPath, "--format", "markdown"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No records selected for review/);
  assert.ok(result.stdout.includes(empty.comparison.sha256));
  assert.deepEqual(fs.readFileSync(selectionPath), s); assert.deepEqual(fs.readFileSync(comparisonPath), r);
});
