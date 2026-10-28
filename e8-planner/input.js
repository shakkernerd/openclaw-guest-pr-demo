"use strict";

const { parseCsv } = require("./csv.js");
const HOUR_MS = 3_600_000;
// Disallow terminal control characters and invisible direction overrides.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const VOLUNTEER_HEADERS = ["name", "skills", "available_from", "available_to", "max_hours"];
const SHIFT_HEADERS = ["id", "starts_at", "ends_at", "skill", "people_needed"];

function table(text, headers, source) {
  const rows = parseCsv(text, source);
  if (!rows.length) throw new Error(source + ": missing header");
  const header = rows.shift();
  if (header.cells.some((value) => CONTROL_CHARACTERS.test(value))) {
    throw new Error(source + ":" + header.line + ": header contains control characters");
  }
  const columns = header.cells.map((value) => value.trim());
  if (columns.length !== headers.length || new Set(columns).size !== columns.length ||
      headers.some((name) => !columns.includes(name))) {
    throw new Error(source + ": header must contain exactly: " + headers.join(", "));
  }
  return rows.map(({ cells, line }) => {
    const where = source + ":" + line;
    if (cells.length !== columns.length) throw new Error(where + ": expected " + columns.length + " columns; got " + cells.length);
    const row = Object.fromEntries(columns.map((column, i) => [column, cells[i].trim()]));
    for (const column of columns) {
      if (!row[column]) throw new Error(where + ": " + column + " is required");
      if (CONTROL_CHARACTERS.test(cells[columns.indexOf(column)])) {
        throw new Error(where + ": " + column + " contains control characters");
      }
    }
    return { row, where };
  });
}

function parseTime(value, where) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const fail = () => { throw new Error(where + ": invalid ISO time with explicit offset: " + value); };
  if (!match) fail();
  const [, year, month, day, hour, minute, second = "0", , offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > monthDays[m - 1] ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) fail();
  if (offset !== "Z") {
    const oh = Number(offset.slice(1, 3)), om = Number(offset.slice(4));
    // -00:00 means an unknown local offset, not a known UTC offset.
    if (offset === "-00:00" || oh > 14 || om > 59 || (oh === 14 && om !== 0)) fail();
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail();
  return time;
}

function parseHours(value, where) {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) {
    throw new Error(where + ": max_hours must be a non-negative decimal with at most 3 decimal places");
  }
  const [whole, fraction = ""] = value.split(".");
  // Integer milli-hours avoid rounding errors at a volunteer's budget boundary.
  const ms = (Number(whole) * 1000 + Number(fraction.padEnd(3, "0"))) * 3600;
  if (!Number.isSafeInteger(ms)) throw new Error(where + ": max_hours is too large");
  return ms;
}

function unique(value, seen, where, field) {
  if (seen.has(value)) throw new Error(where + ": duplicate " + field + ": " + value);
  seen.add(value);
}

function readVolunteers(text, source = "volunteers.csv") {
  const names = new Set();
  return table(text, VOLUNTEER_HEADERS, source).map(({ row, where }) => {
    unique(row.name, names, where, "name");
    const skills = row.skills.split(";").map((skill) => skill.trim());
    if (skills.some((skill) => !skill) || new Set(skills).size !== skills.length) {
      throw new Error(where + ": skills must be unique non-empty names separated by semicolons");
    }
    const from = parseTime(row.available_from, where + " available_from");
    const to = parseTime(row.available_to, where + " available_to");
    if (to <= from) throw new Error(where + ": available_to must be after available_from");
    return { name: row.name, skills, from, to, maxMs: parseHours(row.max_hours, where) };
  });
}

function readShifts(text, source = "shifts.csv") {
  const ids = new Set();
  let totalSlots = 0;
  return table(text, SHIFT_HEADERS, source).map(({ row, where }) => {
    unique(row.id, ids, where, "id");
    if (row.skill.includes(";")) throw new Error(where + ": skill must be a single skill name");
    const start = parseTime(row.starts_at, where + " starts_at");
    const end = parseTime(row.ends_at, where + " ends_at");
    if (end <= start) throw new Error(where + ": ends_at must be after starts_at");
    const needed = Number(row.people_needed);
    if (!/^\d+$/.test(row.people_needed) || !Number.isSafeInteger(needed) || needed < 1) {
      throw new Error(where + ": people_needed must be a positive safe integer");
    }
    totalSlots += needed;
    if (!Number.isSafeInteger(totalSlots)) throw new Error(where + ": total people_needed is too large");
    return { id: row.id, start, end, startsAt: row.starts_at, endsAt: row.ends_at, skill: row.skill, needed };
  });
}

module.exports = { HOUR_MS, parseTime, readVolunteers, readShifts };
