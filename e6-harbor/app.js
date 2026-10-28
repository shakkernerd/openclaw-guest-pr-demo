/* UI adapter: all schedule mutations go through the same tested domain API. */
(function () {
  'use strict';
  const C = window.HarborCore;
  const persistence = window.HarborStorage.open(() => window.localStorage);
  let state = persistence.state;
  let week = C.weekStart(state.shifts.map(s => s.date).sort()[0] || '2026-10-26');
  let view = 'schedule';
  let dialogKind = '';
  let dialogItem = '';
  let returnFocus = '';
  const $ = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const uid = prefix => prefix + '-' + (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const formatDate = (date, options) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', ...options });
  const option = (value, label, selected = false, disabled = false) => `<option value="${esc(value)}"${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}>${esc(label)}</option>`;
  const action = (name, id, label, classes = '', extra = '') => `<button type="button" data-action="${name}" data-id="${esc(id)}" data-focus="${esc(name + ':' + id)}" class="${classes}" ${extra}>${label}</button>`;
  function storageWarning(message) { $('storage-warning').textContent = message; $('storage-warning').hidden = !message; }
  function status(message) { $('status').textContent = message; }
  function dialogError(message) { $('dialog-error').textContent = message; $('dialog-error').hidden = false; $('dialog-error').focus(); }
  function clearDialogError() { $('dialog-error').hidden = true; $('dialog-error').textContent = ''; }
  function focusBack(key) {
    const target = key && document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
    (target || $(view === 'schedule' ? 'add-shift' : 'add-volunteer')).focus();
  }
  function commit(next, message) {
    const warning = persistence.save(next);
    state = next;
    storageWarning(warning);
    render();
    status(message + (warning ? ' Changed in this tab only—see the storage warning.' : ' Saved in this browser.'));
  }
  function shiftCard(s) {
    const crew = state.assignments.filter(a => a.shiftId === s.id).map(a => state.volunteers.find(v => v.id === a.volunteerId));
    const open = s.required - crew.length;
    return `<article class="shift-card" aria-labelledby="heading-${esc(s.id)}"><div class="card-top"><span class="time">${esc(s.start)}–${esc(s.end)}</span><span class="badge ${open ? 'open' : 'full'}">${open ? open + ' needed' : 'Covered'}</span></div><h3 id="heading-${esc(s.id)}">${esc(s.title)}</h3><span class="role-tag">${esc(s.role)} · ${crew.length}/${s.required} crew</span><ul class="crew-names" aria-label="Assigned crew and open places">${crew.map(v => `<li>${esc(v.name)}</li>`).join('')}${open ? `<li class="empty-slot">${open} open ${open === 1 ? 'place' : 'places'}</li>` : ''}</ul><div class="card-actions">${action('assign', s.id, open ? 'Assign crew' : 'Manage crew', 'small', `aria-label="Manage crew for ${esc(s.title)}"`)}${action('edit-shift', s.id, 'Edit shift', 'small edit-button', `aria-label="Edit ${esc(s.title)}"`)}</div></article>`;
  }
  function renderSchedule() {
    const end = C.addDays(week, 6);
    $('week-date').value = week;
    $('week-label').textContent = `${formatDate(week, { day: 'numeric', month: 'short' })} – ${formatDate(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const shifts = state.shifts.filter(s => s.date >= week && s.date <= end).sort((a, b) => (a.date + a.start + a.title).localeCompare(b.date + b.start + b.title));
    const c = C.coverage(state, shifts);
    $('metrics').innerHTML = `<div class="metric"><strong>${c.shifts}</strong><span>Shifts this week</span></div><div class="metric"><strong>${c.filled}<span> / ${c.required}</span></strong><span>Crew places filled</span></div><div class="metric ${c.open ? 'attention' : ''}"><strong>${c.open}</strong><span>Open crew places</span></div><div class="metric"><strong>${c.covered}<span> / ${c.shifts}</span></strong><span>Shifts fully covered</span></div>`;
    const role = $('role-filter').value;
    const onlyOpen = $('open-filter').checked;
    const shown = shifts.filter(s => (!role || role === s.role) && (!onlyOpen || C.coverage(state, [s]).open > 0));
    $('filter-summary').textContent = `Showing ${shown.length} of ${shifts.length} shifts · totals above cover the whole week`;
    $('schedule').innerHTML = (!shown.length ? `<div class="empty-state"><h3>${shifts.length ? 'No shifts match these filters' : 'A fresh week, ready to plan'}</h3><p>${shifts.length ? 'Try all roles or turn off the open-shifts filter.' : 'Add your first shift, or return to the demo week.'}</p>${shifts.length ? action('clear-filters', '', 'Clear filters') : action('new-shift', week, '+ Add a shift', 'primary')}</div>` : '') + Array.from({ length: 7 }, (_, day) => {
      const date = C.addDays(week, day);
      const daily = shown.filter(s => s.date === date);
      return `<section class="day" aria-labelledby="day-${date}"><h3 class="day-heading" id="day-${date}"><span class="weekday">${C.DAYS[day].slice(0, 3)}</span><span class="day-number">${Number(date.slice(8))}</span><span class="month">${formatDate(date, { month: 'short' })}</span></h3><div class="day-cards">${daily.length ? daily.map(shiftCard).join('') : `<p class="empty-day">${role || onlyOpen ? 'No matching shifts' : 'No shifts scheduled'}</p>`}</div></section>`;
    }).join('');
  }
  function renderVolunteers() {
    const query = $('crew-search').value.trim().toLocaleLowerCase();
    const crew = state.volunteers.filter(v => v.name.toLocaleLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name));
    $('volunteers').innerHTML = crew.length ? crew.map(v => {
      const count = state.assignments.filter(a => a.volunteerId === v.id).length;
      const initials = v.name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
      return `<article class="crew-card"><header><span class="initials" aria-hidden="true">${esc(initials)}</span><h2>${esc(v.name)}</h2></header><div class="role-list" aria-label="Eligible roles">${v.roles.map(r => `<span>${esc(r)}</span>`).join('')}</div><strong class="subtle">Weekly availability</strong><ul class="availability-list">${v.availability.length ? [...v.availability].sort((a, b) => a.day - b.day).map(a => `<li><span>${C.DAYS[a.day]}</span><span>${a.start}–${a.end}</span></li>`).join('') : '<li>No available days</li>'}</ul><p class="assignment-count">${count} assigned ${count === 1 ? 'shift' : 'shifts'} · all weeks</p>${v.notes ? `<p class="notes">${esc(v.notes)}</p>` : ''}<div class="card-actions">${action('edit-volunteer', v.id, 'Edit volunteer', 'small', `aria-label="Edit ${esc(v.name)}"`)}</div></article>`;
    }).join('') : '<div class="empty-state"><h3>No volunteers found</h3><p>Add a volunteer or try a different name.</p></div>';
  }
  function render() {
    $('crew-count').textContent = state.volunteers.length;
    $('schedule-view').hidden = view !== 'schedule';
    $('volunteers-view').hidden = view !== 'volunteers';
    for (const name of ['schedule', 'volunteers']) {
      if (view === name) $('nav-' + name).setAttribute('aria-current', 'page');
      else $('nav-' + name).removeAttribute('aria-current');
    }
    renderSchedule(); renderVolunteers();
  }
  function showDialog(title, kind, id, html) {
    dialogKind = kind; dialogItem = id;
    $('dialog-title').textContent = title;
    $('dialog-content').innerHTML = html;
    clearDialogError();
    $('dialog-status').textContent = '';
    if (!$('editor').open) $('editor').showModal();
    const target = $('dialog-content').querySelector('[autofocus], input:not([disabled]), select:not([disabled]), button');
    target?.focus();
  }
  const notesField = notes => `<div class="field full"><label for="notes">Notes <span class="subtle">(optional)</span></label><textarea id="notes" name="notes" maxlength="500">${esc(notes)}</textarea></div>`;
  const formActions = (kind, id) => `<div class="form-actions">${id ? action('delete-' + kind, id, 'Delete', 'danger') : ''}${action('close-dialog', '', 'Cancel')}<button type="submit" class="primary">Save ${kind}</button></div>`;
  function editShift(id, date = week) {
    const s = state.shifts.find(x => x.id === id) || { title: '', date, start: '09:00', end: '12:00', role: C.ROLES[0], required: 1, notes: '' };
    showDialog(id ? 'Edit shift' : 'Add a shift', 'shift', id, `<p class="help">One role per shift. Times are harbor-local, on the same day. Existing crew must still be eligible and conflict-free after an edit.</p><form id="shift-form"><div class="form-grid"><div class="field full"><label for="shift-title">Shift title</label><input id="shift-title" name="title" value="${esc(s.title)}" maxlength="80" required autofocus></div><div class="field full"><label for="shift-date">Date</label><input id="shift-date" name="date" type="date" value="${s.date}" min="${C.SHIFT_DATE_MIN}" max="${C.SHIFT_DATE_MAX}" required></div><div class="field"><label for="shift-start">Start time</label><input id="shift-start" name="start" type="time" value="${s.start}" required></div><div class="field"><label for="shift-end">End time</label><input id="shift-end" name="end" type="time" value="${s.end}" required></div><div class="field"><label for="shift-role">Required role</label><select id="shift-role" name="role">${C.ROLES.map(r => option(r, r, s.role === r)).join('')}</select></div><div class="field"><label for="shift-required">Crew needed</label><input id="shift-required" name="required" type="number" value="${s.required}" min="1" max="20" step="1" required></div>${notesField(s.notes)}</div>${formActions('shift', id)}</form>`);
  }
  function editVolunteer(id) {
    const v = state.volunteers.find(x => x.id === id) || { name: '', roles: ['Shore support'], availability: [], notes: '' };
    showDialog(id ? 'Edit volunteer' : 'Add a volunteer', 'volunteer', id, `<p class="help">Choose eligible roles and weekly availability. Unchecked days are unavailable. Edits that invalidate an existing assignment are blocked—unassign that shift first.</p><form id="volunteer-form"><div class="field"><label for="volunteer-name">Full name</label><input id="volunteer-name" name="name" value="${esc(v.name)}" required maxlength="80" autofocus></div><fieldset><legend>Eligible roles (choose at least one)</legend><div class="roles-checks">${C.ROLES.map((r, i) => `<label class="check-label" for="role-${i}"><input id="role-${i}" type="checkbox" name="roles" value="${esc(r)}"${v.roles.includes(r) ? ' checked' : ''}>${esc(r)}</label>`).join('')}</div></fieldset><fieldset><legend>Weekly availability</legend><p class="help">One continuous window per day; it must cover the whole shift.</p>${C.DAYS.map((day, i) => {
      const a = v.availability.find(a => a.day === i);
      return `<div class="availability-row"><label class="check-label" for="day-${i}"><input id="day-${i}" name="day-${i}" type="checkbox" data-day="${i}"${a ? ' checked' : ''}>${day}</label><label for="start-${i}">${day.slice(0, 3)} from<input id="start-${i}" name="start-${i}" type="time" value="${a?.start || '08:00'}"${a ? ' required' : ' disabled'}></label><label for="end-${i}">${day.slice(0, 3)} until<input id="end-${i}" name="end-${i}" type="time" value="${a?.end || '17:00'}"${a ? ' required' : ' disabled'}></label></div>`;
    }).join('')}</fieldset>${notesField(v.notes)}${formActions('volunteer', id)}</form>`);
  }
  function manageCrew(id, message = '') {
    const s = state.shifts.find(x => x.id === id);
    const assigned = state.assignments.filter(a => a.shiftId === id);
    const candidates = [...state.volunteers].sort((a, b) => a.name.localeCompare(b.name)).map(v => ({ v, issues: C.assignmentIssues(state, id, v.id) }));
    const eligible = candidates.filter(c => !c.issues.length);
    showDialog('Crew · ' + s.title, 'assignment', id, `<p class="assignment-context">${formatDate(s.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${s.start}–${s.end}<br>${esc(s.role)} · <strong>${assigned.length}/${s.required} places filled</strong></p>${s.notes ? `<p class="dialog-note">${esc(s.notes)}</p>` : ''}<h3>Assigned crew</h3><ul class="assigned-list">${assigned.length ? assigned.map(a => { const v = state.volunteers.find(v => v.id === a.volunteerId); return `<li><strong>${esc(v.name)}</strong>${action('unassign', a.id, 'Remove', 'small danger', `aria-label="Remove ${esc(v.name)} from this shift"`)}</li>`; }).join('') : '<li>No crew assigned yet.</li>'}</ul><form id="assignment-form" class="assign-form"><div class="field"><label for="candidate">Add an eligible volunteer</label><select id="candidate" name="volunteerId" required${eligible.length ? '' : ' disabled'}>${option('', eligible.length ? 'Choose a volunteer…' : assigned.length >= s.required ? 'Shift full — remove someone to replace' : 'No eligible volunteers available')}${candidates.map(({ v, issues }) => option(v.id, v.name + (issues.length ? ' — ' + issues.join(' ') : ''), false, !!issues.length)).join('')}</select></div><button type="submit" class="primary"${eligible.length ? '' : ' disabled'}>Assign</button></form><p class="help">To replace someone, remove them and assign another volunteer. Back-to-back shifts are allowed; time overlaps are not.</p><details open><summary>Eligibility &amp; conflict checks</summary><ul class="candidate-list">${candidates.map(({ v, issues }) => `<li class="${issues.length ? 'blocked' : 'eligible'}"><strong>${esc(v.name)}</strong>${issues.length ? esc(issues.join(' ')) : '✓ Eligible and available'}</li>`).join('') || '<li>Add volunteers in the Volunteers section first.</li>'}</ul></details><div class="form-actions">${action('close-dialog', '', 'Done', 'primary')}</div>`);
    // Never land on a destructive Remove button after opening or changing crew.
    $('dialog-status').textContent = message;
    ($('candidate').disabled ? $('dialog-content').querySelector('[data-action="close-dialog"]') : $('candidate')).focus();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const name = button.dataset.action; const id = button.dataset.id || '';
    if (!$('editor').open) returnFocus = button.dataset.focus || '';
    try {
      if (name === 'schedule' || name === 'volunteers') { view = name; render(); }
      else if (name === 'prev-week' || name === 'next-week') { const nextWeek = C.addDays(week, name === 'prev-week' ? -7 : 7); C.addDays(nextWeek, 6); week = nextWeek; render(); status('Showing week of ' + week + '.'); }
      else if (name === 'demo-week') { week = '2026-10-26'; render(); status('Showing the demo week. Your edits have been kept.'); }
      else if (name === 'clear-filters') { $('role-filter').value = ''; $('open-filter').checked = false; render(); $('role-filter').focus(); }
      else if (name === 'new-shift') editShift('', id || week);
      else if (name === 'edit-shift') editShift(id);
      else if (name === 'new-volunteer') editVolunteer('');
      else if (name === 'edit-volunteer') editVolunteer(id);
      else if (name === 'assign') manageCrew(id);
      else if (name === 'close-dialog') $('editor').close();
      else if (name === 'unassign') {
        commit(C.remove(state, 'assignments', id), 'Volunteer removed from shift.');
        manageCrew(dialogItem, $('status').textContent);
      } else if (name === 'delete-shift' || name === 'delete-volunteer') {
        const collection = name === 'delete-shift' ? 'shifts' : 'volunteers';
        const item = state[collection].find(x => x.id === id);
        const count = state.assignments.filter(a => (collection === 'shifts' ? a.shiftId : a.volunteerId) === id).length;
        if (window.confirm(`Delete ${item.title || item.name}? This also removes ${count} assignment(s). This cannot be undone.`)) {
          commit(C.remove(state, collection, id), `${collection === 'shifts' ? 'Shift' : 'Volunteer'} deleted.`);
          $('editor').close();
        }
      }
    } catch (error) { if ($('editor').open) dialogError(error.message); else status(error.message); }
  });
  $('editor').addEventListener('close', () => focusBack(returnFocus));
  // Native modality makes the background inert; wrap Tab explicitly so focus
  // does not escape to browser chrome at the dialog's final control.
  $('editor').addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...$('editor').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(el => el.getClientRects().length);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener('submit', event => {
    if (!['shift-form', 'volunteer-form', 'assignment-form'].includes(event.target.id)) return;
    event.preventDefault(); clearDialogError();
    const data = new FormData(event.target);
    try {
      if (dialogKind === 'shift') {
        const s = { id: dialogItem || uid('s'), title: data.get('title').trim(), date: data.get('date'), start: data.get('start'), end: data.get('end'), role: data.get('role'), required: Number(data.get('required')), notes: data.get('notes').trim() };
        const next = C.saveShift(state, s);
        week = C.weekStart(s.date);
        $('role-filter').value = ''; $('open-filter').checked = false;
        commit(next, 'Shift saved.'); $('editor').close();
      } else if (dialogKind === 'volunteer') {
        const availability = C.DAYS.flatMap((_, day) => data.has('day-' + day) ? [{ day, start: data.get('start-' + day), end: data.get('end-' + day) }] : []);
        const v = { id: dialogItem || uid('v'), name: data.get('name').trim(), roles: data.getAll('roles'), availability, notes: data.get('notes').trim() };
        const next = C.saveVolunteer(state, v);
        $('crew-search').value = '';
        commit(next, 'Volunteer saved.'); $('editor').close();
      } else {
        commit(C.saveAssignment(state, { id: uid('a'), shiftId: dialogItem, volunteerId: data.get('volunteerId') }), 'Volunteer assigned.');
        manageCrew(dialogItem, $('status').textContent);
      }
    } catch (error) { dialogError(error.message); }
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-day]')) {
      const day = event.target.dataset.day;
      for (const prefix of ['start-', 'end-']) { $(prefix + day).disabled = !event.target.checked; $(prefix + day).required = event.target.checked; }
    }
  });
  $('week-date').addEventListener('change', () => {
    try {
      if (!$('week-date').value || !$('week-date').checkValidity()) throw new Error(`Choose a date between ${C.SHIFT_DATE_MIN} and ${C.SHIFT_DATE_MAX}.`);
      week = C.weekStart($('week-date').value); renderSchedule(); status('Showing week of ' + week + '.');
    } catch (error) { $('week-date').value = week; status(error.message); }
  });
  $('role-filter').addEventListener('change', renderSchedule);
  $('open-filter').addEventListener('change', renderSchedule);
  $('crew-search').addEventListener('input', renderVolunteers);
  window.addEventListener('storage', event => {
    if (event.key === window.HarborStorage.KEY || event.key === null) storageWarning('Another tab changed the saved rota. Reload before editing to avoid working from an old version.');
  });
  $('role-filter').insertAdjacentHTML('beforeend', C.ROLES.map(r => option(r, r)).join(''));
  $('week-date').min = C.SHIFT_DATE_MIN; $('week-date').max = C.SHIFT_DATE_MAX;
  storageWarning(persistence.warning); render();
  status(persistence.warning ? 'Temporary rota loaded. Changes may not survive reload; see the storage warning.' : 'Rota ready. Changes are saved in this browser.');
})();
