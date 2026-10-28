'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const copy = x => JSON.parse(JSON.stringify(x));
const empty = () => ({ version: 1, volunteers: [], shifts: [], assignments: [] });
const shift = (overrides = {}) => ({ id: 's', title: 'Quay watch', date: '2026-10-26', start: '09:00', end: '12:00', role: 'Shore support', required: 2, notes: '', ...overrides });
const volunteer = (overrides = {}) => ({ id: 'v', name: 'Alex Reed', roles: ['Shore support'], availability: [{ day: 0, start: '08:00', end: '17:00' }], notes: '', ...overrides });
const fixture = () => C.saveVolunteer(C.saveShift(empty(), shift()), volunteer());
const assign = (s, overrides = {}) => C.saveAssignment(s, { id: 'a', shiftId: 's', volunteerId: 'v', ...overrides });

test('seed week is valid and has exact believable coverage', () => {
  const s = C.demo();
  assert.equal(s.volunteers.length, 6);
  assert.deepEqual(C.coverage(s), { required: 16, filled: 11, open: 5, covered: 5, shifts: 10 });
  assert.equal(s.shifts[0].date, '2026-10-26');
  s.volunteers[0].name = 'Changed';
  assert.equal(C.demo().volunteers[0].name, 'Maya Ellis');
});
test('creates and updates volunteers and shifts without mutating input', () => {
  const original = fixture(); const snapshot = copy(original);
  const next = C.saveVolunteer(original, volunteer({ name: 'Alex Morgan' }));
  assert.deepEqual(original, snapshot);
  assert.equal(next.volunteers.length, 1);
  assert.equal(next.volunteers[0].name, 'Alex Morgan');
  assert.equal(C.saveShift(next, shift({ title: 'Visitor desk' })).shifts[0].title, 'Visitor desk');
});
test('allows exact availability boundaries and counts assignments, not people', () => {
  const state = C.saveVolunteer(fixture(), volunteer({ availability: [{ day: 0, start: '09:00', end: '12:00' }] }));
  assert.equal(assign(state).assignments.length, 1);
  assert.deepEqual(C.coverage(assign(state)), { required: 2, filled: 1, open: 1, covered: 0, shifts: 1 });
});
test('strict intersection: partial, contained, enclosing and identical overlaps', () => {
  const base = shift();
  for (const [start, end] of [['08:00', '10:00'], ['11:00', '14:00'], ['10:00', '11:00'], ['08:00', '13:00'], ['09:00', '12:00']]) {
    const next = C.saveShift(assign(fixture()), shift({ id: 's2', start, end }));
    assert.throws(() => assign(next, { id: 'a2', shiftId: 's2' }), /Overlaps Quay watch/);
    assert.equal(C.overlaps(base, shift({ start, end })), true);
  }
});
test('back-to-back shifts are allowed in both directions', () => {
  let s = assign(fixture());
  s = C.saveShift(s, shift({ id: 'before', start: '08:00', end: '09:00' }));
  s = C.saveShift(s, shift({ id: 'after', start: '12:00', end: '13:00' }));
  s = assign(s, { id: 'a-before', shiftId: 'before' });
  s = assign(s, { id: 'a-after', shiftId: 'after' });
  assert.equal(s.assignments.length, 3);
  assert.equal(C.coverage(s).filled, 3);
});
test('same time on another date does not overlap; weekday still matters', () => {
  let s = assign(fixture());
  s = C.saveShift(s, shift({ id: 'next-week', date: '2026-11-02' }));
  assert.equal(assign(s, { id: 'a2', shiftId: 'next-week' }).assignments.length, 2);
  s = C.saveShift(s, shift({ id: 'tuesday', date: '2026-10-27' }));
  assert.throws(() => assign(s, { id: 'a2', shiftId: 'tuesday' }), /Unavailable/);
});
test('overlapping shifts can have different volunteers', () => {
  let s = assign(fixture());
  s = C.saveVolunteer(s, volunteer({ id: 'v2', name: 'Rory' }));
  s = C.saveShift(s, shift({ id: 's2', start: '10:00' }));
  assert.equal(assign(s, { id: 'a2', shiftId: 's2', volunteerId: 'v2' }).assignments.length, 2);
});
test('blocks ineligible roles and partial/unavailable windows', () => {
  assert.throws(() => assign(C.saveVolunteer(fixture(), volunteer({ roles: ['Dock lead'] }))), /Not eligible for Shore support/);
  for (const availability of [[], [{ day: 1, start: '08:00', end: '17:00' }], [{ day: 0, start: '09:01', end: '17:00' }], [{ day: 0, start: '08:00', end: '11:59' }]])
    assert.throws(() => assign(C.saveVolunteer(fixture(), volunteer({ availability }))), /Unavailable for the full shift/);
});
test('blocks duplicates, overfill and missing references', () => {
  const s = assign(fixture());
  assert.throws(() => assign(s, { id: 'a2' }), /Already assigned/);
  let full = C.saveShift(s, shift({ required: 1 }));
  full = C.saveVolunteer(full, volunteer({ id: 'v2' }));
  assert.throws(() => assign(full, { id: 'a2', volunteerId: 'v2' }), /required crew/);
  assert.throws(() => assign(s, { id: 'a2', shiftId: 'gone' }), /no longer exists/);
  assert.throws(() => assign(s, { id: 'a2', volunteerId: 'gone' }), /no longer exists/);
});
test('assignment replacement ignores only its own previous slot', () => {
  let s = C.saveShift(fixture(), shift({ required: 1 }));
  s = assign(s);
  s = C.saveVolunteer(s, volunteer({ id: 'v2' }));
  const next = assign(s, { volunteerId: 'v2' });
  assert.equal(next.assignments.length, 1);
  assert.equal(next.assignments[0].volunteerId, 'v2');
  assert.equal(s.assignments[0].volunteerId, 'v');
});
test('shift edits cannot create conflicts; rejected edits are atomic', () => {
  let s = assign(fixture());
  s = C.saveShift(s, shift({ id: 's2', start: '12:00', end: '14:00' }));
  s = assign(s, { id: 'a2', shiftId: 's2' });
  const before = copy(s);
  assert.throws(() => C.saveShift(s, shift({ id: 's2', start: '11:59', end: '14:00' })), /Overlaps/);
  assert.throws(() => C.saveShift(s, shift({ role: 'Dock lead' })), /Not eligible/);
  assert.throws(() => C.saveShift(s, shift({ date: '2026-10-27' })), /Unavailable/);
  assert.deepEqual(s, before);
});
test('cannot reduce required crew below existing coverage', () => {
  let s = assign(fixture());
  s = C.saveVolunteer(s, volunteer({ id: 'v2' }));
  s = assign(s, { id: 'a2', volunteerId: 'v2' });
  assert.throws(() => C.saveShift(s, shift({ required: 1 })), /required crew/);
});
test('volunteer role/availability edits cannot invalidate assignments', () => {
  const s = assign(fixture()); const before = copy(s);
  assert.throws(() => C.saveVolunteer(s, volunteer({ roles: ['Dock lead'] })), /Not eligible/);
  assert.throws(() => C.saveVolunteer(s, volunteer({ availability: [] })), /Unavailable/);
  assert.deepEqual(s, before);
  assert.equal(C.saveVolunteer(s, volunteer({ name: 'New name' })).assignments.length, 1);
});
test('deleting shifts or volunteers cascades only their own assignments', () => {
  const s = C.demo();
  const withoutVolunteer = C.remove(s, 'volunteers', 'v-maya');
  assert.equal(withoutVolunteer.assignments.some(a => a.volunteerId === 'v-maya'), false);
  assert.equal(withoutVolunteer.assignments.length, 8);
  assert.equal(withoutVolunteer.shifts.length, 10);
  const withoutShift = C.remove(s, 'shifts', 's-mon-shore');
  assert.equal(withoutShift.assignments.length, 9);
  assert.equal(withoutShift.volunteers.length, 6);
  assert.equal(C.remove(s, 'assignments', 'a-1').assignments.length, 10);
  assert.throws(() => C.remove(s, 'shifts', 'gone'), /no longer exists/);
  assert.throws(() => C.remove(s, '__proto__', 'x'), /Unknown collection/);
});
test('invalid dates, intervals and capacity are rejected', () => {
  for (const date of ['2026-02-29', '2026-13-01', '26-10-01', '', '2026-04-31']) assert.throws(() => C.saveShift(empty(), shift({ date })), /valid shift date/);
  for (const times of [{ start: '12:00' }, { end: '08:00' }, { start: '9:00' }, { end: '24:00' }, { start: '23:00', end: '01:00' }]) assert.throws(() => C.saveShift(empty(), shift(times)), /end must be after start/);
  for (const required of [0, -1, 1.5, 21, '2', NaN]) assert.throws(() => C.saveShift(empty(), shift({ required })), /whole number/);
  assert.equal(C.dateOK('2028-02-29'), true);
});
test('validates text, roles, unique weekdays, duplicate IDs and schema', () => {
  for (const value of [{ name: ' ' }, { name: 'x'.repeat(81) }, { notes: 'x'.repeat(501) }, { roles: [] }, { roles: ['Pilot'] }, { roles: ['Shore support', 'Shore support'] }, { availability: [{ day: 7, start: '08:00', end: '17:00' }] }, { availability: [{ day: 0, start: '08:00', end: '17:00' }, { day: 0, start: '18:00', end: '19:00' }] }]) assert.throws(() => C.saveVolunteer(empty(), volunteer(value)));
  assert.throws(() => C.saveShift(empty(), shift({ title: ' ' })));
  assert.throws(() => C.saveShift(empty(), shift({ role: 'Pilot' })));
  assert.throws(() => C.validateState({ ...fixture(), volunteers: [volunteer(), volunteer()] }), /duplicate volunteer/);
  assert.throws(() => C.validateState({ ...empty(), version: 2 }), /version 1/);
  assert.throws(() => C.validateState(null), /Unrecognized/);
});
test('coverage scopes to supplied shifts, including an empty week', () => {
  const s = C.demo();
  assert.deepEqual(C.coverage(s, []), { required: 0, filled: 0, open: 0, covered: 0, shifts: 0 });
  assert.deepEqual(C.coverage(s, s.shifts.filter(s => s.date === '2026-10-26')), { required: 5, filled: 4, open: 1, covered: 2, shifts: 3 });
});
test('calendar arithmetic uses Monday weeks, crosses years and leap days', () => {
  assert.equal(C.weekStart('2026-11-01'), '2026-10-26');
  assert.equal(C.weekStart('2026-10-26'), '2026-10-26');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(C.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(C.dayIndex('2026-11-01'), 6);
  assert.equal(C.overlaps(shift(), shift({ date: '2026-10-27' })), false);
});

test('rejections identify the conflict and give coordinator remedies without changing state', () => {
  const s = C.demo(); const before = JSON.stringify(s);
  assert.throws(() => C.saveShift(s, { ...s.shifts.find(s => s.id === 's-mon-dock'), start: '09:30', end: '10:30' }), error => {
    assert.match(error.message, /No changes applied/);
    assert.match(error.message, /Maya Ellis/);
    assert.match(error.message, /Welcome desk.*2026-10-26.*10:00–12:00/);
    assert.match(error.message, /Change the shift time or remove\/reassign/);
    return true;
  });
  const ben = s.volunteers.find(v => v.id === 'v-ben');
  assert.throws(() => C.saveVolunteer(s, { ...ben, roles: ['Dock lead'] }), /Not eligible.*Choose an eligible volunteer/);
  assert.throws(() => C.saveVolunteer(s, { ...ben, availability: [] }), /Unavailable.*remove affected assignments/);
  assert.equal(JSON.stringify(s), before);
  assert.match(C.assignmentIssues(s, 's-mon-shore', 'v-theo').join(' '), /increase Crew needed/);
});

test('domain shift bounds match editors and leave room for complete week rendering', () => {
  for (const date of [C.SHIFT_DATE_MIN, C.SHIFT_DATE_MAX]) {
    const s = C.saveShift(empty(), shift({ date }));
    assert.equal(s.shifts[0].date, date);
    assert.doesNotThrow(() => C.addDays(C.weekStart(date), 6));
  }
  for (const date of ['1900-01-01', '9999-12-21', '9999-12-27', '9999-12-28', '9999-12-29', '9999-12-30', '9999-12-31']) {
    assert.throws(() => C.saveShift(empty(), shift({ date })), /valid shift date between 1900-01-08 and 9999-12-20/);
  }
});
