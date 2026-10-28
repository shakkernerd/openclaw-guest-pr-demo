/** DOM-free lossless rota interchange. See README for the v1 schema. */
export const CSV_COLUMNS = ['record_type', 'volunteer_id', 'volunteer_name', 'shift_id', 'date', 'start', 'end', 'role'];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const emptyRota = () => ({ version: 1, volunteers: [], shifts: [] });
const fail = message => { throw new Error(message); };
const object = (value, path, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object.`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) fail(`${path}: unsupported field(s): ${extra.join(', ')}. Nothing was imported.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required.`);
};
const requiredText = (value, path) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be non-empty text.`);
  if (!value.isWellFormed()) fail(`${path} contains an unpaired Unicode surrogate; use valid Unicode text.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) fail(`${path} contains unsupported control characters.`);
};
const id = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) fail(`${path} must be 1–80 letters, digits, dots, underscores or hyphens, starting with a letter or digit.`);
};
export function validateRota(value) {
  object(value, 'Rota', ['version', 'volunteers', 'shifts']);
  if (value.version !== 1) fail('Unsupported rota version. Expected version 1.');
  if (!Array.isArray(value.volunteers) || !Array.isArray(value.shifts)) fail('volunteers and shifts must be arrays.');
  const volunteers = new Set();
  value.volunteers.forEach((v, i) => {
    const path = `Volunteer ${i + 1}`;
    object(v, path, ['id', 'name']); id(v.id, `${path}.id`); requiredText(v.name, `${path}.name`);
    if (volunteers.has(v.id)) fail(`${path}: duplicate volunteer ID "${v.id}".`);
    volunteers.add(v.id);
  });
  const shifts = new Set();
  value.shifts.forEach((s, i) => {
    const path = `Shift ${i + 1}`;
    object(s, path, ['id', 'date', 'start', 'end', 'role', 'volunteerIds']); id(s.id, `${path}.id`);
    if (shifts.has(s.id)) fail(`${path}: duplicate shift ID "${s.id}".`);
    shifts.add(s.id);
    if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || s.date.startsWith('0000')) fail(`${path}.date must be YYYY-MM-DD.`);
    const parsed = new Date(`${s.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s.date) fail(`${path}.date is not a real calendar date.`);
    for (const key of ['start', 'end']) if (typeof s[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s[key])) fail(`${path}.${key} must be a 24-hour HH:mm time.`);
    if (s.end <= s.start) fail(`${path}: end must be after start on the same date. Split overnight shifts across dates.`);
    requiredText(s.role, `${path}.role`);
    if (!Array.isArray(s.volunteerIds)) fail(`${path}.volunteerIds must be an array.`);
    const assigned = new Set();
    s.volunteerIds.forEach(v => {
      id(v, `${path}.volunteerIds`);
      if (!volunteers.has(v)) fail(`${path}: unknown volunteer ID "${v}".`);
      if (assigned.has(v)) fail(`${path}: duplicate assignment for "${v}".`);
      assigned.add(v);
    });
  });
  return structuredClone(value);
}

/** Strict RFC-4180-style CSV, including newlines inside quoted cells. */
export function parseCSV(text) {
  if (typeof text !== 'string') fail('CSV input must be text.');
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', state = 'start', line = 1;
  const pushCell = () => { row.push(cell); cell = ''; state = 'start'; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else state = 'closed';
      } else { cell += ch; if (ch === '\n') line++; }
      continue;
    }
    if (ch === ',') { pushCell(); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRow(); line++; continue;
    }
    if (state === 'closed') fail(`CSV line ${line}: unexpected character after closing quote.`);
    if (ch === '"') {
      if (state !== 'start') fail(`CSV line ${line}: quotes must start at the beginning of a cell.`);
      state = 'quoted';
    } else { state = 'plain'; cell += ch; }
  }
  if (state === 'quoted') fail(`CSV line ${line}: unclosed quoted cell.`);
  if (row.length || cell.length || state !== 'start') pushRow();
  return rows;
}
export function importCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) fail('CSV is empty. Download the example to see the required header.');
  const header = rows.shift();
  if (header.length !== CSV_COLUMNS.length || new Set(header).size !== header.length || CSV_COLUMNS.some(key => !header.includes(key))) fail(`CSV header must contain exactly: ${CSV_COLUMNS.join(',')}. Download the example for the format.`);
  const rota = emptyRota(), assignments = [];
  rows.forEach((cells, i) => {
    const location = `CSV record ${i + 2}`;
    if (cells.length !== header.length) fail(`${location}: expected ${header.length} cells, got ${cells.length}.`);
    const r = Object.fromEntries(header.map((key, j) => [key, cells[j]]));
    const allowed = { volunteer: ['volunteer_id', 'volunteer_name'], shift: ['shift_id', 'date', 'start', 'end', 'role'], assignment: ['volunteer_id', 'shift_id'] };
    if (!Object.hasOwn(allowed, r.record_type)) fail(`${location}: record_type must be volunteer, shift or assignment.`);
    for (const key of CSV_COLUMNS.slice(1)) if (!allowed[r.record_type].includes(key) && r[key] !== '') fail(`${location}: ${key} must be empty for a ${r.record_type} record; refusing to discard data.`);
    if (r.record_type === 'volunteer') rota.volunteers.push({ id: r.volunteer_id, name: r.volunteer_name });
    if (r.record_type === 'shift') rota.shifts.push({ id: r.shift_id, date: r.date, start: r.start, end: r.end, role: r.role, volunteerIds: [] });
    if (r.record_type === 'assignment') assignments.push({ volunteerId: r.volunteer_id, shiftId: r.shift_id, location });
  });
  const shifts = new Map(rota.shifts.map(s => [s.id, s]));
  for (const a of assignments) {
    if (!shifts.has(a.shiftId)) fail(`${a.location}: unknown shift ID "${a.shiftId}".`);
    shifts.get(a.shiftId).volunteerIds.push(a.volunteerId);
  }
  return validateRota(rota);
}
// JSON.parse keeps only the last duplicate key. Reject ambiguity rather than lose data.
function rejectDuplicateJSONKeys(text) {
  const stack = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],]/g)) {
    const token = match[0];
    if (token === '{') stack.push({ keys: new Set(), expectingKey: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (stack.at(-1)) stack.at(-1).expectingKey = true; }
    else if (stack.at(-1)?.expectingKey) {
      const current = stack.at(-1), key = JSON.parse(token);
      if (current.keys.has(key)) fail(`JSON contains duplicate field "${key}". Keep one value per field.`);
      current.keys.add(key); current.expectingKey = false;
    }
  }
}
export function importRota(text, format) {
  if (typeof text !== 'string') fail('The file could not be read as text.');
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) fail('File is too large. Maximum size is 2 MiB.');
  if (format === 'csv') return importCSV(text);
  if (format !== 'json') fail('Choose a .csv or .json file.');
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('Malformed JSON. Check commas, double quotes and closing brackets.'); }
  rejectDuplicateJSONKeys(text);
  return validateRota(value);
}
const withinFileLimit = text => new TextEncoder().encode(text).byteLength <= MAX_FILE_BYTES;
function csvText(data, lineEnding = '\r\n', finalLineEnding = true) {
  const rows = [CSV_COLUMNS];
  data.volunteers.forEach(v => rows.push(['volunteer', v.id, v.name, '', '', '', '', '']));
  data.shifts.forEach(s => rows.push(['shift', '', '', s.id, s.date, s.start, s.end, s.role]));
  data.shifts.forEach(s => s.volunteerIds.forEach(v => rows.push(['assignment', v, '', s.id, '', '', '', ''])));
  const escape = value => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return rows.map(row => row.map(escape).join(',')).join(lineEnding) + (finalLineEnding ? lineEnding : '');
}
function exportSizeError(data, format) {
  const other = format === 'JSON' ? 'CSV' : 'JSON';
  const alternative = other === 'JSON' ? JSON.stringify(data) : csvText(data, '\n', false);
  if (withinFileLimit(alternative)) fail(format + ' export would exceed 2 MiB and could not be reimported. Choose Export ' + other + ' instead; it preserves all rota data. No file was downloaded.');
  fail('This rota exceeds the 2 MiB archive capacity in both formats. Shorten the data before exporting. No file was downloaded.');
}
export function exportJSON(rota) {
  const data = validateRota(rota), readable = JSON.stringify(data, null, 2) + '\n';
  if (withinFileLimit(readable)) return readable;
  // Formatting must never turn an otherwise restorable archive into an unusable file.
  const compact = JSON.stringify(data);
  if (withinFileLimit(compact)) return compact;
  exportSizeError(data, 'JSON');
}
export function exportCSV(rota) {
  const data = validateRota(rota), standard = csvText(data);
  if (withinFileLimit(standard)) return standard;
  // Only record separators change; CR/LF inside quoted fields remain verbatim.
  const compact = csvText(data, '\n', false);
  if (withinFileLimit(compact)) return compact;
  exportSizeError(data, 'CSV');
}
/** All v1 values and ordering, independent of object key order or export capacity. */
export function rotaFingerprint(rota) {
  const data = validateRota(rota);
  return JSON.stringify([data.version, data.volunteers.map(v => [v.id, v.name]), data.shifts.map(s => [s.id, s.date, s.start, s.end, s.role, s.volunteerIds])]);
}
function archiveReady(rota) {
  const data = validateRota(rota);
  if (withinFileLimit(JSON.stringify(data)) || withinFileLimit(csvText(data, '\n', false))) return data;
  fail('Change not saved: the rota would exceed the 2 MiB archive capacity in both CSV and JSON. Shorten the added text or reduce the records; your current rota is unchanged.');
}
/** Atomic state boundary: every committed rota has at least one restorable archive. */
export function createRotaStore(initial = emptyRota()) {
  let current = archiveReady(initial);
  return {
    snapshot: () => structuredClone(current),
    replace(candidate) { const next = archiveReady(candidate); current = next; return this.snapshot(); },
    import(text, format) { const next = importRota(text, format); return this.replace(next); },
    update(mutator) { const next = structuredClone(current); mutator(next); return this.replace(next); }
  };
}
export function newId(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
