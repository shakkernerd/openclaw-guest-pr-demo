/* Shared browser/Node domain API. No DOM, storage, dependencies, or network. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HarborCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const ROLES = ['Dock lead', 'Launch crew', 'Shore support'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  // Match the editors and leave room to render every day of the selected week.
  const SHIFT_DATE_MIN = '1900-01-08';
  const SHIFT_DATE_MAX = '9999-12-20';
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw new Error(message); };
  const dateOK = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number(date.slice(0, 4)) >= 1900 && Number(date.slice(0, 4)) <= 9999 &&
    Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
  const minutes = time => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN;
  const dayIndex = date => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
  function addDays(date, count) {
    if (!dateOK(date)) fail('Choose a valid date.');
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + count);
    const result = d.toISOString().slice(0, 10);
    if (!dateOK(result)) fail('Date is outside the supported range.');
    return result;
  }
  const weekStart = date => addDays(date, -dayIndex(date));
  const overlaps = (a, b) => a.date === b.date && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
  function textField(value, label, max = 80) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} is required (maximum ${max} characters).`);
  }
  function interval(start, end, label) {
    if (!Number.isFinite(minutes(start)) || !Number.isFinite(minutes(end)) || minutes(start) >= minutes(end))
      fail(`${label}: end must be after start on the same day. Overnight shifts are not supported.`);
  }
  function validateVolunteer(v) {
    if (!v || typeof v !== 'object') fail('Invalid volunteer.');
    textField(v.id, 'Volunteer ID');
    textField(v.name, 'Volunteer name');
    if (!Array.isArray(v.roles) || v.roles.length === 0 || new Set(v.roles).size !== v.roles.length || v.roles.some(r => !ROLES.includes(r))) fail('Choose at least one valid, unique role.');
    if (!Array.isArray(v.availability) || v.availability.length > 7) fail('Availability must contain at most one window per weekday.');
    const seen = new Set();
    for (const a of v.availability) {
      if (!a || !Number.isInteger(a.day) || a.day < 0 || a.day > 6 || seen.has(a.day)) fail('Availability must have unique weekdays.');
      seen.add(a.day);
      interval(a.start, a.end, `${DAYS[a.day]} availability`);
    }
    if (typeof v.notes !== 'string' || v.notes.length > 500) fail('Volunteer notes must be at most 500 characters.');
  }
  function validateShift(s) {
    if (!s || typeof s !== 'object') fail('Invalid shift.');
    textField(s.id, 'Shift ID');
    textField(s.title, 'Shift title');
    if (!dateOK(s.date) || s.date < SHIFT_DATE_MIN || s.date > SHIFT_DATE_MAX) fail(`Choose a valid shift date between ${SHIFT_DATE_MIN} and ${SHIFT_DATE_MAX}.`);
    interval(s.start, s.end, 'Shift time');
    if (!ROLES.includes(s.role)) fail('Choose a valid shift role.');
    if (!Number.isInteger(s.required) || s.required < 1 || s.required > 20) fail('Required crew must be a whole number from 1 to 20.');
    if (typeof s.notes !== 'string' || s.notes.length > 500) fail('Shift notes must be at most 500 characters.');
  }
  function assignmentIssues(state, shiftId, volunteerId, ignoreId = null) {
    const s = state.shifts.find(x => x.id === shiftId);
    const v = state.volunteers.find(x => x.id === volunteerId);
    if (!s || !v) return ['Shift or volunteer no longer exists. Close this editor and choose an existing shift and volunteer.'];
    const others = state.assignments.filter(a => a.id !== ignoreId);
    const issues = [];
    if (others.some(a => a.shiftId === shiftId && a.volunteerId === volunteerId)) issues.push('Already assigned to this shift. Keep the existing assignment, or remove it before assigning again.');
    if (others.filter(a => a.shiftId === shiftId).length >= s.required) issues.push('This shift already has its required crew. Remove a crew member or increase Crew needed before adding someone.');
    if (!v.roles.includes(s.role)) issues.push(`Not eligible for ${s.role}. Choose an eligible volunteer or change the shift role. Update eligible roles in Volunteers only if the person is qualified; remove affected assignments before removing a role.`);
    if (!v.availability.some(a => a.day === dayIndex(s.date) && minutes(a.start) <= minutes(s.start) && minutes(a.end) >= minutes(s.end)))
      issues.push(`Unavailable for the full shift on ${DAYS[dayIndex(s.date)]} (${s.date}, ${s.start}–${s.end}). Change the shift time or choose another volunteer. Update availability in Volunteers only if accurate; remove affected assignments before reducing availability.`);
    for (const a of others.filter(a => a.volunteerId === volunteerId && a.shiftId !== shiftId)) {
      const other = state.shifts.find(x => x.id === a.shiftId);
      if (other && overlaps(s, other)) issues.push(`Overlaps ${other.title} (${other.date}, ${other.start}–${other.end}). Change the shift time or remove/reassign ${v.name} from one of these shifts. Back-to-back times are allowed.`);
    }
    return issues;
  }
  function validateState(state) {
    if (!state || state.version !== 1 || !Array.isArray(state.volunteers) || !Array.isArray(state.shifts) || !Array.isArray(state.assignments)) fail('Unrecognized rota data (expected version 1).');
    for (const [items, label] of [[state.volunteers, 'volunteer'], [state.shifts, 'shift'], [state.assignments, 'assignment']]) {
      const ids = new Set();
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 80 || ids.has(item.id)) fail(`Invalid or duplicate ${label} ID.`);
        ids.add(item.id);
      }
    }
    state.volunteers.forEach(validateVolunteer);
    state.shifts.forEach(validateShift);
    for (const a of state.assignments) {
      const issues = assignmentIssues(state, a.shiftId, a.volunteerId, a.id);
      if (issues.length) {
        const v = state.volunteers.find(v => v.id === a.volunteerId);
        const s = state.shifts.find(s => s.id === a.shiftId);
        fail(`${v?.name || 'Assignment'}${s ? ' · ' + s.title : ''}: ${issues.join(' ')}`);
      }
    }
    return state;
  }
  // Every mutation returns a validated copy. Rejected edits never mutate input.
  function transact(state, change) {
    validateState(state);
    const next = clone(state);
    try {
      change(next);
      return validateState(next);
    } catch (error) {
      fail('No changes applied. ' + error.message);
    }
  }
  function upsert(state, collection, value) {
    return transact(state, next => {
      const i = next[collection].findIndex(x => x.id === value.id);
      if (i < 0) next[collection].push(clone(value));
      else next[collection][i] = clone(value);
    });
  }
  const saveVolunteer = (state, value) => upsert(state, 'volunteers', value);
  const saveShift = (state, value) => upsert(state, 'shifts', value);
  const saveAssignment = (state, value) => upsert(state, 'assignments', value);
  function remove(state, collection, id) {
    if (!['volunteers', 'shifts', 'assignments'].includes(collection)) fail('Unknown collection.');
    return transact(state, next => {
      if (!next[collection].some(x => x.id === id)) fail('Item no longer exists.');
      next[collection] = next[collection].filter(x => x.id !== id);
      if (collection === 'volunteers') next.assignments = next.assignments.filter(a => a.volunteerId !== id);
      if (collection === 'shifts') next.assignments = next.assignments.filter(a => a.shiftId !== id);
    });
  }
  // Copy is one transaction, never a loop of persisted per-shift mutations.
  function copyWeek(state, sourceWeek, carryAssignments = false) {
    return transact(state, next => {
      if (!dateOK(sourceWeek) || weekStart(sourceWeek) !== sourceWeek) fail('Choose a valid Monday-starting source week.');
      if (typeof carryAssignments !== 'boolean') fail('Choose shifts only or shifts with assignments.');
      const end = addDays(sourceWeek, 6);
      const source = next.shifts.filter(s => s.date >= sourceWeek && s.date <= end);
      if (!source.length) fail('This week has no shifts to copy. Choose a populated source week.');
      const normalize = title => title.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
      // Capacity and notes do not distinguish work; changing them must not bypass deduplication.
      const workKey = s => JSON.stringify([s.date, s.start, s.end, s.role, normalize(s.title)]);
      const work = new Map(next.shifts.map(s => [workKey(s), s]));
      const planned = new Map();
      const used = new Set([...next.shifts, ...next.assignments, ...next.volunteers].map(x => x.id));
      let serial = 0;
      const fresh = prefix => { let id; do { id = 'copy-' + prefix + '-' + ++serial; } while (used.has(id)); used.add(id); return id; };
      const ids = new Map();
      for (const original of source) {
        let date;
        try { date = addDays(original.date, 7); }
        catch { fail('Cannot copy ' + original.title + ': the following date is outside the supported range. Choose an earlier source week.'); }
        if (date < SHIFT_DATE_MIN || date > SHIFT_DATE_MAX) fail('Cannot copy ' + original.title + ' to ' + date + '. Shift dates must be between ' + SHIFT_DATE_MIN + ' and ' + SHIFT_DATE_MAX + '; choose an earlier source week.');
        const copied = { ...original, id: fresh('s'), date };
        const existing = work.get(workKey(copied));
        if (existing) fail('Destination already contains ' + existing.title + ' on ' + date + ' (' + copied.start + '–' + copied.end + ', ' + copied.role + '). Use the existing shift, or change the source/destination work before copying. No shifts are merged or skipped.');
        const duplicate = planned.get(workKey(copied));
        if (duplicate) fail('Source week contains duplicate work: ' + duplicate.title + ' on ' + duplicate.date + ' (' + duplicate.start + '–' + duplicate.end + ', ' + duplicate.role + '). Review the repeated source shifts: give genuinely different duties distinct titles, or remove the duplicate before copying.');
        planned.set(workKey(copied), original);
        ids.set(original.id, copied.id);
        next.shifts.push(copied);
      }
      if (carryAssignments) {
        const assignments = next.assignments.filter(a => ids.has(a.shiftId));
        next.assignments.push(...assignments.map(a => ({ ...a, id: fresh('a'), shiftId: ids.get(a.shiftId) })));
        try { validateState(next); }
        catch (error) { fail(error.message + ' Copy shifts only to leave crew unassigned, or resolve the destination crew conflict first.'); }
      }
    });
  }
  function coverage(state, shifts = state.shifts) {
    const ids = new Set(shifts.map(s => s.id));
    const required = shifts.reduce((n, s) => n + s.required, 0);
    const filled = state.assignments.filter(a => ids.has(a.shiftId)).length;
    const covered = shifts.filter(s => state.assignments.filter(a => a.shiftId === s.id).length === s.required).length;
    return { required, filled, open: required - filled, covered, shifts: shifts.length };
  }
  function demo() {
    const availability = (days, start = '07:00', end = '19:00') => days.map(day => ({ day, start, end }));
    const volunteers = [
      { id: 'v-maya', name: 'Maya Ellis', roles: [...ROLES], availability: availability([0, 2, 4, 5]), notes: 'Experienced launch skipper. Happy to mentor new crew.' },
      { id: 'v-theo', name: 'Theo Grant', roles: ['Launch crew', 'Shore support'], availability: availability([0, 1, 3, 5], '08:00', '17:00'), notes: 'Usually cycles down for morning shifts.' },
      { id: 'v-nia', name: 'Nia Morgan', roles: ['Dock lead', 'Shore support'], availability: availability([1, 3, 5, 6]), notes: 'First-aid trained.' },
      { id: 'v-ben', name: 'Ben Okafor', roles: ['Shore support'], availability: availability([0, 2, 4, 6], '09:00', '16:00'), notes: 'New volunteer; shore-based duties for now.' },
      { id: 'v-rose', name: 'Rose Chen', roles: ['Launch crew', 'Shore support'], availability: availability([2, 4, 5, 6], '08:00', '18:00'), notes: 'Available most weekends.' },
      { id: 'v-ian', name: 'Ian Patel', roles: ['Dock lead', 'Launch crew'], availability: availability([0, 1, 3, 6], '07:00', '13:00'), notes: 'Early starts preferred.' }
    ];
    const shifts = [
      ['s-mon-dock', 'Open the harbor', '2026-10-26', '08:00', '10:00', 'Dock lead', 1, 'Safety walk, radio check and visitor berths.'],
      ['s-mon-launch', 'Morning launch', '2026-10-26', '09:00', '12:00', 'Launch crew', 2, 'Ferry crew to moorings.'],
      ['s-mon-shore', 'Welcome desk', '2026-10-26', '10:00', '12:00', 'Shore support', 2, 'Visitor arrivals and tide-board updates.'],
      ['s-tue', 'Pontoon watch', '2026-10-27', '08:00', '11:00', 'Dock lead', 1, 'Check lines and keep access clear.'],
      ['s-wed', 'Shore tidy-up', '2026-10-28', '09:00', '12:00', 'Shore support', 2, 'Gloves and litter pickers in the shed.'],
      ['s-thu', 'Afternoon arrivals', '2026-10-29', '13:00', '16:00', 'Dock lead', 1, 'Meet visiting boats at the outer pontoon.'],
      ['s-fri', 'Mooring launch', '2026-10-30', '08:00', '11:00', 'Launch crew', 2, 'Check fuel before departure.'],
      ['s-sat-dock', 'Weekend harbor watch', '2026-10-31', '08:00', '12:00', 'Dock lead', 1, 'Busy morning; keep the radio close.'],
      ['s-sat-launch', 'Weekend launch', '2026-10-31', '09:00', '12:00', 'Launch crew', 2, 'Two trained crew needed.'],
      ['s-sun', 'Community quay', '2026-11-01', '10:00', '13:00', 'Shore support', 2, 'Help visitors and finish with a quay tidy.' ]
    ].map(([id, title, date, start, end, role, required, notes]) => ({ id, title, date, start, end, role, required, notes }));
    const assignments = [
      ['s-mon-dock', 'v-maya'], ['s-mon-launch', 'v-theo'], ['s-mon-shore', 'v-maya'], ['s-mon-shore', 'v-ben'],
      ['s-tue', 'v-ian'], ['s-wed', 'v-ben'], ['s-thu', 'v-nia'], ['s-fri', 'v-rose'],
      ['s-sat-dock', 'v-maya'], ['s-sat-launch', 'v-theo'], ['s-sun', 'v-nia']
    ].map(([shiftId, volunteerId], i) => ({ id: `a-${i + 1}`, shiftId, volunteerId }));
    return validateState({ version: 1, volunteers, shifts, assignments });
  }
  return Object.freeze({ ROLES, DAYS, SHIFT_DATE_MIN, SHIFT_DATE_MAX, dateOK, minutes, dayIndex, addDays, weekStart, overlaps, validateState, assignmentIssues, saveVolunteer, saveShift, saveAssignment, remove, copyWeek, coverage, demo });
});
