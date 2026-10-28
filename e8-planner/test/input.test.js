"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, encodeCsv } = require("../csv.js");
const { parseTime, readVolunteers, readShifts } = require("../input.js");

const VH = "name,skills,available_from,available_to,max_hours\n";
const SH = "id,starts_at,ends_at,skill,people_needed\n";
const V = ["Alice", "electronics;textiles", "2026-10-31T09:00:00+00:00", "2026-10-31T14:00:00+00:00", "3.5"];
const S = ["repair", "2026-10-31T09:00:00+00:00", "2026-10-31T10:00:00+00:00", "electronics", "2"];
const change = (row, index, value) => row.map((v, i) => i === index ? value : v);

test("CSV handles BOM, CRLF, quotes, commas, blank lines, and missing final newline", () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n\r\n"Chen, Mei","a ""quote"""'), [
    { cells: ["a", "b"], line: 1 }, { cells: ["Chen, Mei", 'a "quote"'], line: 3 },
  ]);
  assert.deepEqual(parseCsv('"multi\r\nline",x\r\ny,z\r\n'), [
    { cells: ["multi\nline", "x"], line: 1 }, { cells: ["y", "z"], line: 3 },
  ]);
  assert.deepEqual(parseCsv('a,b,\n"",,\n').map((r) => r.cells), [["a", "b", ""], ["", "", ""]]);
});

test("CSV encoder round trips special characters", () => {
  const rows = [["name", "notes"], ['Chen, "Mei"', "two\nlines"], ["é", ""]];
  assert.deepEqual(parseCsv(encodeCsv(rows)).map((row) => row.cells), rows);
});

for (const csv of ['a"b,c', '"unclosed', '"closed"x,b', '"closed" ,b', 'a,b\rc,d']) {
  test("CSV rejects malformed quoting/line endings: " + JSON.stringify(csv), () => {
    assert.throws(() => parseCsv(csv, "bad.csv"), /bad\.csv:\d+:/);
  });
}

test("schema permits reordered headers, trims fields, and accepts zero hours", () => {
  const result = readVolunteers("max_hours,available_to,skills,name,available_from\n0," + V[3] + ", electronics ; textiles , Alice ," + V[2]);
  assert.equal(result[0].name, "Alice");
  assert.equal(result[0].maxMs, 0);
  assert.deepEqual(result[0].skills, ["electronics", "textiles"]);
  assert.deepEqual(readVolunteers(VH), []);
  assert.deepEqual(readShifts(SH), []);
});

for (const header of ["", "\n\n", "name,skills\n", VH.replace("name", "skills"), VH.replace("max_hours", "surprise"), VH.trim() + ",extra\n"]) {
  test("reject missing/duplicate/unknown headers: " + JSON.stringify(header), () => {
    assert.throws(() => readVolunteers(header), /header/);
  });
}

test("raw headers reject quoted newlines and tabs before trimming", () => {
  assert.throws(() => readVolunteers(VH.replace("name", '"name\n"')), /volunteers\.csv:1: header contains control characters/);
  assert.throws(() => readVolunteers(VH.replace("name", "name\t")), /header contains control characters/);
  assert.throws(() => readShifts(SH.replace("id", '"id\r\n"')), /shifts\.csv:1: header contains control characters/);
});

test("diagnostics include file and physical row; missing or surplus cells fail", () => {
  assert.throws(() => readVolunteers(VH + "\nAlice,electronics\n", "team.csv"), /team\.csv:3: expected 5 columns; got 2/);
  assert.throws(() => readShifts(SH + S.join(",") + ",extra"), /expected 5 columns; got 6/);
  assert.throws(() => readVolunteers(VH + encodeCsv([change(V, 0, "")])), /name is required/);
  assert.throws(() => readVolunteers(VH + encodeCsv([change(V, 0, "Alice\nSmith")])), /control characters/);
  assert.throws(() => readVolunteers(VH + encodeCsv([change(V, 0, "Alice\u001b[31m")])), /control characters/);
});

test("names and shift IDs must be unique; skills must be a nonempty unique list", () => {
  assert.throws(() => readVolunteers(VH + encodeCsv([V, change(V, 0, " Alice ")])), /duplicate name/);
  assert.throws(() => readShifts(SH + encodeCsv([S, S])), /duplicate id/);
  for (const skill of ["electronics;", ";electronics", "electronics;;textiles", "electronics;electronics"]) {
    assert.throws(() => readVolunteers(VH + encodeCsv([change(V, 1, skill)])), /skills must/);
  }
  assert.throws(() => readShifts(SH + encodeCsv([change(S, 3, "electronics;textiles")])), /single skill/);
});

for (const value of ["-1", "NaN", "Infinity", "1e2", "1.0001", ".5", "1.", "9007199254740991"]) {
  test("reject invalid max_hours " + value, () => {
    assert.throws(() => readVolunteers(VH + encodeCsv([change(V, 4, value)])), /max_hours/);
  });
}

for (const value of ["0", "-1", "1.5", "1e2", "NaN", "9007199254740992"]) {
  test("reject invalid people_needed " + value, () => {
    assert.throws(() => readShifts(SH + encodeCsv([change(S, 4, value)])), /people_needed/);
  });
}

test("reject unsafe combined slot total without allocating a huge array", () => {
  assert.throws(() => readShifts(SH + encodeCsv([
    change(S, 4, "9007199254740991"), change(S, 0, "second"),
  ])), /total people_needed/);
});

test("ISO timestamps compare absolute instants with exact millisecond precision", () => {
  assert.equal(parseTime("2026-10-31T10:00+01:00"), parseTime("2026-10-31T09:00:00Z"));
  assert.equal(parseTime("2026-10-31T05:30-03:30"), parseTime("2026-10-31T09:00Z"));
  assert.equal(parseTime("2024-02-29T00:00:00.001Z") + 1, parseTime("2024-02-29T00:00:00.002Z"));
  assert.equal(parseTime("2026-10-25T02:00+00:00") - parseTime("2026-10-25T01:00+01:00"), 2 * 3600000);
  assert.ok(Number.isFinite(parseTime("0001-01-01T00:00Z")));
  assert.ok(Number.isFinite(parseTime("2026-10-31T00:00+14:00")));
});

for (const value of [
  "2026-10-31", "2026-10-31T09:00", "2026-10-31 09:00Z", "2026-10-31T09:00+0000",
  "2026-02-29T09:00Z", "1900-02-29T09:00Z", "2026-04-31T09:00Z", "2026-00-01T09:00Z",
  "2026-13-01T09:00Z", "2026-10-00T09:00Z", "0000-01-01T00:00Z", "2026-10-31T24:00Z",
  "2026-10-31T09:60Z", "2026-10-31T09:00:60Z", "2026-10-31T09:00:00.0001Z",
  "2026-10-31T09:00+14:01", "2026-10-31T09:00-15:00", "2026-10-31T09:00+01:60",
  "2026-10-31T09:00-00:00",
]) {
  test("reject invalid or ambiguous time " + value, () => {
    assert.throws(() => parseTime(value, "timestamp"), /invalid ISO time with explicit offset/);
  });
}

test("reject zero/reversed ranges using actual instants, not wall clocks", () => {
  assert.throws(() => readVolunteers(VH + encodeCsv([change(V, 3, V[2])])), /available_to must be after/);
  assert.throws(() => readShifts(SH + encodeCsv([change(S, 2, "2026-10-31T08:00Z")])), /ends_at must be after/);
  assert.throws(() => readShifts(SH + encodeCsv([change(S, 2, "2026-10-31T10:00+02:00")])), /ends_at must be after/);
});
