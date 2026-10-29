"use strict";

const { encodeCsv } = require("./csv.js");
const { HOUR_MS } = require("./input.js");

// Code-unit ordering, not localeCompare: independent of host locale and CSV order.
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hours = (ms) => String(Number((ms / HOUR_MS).toFixed(9)));
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

function blockers(volunteer, shift) {
  if (!volunteer.skills.includes(shift.skill)) return ["missing skill " + shift.skill];
  if (volunteer.assigned.some((other) => other.id === shift.id)) {
    return ["already assigned to this shift (one person cannot fill two slots)"];
  }
  const reasons = [];
  if (shift.start < volunteer.from || shift.end > volunteer.to) reasons.push("outside availability");
  const conflicts = volunteer.assigned.filter((other) => overlaps(other, shift));
  if (conflicts.length) reasons.push("overlaps " + conflicts.map((other) => other.id).join(", "));
  if (shift.end - shift.start > volunteer.maxMs - volunteer.usedMs) {
    reasons.push("max_hours exceeded (" + hours(volunteer.maxMs - volunteer.usedMs) + "h remaining at allocation time, " +
      hours(shift.end - shift.start) + "h needed)");
  }
  return reasons;
}

// Inputs are validated records from input.js. No input objects are mutated.
function allocate(volunteers, shifts) {
  const roster = volunteers.map((v) => ({ ...v, usedMs: 0, assigned: [] }))
    .sort((a, b) => compareText(a.name, b.name));
  const ordered = [...shifts].sort((a, b) => a.start - b.start || a.end - b.end || compareText(a.id, b.id));
  const coverage = [], assignments = [];
  for (const shift of ordered) {
    const candidates = roster.filter((v) => blockers(v, shift).length === 0)
      .sort((a, b) => a.skills.length - b.skills.length || a.usedMs - b.usedMs || compareText(a.name, b.name));
    const selected = candidates.slice(0, shift.needed);
    for (const volunteer of selected) {
      volunteer.assigned.push(shift);
      volunteer.usedMs += shift.end - shift.start;
      assignments.push({ shift, volunteer: volunteer.name });
    }
    const missing = shift.needed - selected.length;
    // Snapshot now: later allocations must not rewrite the explanation for a gap.
    const reasons = missing ? roster.map((v) => ({ name: v.name, reasons: blockers(v, shift) })) : [];
    coverage.push({ shift, names: selected.map((v) => v.name), missing, reasons });
  }
  return { coverage, assignments, volunteers: roster,
    totalSlots: ordered.reduce((total, shift) => total + shift.needed, 0),
    uncovered: coverage.reduce((total, row) => total + row.missing, 0) };
}

function assignmentsCsv(plan) {
  return encodeCsv([
    ["shift_id", "volunteer", "starts_at", "ends_at", "skill"],
    ...plan.assignments.map(({ shift, volunteer }) => [shift.id, volunteer, shift.startsAt, shift.endsAt, shift.skill]),
  ]);
}

function report(plan) {
  const lines = [
    "COMMUNITY REPAIR CAFE — VOLUNTEER SHIFT PLAN",
    "Coverage: " + plan.assignments.length + "/" + plan.totalSlots + " person-slots filled; " + plan.uncovered + " uncovered.",
    "A person-slot is one volunteer covering one entire shift.",
    "Rule: shifts by start, end, ID; candidates by fewest skills, least assigned time, name.",
    "Times retain input offsets; comparisons and hour budgets use elapsed time.",
    "Remaining hours in gap explanations are the budget at allocation time, not final unused hours.",
    "WARNING: Changing inputs to solve one gap can move another; review the whole rerun, not only the target shift.",
    "",
    "GAP SUMMARY (matching-skill candidates only)",
  ];
  if (!plan.uncovered) lines.push("None — every requested person-slot is filled.");
  for (const { shift, missing, reasons } of plan.coverage.filter((row) => row.missing)) {
    lines.push(shift.id + " | " + shift.startsAt + " → " + shift.endsAt +
      " | duration: " + hours(shift.end - shift.start) + "h | missing: " + missing + "/" + shift.needed + " | " + shift.skill);
    const matchingNames = new Set(plan.volunteers.filter((v) => v.skills.includes(shift.skill)).map((v) => v.name));
    const matching = reasons.filter((entry) => matchingNames.has(entry.name));
    if (!matching.length) lines.push("  No matching-skill volunteers for " + shift.skill + ".");
    for (const entry of matching) lines.push("  " + entry.name + ": " + entry.reasons.join("; ") + ".");
  }
  lines.push("", "SHIFT COVERAGE");
  if (!plan.coverage.length) lines.push("No shifts supplied.");
  for (const { shift, names, missing } of plan.coverage) {
    lines.push(shift.id + " | " + shift.startsAt + " → " + shift.endsAt + " | " + shift.skill);
    lines.push("  " + names.length + "/" + shift.needed + " assigned: " + (names.join("; ") || "none") +
      (missing ? " | UNCOVERED: " + missing : ""));
  }
  lines.push("", "UNCOVERED SLOTS AND WHY", "Reasons reflect the allocation decision, not a proof that no better plan exists.");
  if (!plan.uncovered) lines.push("None — every requested person-slot is filled.");
  for (const { shift, missing, reasons } of plan.coverage.filter((row) => row.missing)) {
    lines.push(shift.id + ": " + missing + " of " + shift.needed + " person-slot(s) unfilled (" + shift.skill + ").");
    if (!reasons.length) lines.push("  No volunteers supplied.");
    for (const entry of reasons) lines.push("  " + entry.name + ": " + entry.reasons.join("; ") + ".");
  }
  lines.push("", "VOLUNTEER TOTALS (assigned / maximum hours)");
  if (!plan.volunteers.length) lines.push("No volunteers supplied.");
  for (const v of plan.volunteers) {
    lines.push(v.name + ": " + hours(v.usedMs) + " / " + hours(v.maxMs) + "h | " +
      (v.assigned.map((shift) => shift.id).join(", ") || "no assignments"));
  }
  lines.push("", "LIMITATIONS", "Greedy, whole-shift allocation; no backtracking or guarantee of maximum coverage or fairness.",
    "No automatic breaks, travel time, skill levels, or local daylight-saving rules. Review before sharing.");
  return lines.join("\n") + "\n";
}

module.exports = { allocate, assignmentsCsv, report };
