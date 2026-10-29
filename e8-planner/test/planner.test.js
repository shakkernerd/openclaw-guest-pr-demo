"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readVolunteers, readShifts, HOUR_MS } = require("../input.js");
const { allocate, assignmentsCsv, report } = require("../planner.js");
const base = Date.parse("2026-10-31T09:00Z");
const at = (hour) => base + hour * HOUR_MS;
const volunteer = (name, extra = {}) => ({ name, skills: ["repair"], from: at(0), to: at(8), maxMs: 8 * HOUR_MS, ...extra });
const shift = (id, start, end, extra = {}) => ({ id, start: at(start), end: at(end),
  startsAt: new Date(at(start)).toISOString(), endsAt: new Date(at(end)).toISOString(), skill: "repair", needed: 1, ...extra });

function assertSafe(plan) {
  for (const v of plan.volunteers) {
    let used = 0;
    const ids = new Set();
    for (const s of v.assigned) {
      assert.ok(v.skills.includes(s.skill), "required skill");
      assert.ok(s.start >= v.from && s.end <= v.to, "whole shift inside availability");
      assert.ok(!ids.has(s.id), "one person per slot");
      ids.add(s.id);
      used += s.end - s.start;
    }
    assert.equal(v.usedMs, used);
    assert.ok(used <= v.maxMs, "hour limit");
    for (let i = 0; i < v.assigned.length; i++) {
      for (let j = i + 1; j < v.assigned.length; j++) {
        const a = v.assigned[i], b = v.assigned[j];
        assert.ok(a.end <= b.start || b.end <= a.start, "no overlapping shifts");
      }
    }
  }
  for (const row of plan.coverage) {
    assert.equal(new Set(row.names).size, row.names.length);
    assert.equal(row.names.length + row.missing, row.shift.needed);
    assert.equal(plan.assignments.filter((a) => a.shift.id === row.shift.id).length, row.names.length);
    if (row.missing) assert.ok(row.reasons.every((r) => r.reasons.length > 0), "all candidates blocked at decision time");
  }
  assert.equal(plan.assignments.length + plan.uncovered, plan.totalSlots);
}

test("adjacent shifts are allowed, overlapping shifts are not; availability is inclusive at edges", () => {
  const plan = allocate([volunteer("A", { to: at(3) })], [
    shift("adjacent", 1, 2), shift("overlap", 0.5, 1.5), shift("first", 0, 1), shift("last", 2, 3),
    shift("too-early", -0.5, 0.5), shift("too-late", 3, 3.5),
  ]);
  assert.deepEqual(plan.assignments.map((a) => a.shift.id), ["first", "adjacent", "last"]);
  assert.match(report(plan), /overlaps first/);
  assert.match(report(plan), /outside availability/);
  assertSafe(plan);
});

test("fewest skills wins before hours, then least assigned time, then name", () => {
  const plan = allocate([
    volunteer("Zoe"), volunteer("Ben"), volunteer("Amy", { skills: ["repair", "intake"] }),
  ], [shift("a", 0, 1), shift("b", 1, 2), shift("c", 2, 3)]);
  assert.deepEqual(plan.assignments.map((a) => a.volunteer), ["Ben", "Zoe", "Ben"]);
  assertSafe(plan);
});

test("ties use end then ID, not source row order; one person cannot fill two slots", () => {
  const plan = allocate([volunteer("A")], [
    shift("long", 0, 2), shift("z", 0, 1), shift("a", 0, 1, { needed: 2 }),
  ]);
  assert.deepEqual(plan.coverage.map((c) => c.shift.id), ["a", "z", "long"]);
  assert.equal(plan.assignments.length, 1);
  assert.match(report(plan), /already assigned to this shift/);
  assertSafe(plan);
});

test("elapsed-time budget is exact for fractional hours and one-millisecond overrun", () => {
  const people = readVolunteers("name,skills,available_from,available_to,max_hours\nA,repair,2026-10-31T09:00Z,2026-10-31T12:00Z,1.001\n");
  const shifts = readShifts("id,starts_at,ends_at,skill,people_needed\n" +
    "fits,2026-10-31T10:00+01:00,2026-10-31T10:00:03.600Z,repair,1\n" +
    "over,2026-10-31T10:00:03.600Z,2026-10-31T10:00:03.601Z,repair,1\n");
  const plan = allocate(people, shifts);
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.volunteers[0].usedMs, plan.volunteers[0].maxMs);
  assert.match(report(plan), /max_hours exceeded/);
  assert.match(assignmentsCsv(plan), /2026-10-31T10:00\+01:00/);
  assertSafe(plan);
});

test("matching skill is required and zero-hour volunteers are valid but unavailable for work", () => {
  const plan = allocate([volunteer("A", { skills: ["Repair"] }), volunteer("B", { maxMs: 0 })], [shift("a", 0, 1)]);
  assert.equal(plan.uncovered, 1);
  assert.match(report(plan), /A: missing skill repair/);
  assert.match(report(plan), /B: max_hours exceeded/);
});

test("reports capture decision-time reasons even when later assignments change hours", () => {
  const plan = allocate([volunteer("A", { from: at(1), maxMs: HOUR_MS })], [shift("early", 0, 1), shift("later", 1, 2)]);
  assert.deepEqual(plan.coverage[0].reasons[0].reasons, ["outside availability"]);
  assert.equal(plan.volunteers[0].usedMs, HOUR_MS);
});

test("empty rosters and schedules produce honest header-only results", () => {
  const noPeople = allocate([], [shift("a", 0, 1)]);
  assert.equal(noPeople.uncovered, 1);
  assert.match(report(noPeople), /No volunteers supplied/);
  const empty = allocate([volunteer("A")], []);
  assert.match(report(empty), /Coverage: 0\/0/);
  assert.match(report(empty), /No shifts supplied/);
  assert.match(report(empty), /A: 0 \/ 8h \| no assignments/);
  assert.equal(assignmentsCsv(empty), "shift_id,volunteer,starts_at,ends_at,skill\n");
});

test("large demand counts do not cause one allocation loop per empty slot", () => {
  const plan = allocate([volunteer("A")], [shift("big", 0, 1, { needed: Number.MAX_SAFE_INTEGER })]);
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.uncovered, Number.MAX_SAFE_INTEGER - 1);
});

test("documented greedy limitation: it can miss a feasible complete plan", () => {
  const plan = allocate([
    volunteer("Alice", { maxMs: HOUR_MS }),
    volunteer("Ben", { to: at(1), maxMs: HOUR_MS }),
  ], [shift("early", 0, 1), shift("late", 1, 2)]);
  // Ben-early, Alice-late would fill both; this rule does not look ahead/backtrack.
  assert.deepEqual(plan.assignments.map((a) => a.volunteer), ["Alice"]);
  assert.equal(plan.uncovered, 1);
  assert.match(report(plan), /no backtracking or guarantee/);
});

test("Saturday sample is realistic, safe, stable, and matches inspectable generated outputs", () => {
  const root = path.join(__dirname, "..");
  const people = readVolunteers(fs.readFileSync(path.join(root, "sample/volunteers.csv"), "utf8"));
  const shifts = readShifts(fs.readFileSync(path.join(root, "sample/shifts.csv"), "utf8"));
  const before = JSON.stringify([people, shifts]);
  assert.equal(people.length, 8);
  assert.equal(shifts.length, 14);
  assert.ok(shifts.every((s) => new Date(s.start).getUTCDay() === 6));
  const plan = allocate(people, shifts);
  assert.equal(plan.assignments.length, 12);
  assert.equal(plan.totalSlots, 16);
  assert.equal(plan.uncovered, 4);
  assertSafe(plan);
  assert.equal(JSON.stringify([people, shifts]), before, "inputs unchanged");
  const reversed = allocate([...people].reverse(), [...shifts].reverse());
  assert.equal(assignmentsCsv(reversed), assignmentsCsv(plan));
  assert.equal(report(reversed), report(plan));
  assert.equal(assignmentsCsv(plan), fs.readFileSync(path.join(root, "sample-output/assignments.csv"), "utf8"));
  assert.equal(report(plan), fs.readFileSync(path.join(root, "sample-output/report.txt"), "utf8"));
});

test("100 seeded varied schedules always respect invariants and input-order independence", () => {
  let seed = 1808;
  const next = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 100; run++) {
    const people = Array.from({ length: 8 }, (_, i) => volunteer("V" + i, {
      from: at(next(4) / 2), to: at(4 + next(5) / 2), maxMs: next(9) * HOUR_MS / 2,
      skills: next(2) ? ["repair"] : ["repair", "intake"],
    }));
    const shifts = Array.from({ length: 15 }, (_, i) => {
      const start = next(12) / 2;
      return shift("S" + i, start, start + (next(4) + 1) / 2, { skill: next(3) ? "repair" : "intake", needed: next(3) + 1 });
    });
    const plan = allocate(people, shifts);
    assertSafe(plan);
    const other = allocate([...people].reverse(), [...shifts].reverse());
    assert.equal(assignmentsCsv(other), assignmentsCsv(plan));
    assert.equal(report(other), report(plan));
  }
});


test("gap summary shows missing slots and only matching-skill blockers before full details", () => {
  const plan = allocate([
    volunteer("Assigned"), volunteer("Away", { from: at(1) }),
    volunteer("Unskilled", { skills: ["cafe"] }),
  ], [shift("gap", 0, 1, { needed: 2 })]);
  const text = report(plan);
  const summary = text.split("GAP SUMMARY (matching-skill candidates only)\n")[1].split("\nSHIFT COVERAGE")[0];
  assert.match(summary, /gap \| 2026-10-31T09:00:00\.000Z → 2026-10-31T10:00:00\.000Z \| duration: 1h \| missing: 1\/2 \| repair/);
  assert.match(summary, /Assigned: already assigned to this shift/);
  assert.match(summary, /Away: outside availability/);
  assert.doesNotMatch(summary, /Unskilled|missing skill/);
  const detailed = text.split("UNCOVERED SLOTS AND WHY\n")[1];
  assert.match(detailed, /Unskilled: missing skill repair/);
  assert.match(detailed, /Away: outside availability/);
  assert.ok(text.indexOf("GAP SUMMARY") < text.indexOf("UNCOVERED SLOTS AND WHY"));
});

test("gap summary explicitly handles no matching skills, no volunteers, and no gaps", () => {
  for (const roster of [[], [volunteer("Other", { skills: ["cafe"] })]]) {
    const text = report(allocate(roster, [shift("gap", 0, 1)]));
    const summary = text.split("GAP SUMMARY (matching-skill candidates only)\n")[1].split("\nSHIFT COVERAGE")[0];
    assert.match(summary, /No matching-skill volunteers for repair/);
    assert.doesNotMatch(summary, /Other:/);
  }
  for (const shifts of [[], [shift("covered", 0, 1)]]) {
    const text = report(allocate([volunteer("A")], shifts));
    assert.match(text, /GAP SUMMARY \(matching-skill candidates only\)\nNone — every requested person-slot is filled/);
  }
});

test("gap summary uses elapsed duration while preserving explicit input offsets", () => {
  const shifts = readShifts("id,starts_at,ends_at,skill,people_needed\n" +
    "offset-gap,2026-10-31T10:00+01:00,2026-10-31T11:00+00:00,repair,2\n");
  assert.match(report(allocate([], shifts)), /offset-gap \| 2026-10-31T10:00\+01:00 → 2026-10-31T11:00\+00:00 \| duration: 2h \| missing: 2\/2/);
});

test("remaining hours are labeled allocation-time snapshots, with a whole-rerun warning", () => {
  const plan = allocate([volunteer("A", { maxMs: HOUR_MS / 2 })], [
    shift("gap", 0, 1), shift("later", 1, 1.5),
  ]);
  assert.equal(plan.volunteers[0].maxMs - plan.volunteers[0].usedMs, 0, "no final unused hours");
  const before = JSON.stringify(plan);
  const text = report(plan);
  assert.equal((text.match(/0\.5h remaining at allocation time, 1h needed/g) || []).length, 2,
    "both compact and full explanations keep the earlier half-hour balance");
  assert.match(text, /not final unused hours/);
  assert.match(text, /Changing inputs to solve one gap can move another; review the whole rerun/);
  assert.equal(JSON.stringify(plan), before, "formatting does not change allocation state");
});
