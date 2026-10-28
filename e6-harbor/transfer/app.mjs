import { createRotaStore, importRota, exportCSV, exportJSON, rotaFingerprint, newId, MAX_FILE_BYTES } from './rota.mjs';

const $ = selector => document.querySelector(selector);
const store = createRotaStore();
let previous = null, pending = null, importTicket = 0, dirty = false, editing = null;
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const announce = message => { $('#notice').textContent = message; $('#notice').hidden = false; $('#error').hidden = true; };
const showError = error => { $('#error').textContent = `${error.message} Your current rota is unchanged.`; $('#error').hidden = false; $('#notice').hidden = true; $('#error').focus(); };
function clearPending() { pending = null; importTicket++; $('#preview').hidden = true; }
function commit(next, message) {
  const before = store.snapshot();
  // Compare all v1 values and ordering, even when one export format is too large.
  // Inspection-only saves must not consume meaningful undo history.
  if (rotaFingerprint(next) === rotaFingerprint(before)) {
    clearPending(); announce('Rota unchanged. No undo history was replaced.'); return;
  }
  store.replace(next); // Validate everything before replacing anything.
  previous = before; dirty = true; clearPending(); render(); announce(message);
}
function stage(next, source) {
  pending = next;
  $('#preview-summary').textContent = `${source}: ${next.volunteers.length} volunteers, ${next.shifts.length} shifts, ${next.shifts.reduce((n, s) => n + s.volunteerIds.length, 0)} assignments. No changes have been made yet.`;
  $('#preview').hidden = false; $('#error').hidden = true; $('#notice').hidden = true;
  $('#preview-title').focus();
}
function editButton(kind, record, title) {
  const button = node('button', 'Edit', 'edit-button'); button.type = 'button';
  button.setAttribute('aria-label', `Edit ${kind}: ${title}`);
  button.dataset.kind = kind; button.dataset.id = record.id;
  button.addEventListener('click', () => openEditor(kind, record.id)); return button;
}
function render() {
  const rota = store.snapshot();
  const lookup = new Map(rota.volunteers.map(v => [v.id, v.name]));
  const query = $('#search').value.toLocaleLowerCase().trim();
  const includes = values => values.join(' ').toLocaleLowerCase().includes(query);
  const volunteers = rota.volunteers.filter(v => includes([v.name, v.id, ...rota.shifts.filter(s => s.volunteerIds.includes(v.id)).flatMap(s => [s.role, s.date, s.id])]));
  const shifts = rota.shifts.filter(s => includes([s.id, s.role, s.date, ...s.volunteerIds.flatMap(id => [id, lookup.get(id)])]));
  $('#volunteer-count').textContent = rota.volunteers.length; $('#shift-count').textContent = rota.shifts.length;
  $('#assignment-count').textContent = rota.shifts.reduce((n, s) => n + s.volunteerIds.length, 0);
  $('#open-count').textContent = rota.shifts.filter(s => !s.volunteerIds.length).length;
  $('#empty').hidden = !!(rota.volunteers.length || rota.shifts.length);
  $('#undo').disabled = !previous;
  $('#results-summary').textContent = `Showing ${volunteers.length} of ${rota.volunteers.length} volunteers and ${shifts.length} of ${rota.shifts.length} shifts.`;
  const vList = $('#volunteers'), sList = $('#shifts'); vList.replaceChildren(); sList.replaceChildren();
  volunteers.forEach(v => {
    const item = node('li', undefined, 'card'), top = node('div', undefined, 'card-heading');
    top.append(node('h4', v.name), editButton('volunteer', v, v.name));
    item.append(top, node('p', `ID: ${v.id}`, 'record-id'));
    const assigned = rota.shifts.filter(s => s.volunteerIds.includes(v.id));
    item.append(node('p', assigned.length ? `${assigned.length} assigned shift${assigned.length === 1 ? '' : 's'}` : 'No shifts assigned', 'badge'));
    if (assigned.length) { const list = node('ul', undefined, 'assignment-list'); assigned.forEach(s => list.append(node('li', `${s.date} · ${s.start}–${s.end} · ${s.role}`))); item.append(list); }
    vList.append(item);
  });
  [...shifts].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`)).forEach(s => {
    const item = node('li', undefined, 'card'), top = node('div', undefined, 'card-heading');
    top.append(node('h4', s.role), editButton('shift', s, `${s.role}, ${s.date}`));
    item.append(node('p', `${s.date} · ${s.start}–${s.end}`, 'shift-time'), top, node('p', `ID: ${s.id}`, 'record-id'));
    if (!s.volunteerIds.length) item.append(node('p', 'Unassigned · ready for a helping hand', 'badge open'));
    else { const list = node('ul', undefined, 'assignment-list'); s.volunteerIds.forEach(id => list.append(node('li', lookup.get(id)))); item.append(list); }
    sList.append(item);
  });
  if (!volunteers.length) vList.append(node('li', query ? 'No volunteers match. Try another search.' : 'No volunteers yet. Add a name to get started.', 'list-empty'));
  if (!shifts.length) sList.append(node('li', query ? 'No shifts match. Try another search.' : 'No shifts yet. Add the date, time and role of your first shift.', 'list-empty'));
}

$('#file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  clearPending(); if (!file) return; const ticket = importTicket;
  try {
    const format = file.name.split('.').pop().toLowerCase();
    if (!['csv', 'json'].includes(format)) throw new Error('Choose a .csv or .json file.');
    if (file.size > MAX_FILE_BYTES) throw new Error('File is too large. Maximum size is 2 MiB.');
    const bytes = await file.arrayBuffer();
    if (ticket !== importTicket) return;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('This file is not valid UTF-8. Save it as UTF-8 CSV or JSON and try again.'); }
    stage(importRota(text, format), file.name);
  } catch (error) { if (ticket === importTicket) showError(error); }
});
$('#sample').addEventListener('click', async () => {
  clearPending(); const ticket = importTicket;
  try {
    const response = await fetch('./examples/harbor-rota.json');
    if (!response.ok) throw new Error('The sample could not be loaded. Try downloading the example file.');
    const text = await response.text();
    if (ticket === importTicket) stage(importRota(text, 'json'), 'Fictional harbor crew');
  } catch (error) { if (ticket === importTicket) showError(error); }
});
$('#confirm-import').addEventListener('click', () => { if (pending) { commit(pending, 'Rota imported. Review the details below; export when ready.'); $('#rota').focus(); } });
$('#cancel-import').addEventListener('click', () => { clearPending(); announce('Import cancelled. Your current rota is unchanged.'); $('#file').focus(); });
$('#undo').addEventListener('click', () => {
  if (!previous) return; store.replace(previous); previous = null; dirty = true; clearPending(); render(); announce('Last change undone.'); $('#rota').focus();
});
$('#search').addEventListener('input', render);
for (const format of ['json', 'csv']) $('#export-' + format).addEventListener('click', () => {
  try {
    const text = format === 'json' ? exportJSON(store.snapshot()) : exportCSV(store.snapshot());
    const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' }));
    const a = node('a'); a.href = url; a.download = `harbor-rota.${format}`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    announce(`${format.toUpperCase()} download started. Keep the downloaded file before leaving this tab.`);
  } catch (error) { showError(error); }
});

const dialog = $('#editor'), fields = $('#editor-fields');
function field(labelText, key, type, value = '') {
  const wrap = node('div', undefined, 'field'), label = node('label', labelText); label.htmlFor = 'edit-' + key;
  const input = node(type === 'textarea' ? 'textarea' : 'input');
  input.id = label.htmlFor; input.name = key; input.required = true;
  if (type !== 'textarea') input.type = type; else input.rows = 2;
  input.value = value;
  // Textareas normalize line endings: retain original imported text if unchanged.
  input.originalText = value; input.initialValue = input.value;
  wrap.append(label, input); fields.append(wrap); return input;
}
function fieldValue(key) { const input = $('#edit-' + key); return input.value === input.initialValue ? input.originalText : input.value; }
function openEditor(kind, id = null) {
  const rota = store.snapshot(); const record = id ? rota[kind === 'volunteer' ? 'volunteers' : 'shifts'].find(r => r.id === id) : null;
  editing = { kind, id, record }; fields.replaceChildren();
  $('#editor-title').textContent = `${id ? 'Edit' : 'Add'} ${kind}`;
  $('#editor-id').textContent = id ? `Stable ID: ${id}. References are kept when details change.` : 'A stable ID will be created when you save.';
  $('#editor-error').hidden = true; $('#delete-confirmation').hidden = true; $('#remove-record').hidden = !id;
  if (kind === 'volunteer') field('Volunteer name', 'name', 'textarea', record?.name);
  else {
    field('Role / task', 'role', 'textarea', record?.role);
    field('Shift date', 'date', 'date', record?.date);
    field('Start time (harbor local time)', 'start', 'time', record?.start);
    field('End time (same date)', 'end', 'time', record?.end);
    const group = node('fieldset'); group.append(node('legend', 'Assigned volunteers'));
    group.append(node('p', 'Select any number of volunteers. Leave all unchecked for an unassigned shift.', 'help'));
    if (!rota.volunteers.length) group.append(node('p', 'Add volunteers first, then return here to assign them.'));
    rota.volunteers.forEach((v, i) => {
      const label = node('label', undefined, 'checkbox-row'), box = node('input'); box.type = 'checkbox'; box.name = 'volunteerIds'; box.value = v.id; box.id = 'assign-' + i; box.checked = !!record?.volunteerIds.includes(v.id);
      const text = node('span', v.name); text.append(node('small', `ID: ${v.id}`)); label.append(box, text); group.append(label);
    }); fields.append(group);
  }
  dialog.showModal(); fields.querySelector('input, textarea')?.focus();
}
function closeEditor() {
  const current = editing; dialog.close();
  const target = [...document.querySelectorAll('.edit-button')].find(b => b.dataset.kind === current?.kind && b.dataset.id === current?.id);
  (target || $('#add-' + (current?.kind || 'volunteer'))).focus(); editing = null;
}
$('#add-volunteer').addEventListener('click', () => openEditor('volunteer'));
$('#add-shift').addEventListener('click', () => openEditor('shift'));
$('#close-editor').addEventListener('click', closeEditor); $('#cancel-editor').addEventListener('click', closeEditor);
dialog.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
// Keep sequential keyboard navigation inside the editor, including at either edge.
dialog.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')].filter(el => el.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('#edit-form').addEventListener('submit', event => {
  event.preventDefault(); if (!editing) return;
  try {
    const { kind, id, record } = editing; const next = store.snapshot();
    const key = kind === 'volunteer' ? 'volunteers' : 'shifts';
    let replacement;
    if (kind === 'volunteer') replacement = { id: id || newId('v'), name: fieldValue('name') };
    else {
      const checked = [...fields.querySelectorAll('input[name=volunteerIds]:checked')].map(el => el.value);
      const original = record?.volunteerIds || [];
      const ordered = [...original.filter(id => checked.includes(id)), ...checked.filter(id => !original.includes(id))];
      replacement = { id: id || newId('s'), role: fieldValue('role'), date: fieldValue('date'), start: fieldValue('start'), end: fieldValue('end'), volunteerIds: ordered };
    }
    if (id) next[key][next[key].findIndex(r => r.id === id)] = replacement; else next[key].push(replacement);
    commit(next, `${kind === 'volunteer' ? 'Volunteer' : 'Shift'} saved. Export to keep your changes.`); closeEditor();
  } catch (error) { $('#editor-error').textContent = error.message; $('#editor-error').hidden = false; $('#editor-error').focus(); }
});
$('#remove-record').addEventListener('click', () => {
  const { kind, id } = editing;
  const count = kind === 'volunteer' ? store.snapshot().shifts.filter(s => s.volunteerIds.includes(id)).length : editing.record.volunteerIds.length;
  $('#delete-warning').textContent = kind === 'volunteer' ? `Remove this volunteer and their assignments in ${count} shift(s)? The shifts themselves will remain.` : `Remove this shift and its ${count} assignment(s)? The volunteers will remain.`;
  $('#delete-confirmation').hidden = false; $('#keep-record').focus();
});
$('#keep-record').addEventListener('click', () => { $('#delete-confirmation').hidden = true; $('#remove-record').focus(); });
$('#confirm-delete').addEventListener('click', () => {
  const { kind, id } = editing; const next = store.snapshot();
  if (kind === 'volunteer') { next.volunteers = next.volunteers.filter(v => v.id !== id); next.shifts.forEach(s => { s.volunteerIds = s.volunteerIds.filter(v => v !== id); }); }
  else next.shifts = next.shifts.filter(s => s.id !== id);
  commit(next, 'Record removed. Undo last change is available.'); closeEditor();
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
render();
