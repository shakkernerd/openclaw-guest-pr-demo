'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const S = require('../storage.js');
function memory(initial = null) {
  let value = initial;
  return { getItem: () => value, setItem: (key, next) => { assert.equal(key, S.KEY); value = next; } };
}
test('first run seeds demo, then saves and restores real edits', () => {
  const store = memory(); const session = S.open(() => store);
  assert.equal(session.warning, '');
  const next = C.remove(session.state, 'shifts', 's-mon-dock');
  assert.equal(session.save(next), '');
  assert.deepEqual(S.open(() => store).state, next);
});
test('corrupt, unsupported and conflicting data are protected, never overwritten', () => {
  const conflict = C.demo();
  conflict.assignments.push({ id: 'bad', shiftId: 's-mon-launch', volunteerId: 'v-maya' });
  for (const raw of ['{oops', JSON.stringify({ version: 9 }), JSON.stringify(conflict)]) {
    const store = memory(raw); const session = S.open(() => store);
    assert.match(session.warning, /NOT been overwritten/);
    assert.match(session.save(C.demo()), /protected/);
    assert.equal(store.getItem(S.KEY), raw);
    assert.equal(session.state.shifts.length, 10);
  }
});
test('blocked storage and quota failures produce temporary-session warnings', () => {
  const session = S.open(() => { throw new Error('SecurityError'); });
  assert.match(session.warning, /unavailable/);
  assert.match(session.save(C.demo()), /temporary/);
  const quota = S.open(() => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } }));
  assert.match(quota.save(C.demo()), /full or blocked/);
});
test('stale tabs do not overwrite a newer saved snapshot', () => {
  const store = memory(); const one = S.open(() => store); const two = S.open(() => store);
  const next = C.remove(one.state, 'shifts', 's-mon-dock');
  assert.equal(one.save(next), '');
  assert.match(two.save(C.demo()), /Another tab/);
  assert.deepEqual(JSON.parse(store.getItem(S.KEY)), next);
  assert.match(two.save(C.demo()), /protected/);
});
test('invalid writes fail before storage changes', () => {
  const store = memory(); const session = S.open(() => store);
  assert.throws(() => session.save({ version: 2 }), /version 1/);
  assert.equal(store.getItem(S.KEY), null);
});

test('out-of-range saved shift dates recover with protected data, not a render crash', () => {
  for (const date of ['9999-12-27', '9999-12-28', '9999-12-29', '9999-12-30', '9999-12-31']) {
    const bad = C.demo(); bad.assignments = []; bad.shifts = [{ ...bad.shifts[0], date }];
    const raw = JSON.stringify(bad); const store = memory(raw); const session = S.open(() => store);
    assert.match(session.warning, /NOT been overwritten/);
    assert.equal(session.state.shifts.length, 10);
    assert.match(session.save(C.demo()), /protected/);
    assert.equal(store.getItem(S.KEY), raw);
  }
});
