'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const S = require('../storage.js');
const clone = value => JSON.parse(JSON.stringify(value));
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function destination(start = '12:00', end = '13:00') {
  let s = C.demo();
  s = C.saveShift(s, { id: 'existing', title: 'Quay handover', date: '2026-11-02', start, end, role: 'Shore support', required: 1, notes: 'Keep this work.' });
  return C.saveAssignment(s, { id: 'existing-a', shiftId: 'existing', volunteerId: 'v-maya' });
}
test('copy defaults to shifts only, preserves every original record and every copied shift field', () => {
  const state = freeze(C.demo()); const before = clone(state); const next = C.copyWeek(state, '2026-10-26');
  assert.deepEqual(state, before); assert.deepEqual(next.shifts.slice(0, 10), before.shifts);
  assert.deepEqual(next.assignments, before.assignments); assert.deepEqual(next.volunteers, before.volunteers);
  assert.equal(next.shifts.length, 20);
  next.shifts.slice(10).forEach((s, i) => {
    assert.notEqual(s.id, before.shifts[i].id);
    assert.deepEqual({ ...s, id: before.shifts[i].id, date: before.shifts[i].date }, before.shifts[i]);
    assert.equal(s.date, C.addDays(before.shifts[i].date, 7));
  });
});
test('carried assignments use fresh IDs and copied shift references without changing source assignments', () => {
  const state = C.demo(); const next = C.copyWeek(state, '2026-10-26', true);
  assert.equal(next.assignments.length, 22); assert.deepEqual(next.assignments.slice(0, 11), state.assignments);
  next.assignments.slice(11).forEach((a, i) => {
    assert.notEqual(a.id, state.assignments[i].id); assert.equal(a.volunteerId, state.assignments[i].volunteerId);
    const old = state.shifts.find(s => s.id === state.assignments[i].shiftId);
    const shifted = next.shifts.find(s => s.id === a.shiftId);
    assert.equal(shifted.date, C.addDays(old.date, 7)); assert.equal(shifted.title, old.title);
  });
  assert.doesNotThrow(() => C.validateState(next));
});
test('fresh IDs avoid collisions across collections and across successive copied weeks', () => {
  const s = C.demo(); s.volunteers.push({ ...clone(s.volunteers[0]), id: 'copy-s-1' });
  const once = C.copyWeek(s, '2026-10-26', true); const twice = C.copyWeek(once, '2026-11-02', true);
  const ids = [...twice.volunteers, ...twice.shifts, ...twice.assignments].map(x => x.id);
  assert.equal(new Set(ids).size, ids.length); assert.equal(twice.shifts.length, 30);
});
test('populated destination keeps unrelated work and allows exact back-to-back carried assignments', () => {
  const s = freeze(destination()); const before = clone(s); const next = C.copyWeek(s, '2026-10-26', true);
  assert.deepEqual(s, before); assert.deepEqual(next.shifts.slice(0, 11), before.shifts);
  assert.deepEqual(next.assignments.slice(0, 12), before.assignments);
  assert.equal(next.assignments.length, 23); assert.doesNotThrow(() => C.validateState(next));
});
test('one destination crew overlap rejects the whole copy, with shifts-only recovery', () => {
  const s = freeze(destination('09:30', '10:30')); const before = JSON.stringify(s);
  assert.throws(() => C.copyWeek(s, '2026-10-26', true), /No changes applied.*Overlaps.*Copy shifts only/);
  assert.equal(JSON.stringify(s), before);
  const next = C.copyWeek(s, '2026-10-26', false);
  assert.equal(next.shifts.length, 21); assert.deepEqual(next.assignments, s.assignments);
});
test('a late duplicate blocks all copying, ignoring changed capacities/notes and normalized title spelling', () => {
  for (const carry of [false, true]) {
    const s = C.demo(); const last = s.shifts.at(-1);
    s.shifts.push({ ...last, id: 'already', date: C.addDays(last.date, 7), title: '  ' + last.title.toUpperCase().replaceAll(' ', '   ') + '  ', required: 20, notes: 'Different note' });
    const before = JSON.stringify(s);
    assert.throws(() => C.copyWeek(s, '2026-10-26', carry), /Destination already contains.*Use the existing shift/);
    assert.equal(JSON.stringify(s), before);
  }
});
test('repeat copying and duplicated source work never silently produce duplicate shifts', () => {
  const once = C.copyWeek(C.demo(), '2026-10-26'); const before = clone(once);
  assert.throws(() => C.copyWeek(once, '2026-10-26'), /Destination already contains/); assert.deepEqual(once, before);
  const duplicate = C.demo(); duplicate.shifts.push({ ...duplicate.shifts[0], id: 'same-work', required: 2 });
  const raw = JSON.stringify(duplicate); assert.throws(() => C.copyWeek(duplicate, '2026-10-26'), error => {
    assert.match(error.message, /No changes applied.*Source week contains duplicate work.*Open the harbor.*2026-10-26.*distinct titles/);
    assert.doesNotMatch(error.message, /Destination already contains|Use the existing shift/);
    return true;
  });
  assert.equal(JSON.stringify(duplicate), raw);
});
test('late invalid destination dates do not leave earlier valid copies behind', () => {
  const s = C.demo(); s.assignments = [];
  s.shifts = [{ ...s.shifts[0], date: '9999-12-13' }, { ...s.shifts[1], date: '9999-12-14' }];
  const before = JSON.stringify(s);
  assert.throws(() => C.copyWeek(s, '9999-12-13'), /Cannot copy.*9999-12-21.*earlier source week/);
  assert.equal(JSON.stringify(s), before);
});
test('empty weeks, non-Mondays, malformed dates and nonboolean assignment choices are rejected', () => {
  const s = C.demo();
  for (const date of ['2026-11-02', '2026-10-27', 'invalid', null, '10000-01-03']) assert.throws(() => C.copyWeek(s, date));
  for (const mode of ['false', 0, null, {}]) assert.throws(() => C.copyWeek(s, '2026-10-26', mode), /Choose shifts only/);
});
test('calendar copying preserves weekdays across leap days and new years', () => {
  for (const [source, expected] of [['2024-02-26', '2024-03-04'], ['2026-12-28', '2027-01-04']]) {
    const s = C.demo(); s.assignments = []; s.shifts = [{ ...s.shifts[0], date: source }];
    const next = C.copyWeek(s, source); assert.equal(next.shifts[1].date, expected); assert.equal(C.dayIndex(expected), 0);
  }
});
test('unavailable, unqualified or missing source assignees cannot bypass full-state validation', () => {
  for (const corrupt of [s => {s.volunteers[0].availability=[];}, s => {s.volunteers[0].roles=['Launch crew'];}, s => {s.assignments[0].volunteerId='missing';}]) {
    const s = C.demo(); corrupt(s); const before = JSON.stringify(s);
    assert.throws(() => C.copyWeek(s, '2026-10-26', true)); assert.equal(JSON.stringify(s), before);
  }
});
test('valid copies are saved in one complete snapshot and invalid copies make no storage writes', () => {
  let raw = JSON.stringify(C.demo()); let writes = 0;
  const store = { getItem(){return raw;}, setItem(key, value){writes++;raw=value;} };
  const session = S.open(() => store); const next = C.copyWeek(session.state, '2026-10-26', true);
  assert.equal(session.save(next), ''); assert.equal(writes, 1); assert.deepEqual(JSON.parse(raw), next);
  const saved = raw; assert.throws(() => session.save(C.copyWeek(next, '2026-10-26', true)));
  assert.equal(writes, 1); assert.equal(raw, saved);
});
