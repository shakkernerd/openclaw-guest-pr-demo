import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CSV_COLUMNS, MAX_FILE_BYTES, emptyRota, validateRota, parseCSV, importCSV, importRota, exportCSV, exportJSON, createRotaStore } from '../rota.mjs';
const example = JSON.parse(readFileSync(new URL('../examples/harbor-rota.json', import.meta.url), 'utf8'));
const header = CSV_COLUMNS.join(',');
const copy = () => structuredClone(example);
const roundTrip = data => { assert.deepEqual(importRota(exportJSON(data), 'json'), data); assert.deepEqual(importRota(exportCSV(data), 'csv'), data); };

test('both shipped examples describe the same complete rota', () => {
  assert.deepEqual(importCSV(readFileSync(new URL('../examples/harbor-rota.csv', import.meta.url), 'utf8')), example); roundTrip(example);
});
test('empty rota, volunteers without shifts and shifts without volunteers survive both formats', () => {
  roundTrip(emptyRota()); roundTrip({ version: 1, volunteers: example.volunteers, shifts: [] });
  roundTrip({ version: 1, volunteers: [], shifts: [{ ...example.shifts[0], volunteerIds: [] }] });
});
test('preserves quotes, commas, Unicode, emoji, whitespace and CR/LF in names and roles', () => {
  const data = copy();
  data.volunteers[0].name = '  Zoë, "Skipper" 🌊\r\n青井\nعائشة\r  ';
  data.shifts[0].role = 'Welcome, "crew"\r\nDock A';
  data.shifts[0].volunteerIds.reverse(); roundTrip(data);
  assert.match(exportCSV(data), /""Skipper""/);
});
test('same display name does not merge volunteers; stable IDs preserve assignments', () => {
  const data = copy(); data.volunteers[1].name = data.volunteers[0].name; roundTrip(data);
  assert.equal(importCSV(exportCSV(data)).volunteers.length, 4);
});
test('parser handles CRLF, LF, escaped quotes, trailing empty cells and BOM', () => {
  assert.deepEqual(parseCSV('\uFEFFa,b,c\r\n"x, y","say ""hi""\nnext",\r\n'), [['a', 'b', 'c'], ['x, y', 'say "hi"\nnext', '']]);
  assert.deepEqual(parseCSV('a,b,'), [['a', 'b', '']]);
  assert.deepEqual(parseCSV('""'), [['']]);
  assert.deepEqual(importRota('\uFEFF' + exportJSON(example), 'json'), example);
});
test('CSV columns and records may be reordered; forward assignment references resolve', () => {
  const rows = parseCSV(exportCSV(example)); const h = rows.shift();
  const reordered = [h.toReversed(), ...rows.toReversed().map(row => row.toReversed())];
  const encode = v => '"' + v.replaceAll('"', '""') + '"';
  const result = importCSV(reordered.map(row => row.map(encode).join(',')).join('\n'));
  assert.equal(result.volunteers.length, 4);
  assert.deepEqual(result.shifts.find(s => s.id === 's-welcome').volunteerIds, ['v-jose', 'v-mara']);
});
test('malformed CSV quoting reports a line instead of accepting partial cells', () => {
  for (const text of ['"unclosed', 'a"b,c', '"a"x,b', '"a" ,b']) assert.throws(() => parseCSV(text), /CSV line/);
});
test('missing, duplicate or unknown CSV columns are rejected', () => {
  for (const h of ['', 'name,date', header + ',extra', header.replace('role', 'date')]) assert.throws(() => importCSV(h), /empty|header/);
});
test('ragged rows, unknown record types and data in unused fields are rejected', () => {
  assert.throws(() => importCSV(header + '\nv,1'), /expected 8 cells/);
  assert.throws(() => importCSV(header + '\nother,,,,,,,'), /record_type/);
  assert.throws(() => importCSV(header + '\n__proto__,,,,,,,'), /record_type/);
  assert.throws(() => importCSV(header + '\nvolunteer,v,Name,s,,,,ignored'), /must be empty/);
  assert.throws(() => importCSV(header + '\nassignment,v,,missing,,,,'), /unknown shift/);
  assert.throws(() => importCSV(exportCSV(example) + '\r\n'), /expected 8 cells/);
});
test('invalid JSON, wrong shapes, versions, extra fields and non-string names are rejected', () => {
  assert.throws(() => importRota('{oops', 'json'), /Malformed JSON/);
  for (const data of [null, [], {}, { ...copy(), version: 2 }, { ...copy(), other: 'do not drop me' }, { ...copy(), volunteers: {} }]) assert.throws(() => validateRota(data));
  for (const name of [null, 123, '', '   ', '\u0000']) { const data = copy(); data.volunteers[0].name = name; assert.throws(() => validateRota(data)); }
  const data = copy(); data.volunteers[0].email = 'not silently discarded'; assert.throws(() => validateRota(data), /unsupported field/);
});
test('invalid IDs, duplicate identities and dangling or duplicate assignments are rejected', () => {
  const mutations = [
    d => { d.volunteers[0].id = ''; }, d => { d.volunteers[0].id = 'bad id'; },
    d => d.volunteers.push(d.volunteers[0]), d => d.shifts.push(d.shifts[0]),
    d => d.shifts[0].volunteerIds.push('missing'), d => d.shifts[0].volunteerIds.push('v-mara'),
    d => { d.shifts[0].volunteerIds = 'v-mara'; }, d => { delete d.shifts[0].role; }
  ];
  for (const mutate of mutations) { const data = copy(); mutate(data); assert.throws(() => validateRota(data)); }
  assert.throws(() => importCSV(exportCSV(example) + 'assignment,v-mara,,s-welcome,,,,\r\n'), /duplicate assignment/);
});
test('calendar dates are checked without timezone conversion', () => {
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-11-31', '26-01-01', '0000-01-01', '2026-11-07T00:00:00Z']) {
    const data = copy(); data.shifts[0].date = date; assert.throws(() => validateRota(data), /date/);
  }
  for (const date of ['2028-02-29', '0001-01-01', '9999-12-31']) { const data = copy(); data.shifts[0].date = date; roundTrip(data); }
});
test('invalid times, zero duration and overnight shifts fail clearly', () => {
  for (const [start, end] of [['24:00', '25:00'], ['8:00', '09:00'], ['08:60', '09:00'], ['12:00', '12:00'], ['23:00', '01:00']]) {
    const data = copy(); Object.assign(data.shifts[0], { start, end }); assert.throws(() => validateRota(data), /HH:mm|end must be after/);
  }
});
test('malformed imports leave the actual store and all nested records intact', () => {
  const store = createRotaStore(example);
  for (const [text, format] of [['{', 'json'], [header + '\ninvalid', 'csv'], [exportJSON(example).replace('v-mara', 'invalid id'), 'json'], ['whatever', 'xlsx']]) {
    assert.throws(() => store.import(text, format)); assert.deepEqual(store.snapshot(), example);
  }
  const next = copy(); next.volunteers[0].name = 'Corrected'; store.import(exportCSV(next), 'csv'); assert.deepEqual(store.snapshot(), next);
});
test('invalid edits are transactional; snapshots and inputs cannot mutate store', () => {
  const source = copy(); const store = createRotaStore(source); source.volunteers[0].name = 'Changed outside';
  const snapshot = store.snapshot(); snapshot.shifts[0].volunteerIds.length = 0;
  assert.deepEqual(store.snapshot(), example);
  assert.throws(() => store.update(d => { d.volunteers = []; })); assert.deepEqual(store.snapshot(), example);
  assert.throws(() => store.update(d => { d.volunteers.length = 0; throw new Error('interrupted'); })); assert.deepEqual(store.snapshot(), example);
});
test('corrections to names, dates, roles and assignment order survive export/import', () => {
  const store = createRotaStore(example);
  store.update(d => { d.volunteers[0].name = 'Renée "R"'; Object.assign(d.shifts[0], { date: '2028-02-29', start: '09:15', end: '11:45', role: 'Jetty, welcome', volunteerIds: ['v-aoi', 'v-mara'] }); });
  roundTrip(store.snapshot());
  assert.equal(store.snapshot().shifts[0].volunteerIds[1], 'v-mara');
});
test('oversize input and unsupported formats are rejected', () => {
  assert.throws(() => importRota(' '.repeat(MAX_FILE_BYTES + 1), 'json'), /too large/);
  assert.throws(() => importRota('🌊'.repeat(MAX_FILE_BYTES / 4 + 1), 'json'), /too large/);
  assert.throws(() => importRota('', 'xlsx'), /csv or .json/);
});
test('formula-looking names remain exact data; JSON is the safe archive choice', () => {
  const data = copy(); for (const name of ['=SUM(1,2)', '+name', '-name', '@name', '\t=1+1', '<img src=x onerror=alert(1)>']) { data.volunteers[0].name = name; roundTrip(data); }
});
test('deterministic varied Unicode and delimiter round trips', () => {
  const parts = ['A', ',', '"', '\n', '\r\n', 'é', '青', '🌊', ' ', '='];
  for (let i = 0; i < 120; i++) {
    const data = copy(); const text = Array.from({ length: 12 }, (_, j) => parts[(i * 7 + j * 3 + Math.floor(i / 10)) % parts.length]).join('');
    data.volunteers[0].name = 'Name ' + text; data.shifts[0].role = 'Role ' + text; roundTrip(data);
  }
});

test('duplicate JSON keys, including escaped spellings, cannot silently discard data', () => {
  const store = createRotaStore(example);
  for (const source of [
    exportJSON(example).replace('"version": 1', '"version": 2, "version": 1'),
    exportJSON(example).replace('"name":', '"name": "lost name", "name":'),
    exportJSON(example).replace('"name":', '"\\u006eame": "lost name", "name":')
  ]) { assert.throws(() => store.import(source, 'json'), /duplicate field/); assert.deepEqual(store.snapshot(), example); }
  const data = copy(); data.volunteers[0].name = 'Braces { "name": [one, two] }'; roundTrip(data);
});
test('unpaired Unicode surrogates are rejected before CSV encoding could replace them', () => {
  for (const text of ['\ud800', 'bad \udfff']) {
    const data = copy(); data.volunteers[0].name = text;
    assert.throws(() => importRota(JSON.stringify(data), 'json'), /Unicode/);
    assert.throws(() => exportCSV(data), /Unicode/);
  }
});

test('large ordinary-text JSON archives compact automatically and reimport', () => {
  const volunteers = Array.from({ length: 9000 }, (_, i) => ({ id: 'v-' + i, name: 'Harbor volunteer ' + i }));
  const shifts = volunteers.map((v, i) => ({ id: 's-' + i, date: '2026-11-07', start: '08:00', end: '10:30', role: 'Harbor welcome', volunteerIds: [v.id] }));
  const data = { version: 1, volunteers, shifts };
  const compact = JSON.stringify(data);
  assert.ok(Buffer.byteLength(compact) < MAX_FILE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(data, null, 2)) > MAX_FILE_BYTES);
  const exported = exportJSON(importRota(compact, 'json'));
  assert.ok(Buffer.byteLength(exported) <= MAX_FILE_BYTES);
  assert.deepEqual(importRota(exported, 'json'), data);
});
test('CSV-only large rota gets an explicit safe alternative, never an unrestorable JSON download', () => {
  const data = { version: 1, volunteers: [{ id: 'v-size', name: 'Name' + '\t'.repeat(1_100_000) }], shifts: [] };
  const csv = exportCSV(data);
  assert.ok(Buffer.byteLength(csv) < MAX_FILE_BYTES);
  const imported = importRota(csv, 'csv');
  assert.throws(() => exportJSON(imported), /Choose Export CSV instead.*No file was downloaded/);
  assert.deepEqual(importRota(exportCSV(imported), 'csv'), data);
  const store = createRotaStore(imported);
  store.update(d => { d.volunteers[0].name = 'Corrected'; });
  assert.equal(importRota(exportJSON(store.snapshot()), 'json').volunteers[0].name, 'Corrected');
});
test('JSON-only large assignment graph gets a reimportable JSON alternative to oversized CSV', () => {
  const volunteers = Array.from({ length: 100 }, (_, i) => ({ id: 'v-' + i, name: 'Volunteer ' + i }));
  const shifts = Array.from({ length: 500 }, (_, i) => ({ id: ('shift-' + i).padEnd(80, 'a'), date: '2026-11-07', start: '08:00', end: '10:30', role: 'Welcome', volunteerIds: volunteers.map(v => v.id) }));
  const data = { version: 1, volunteers, shifts };
  const json = exportJSON(data); assert.ok(Buffer.byteLength(json) <= MAX_FILE_BYTES);
  assert.throws(() => exportCSV(data), /Choose Export JSON instead/);
  assert.deepEqual(importRota(json, 'json'), data);
  const store = createRotaStore(data); store.update(d => { d.shifts[0].role = 'Corrected role'; });
  assert.equal(importRota(exportJSON(store.snapshot()), 'json').shifts[0].role, 'Corrected role');
});
test('CSV near the byte limit compacts record separators but preserves embedded CRLF', () => {
  const data = { version: 1, volunteers: Array.from({ length: 200 }, (_, i) => ({ id: 'v-' + i, name: 'Name\r\n' + i })), shifts: [{ id: 's', date: '2026-11-07', start: '08:00', end: '10:30', role: 'R', volunteerIds: [] }] };
  const base = Buffer.byteLength(exportCSV(data));
  data.shifts[0].role += 'x'.repeat(MAX_FILE_BYTES - base + 100);
  const exported = exportCSV(data);
  assert.ok(Buffer.byteLength(exported) <= MAX_FILE_BYTES);
  assert.ok(exported.includes('Name\r\n0'));
  assert.deepEqual(importRota(exported, 'csv'), data);
});
test('edits exceeding archive capacity in BOTH formats are atomic and rejected', () => {
  const store = createRotaStore(example), before = store.snapshot();
  assert.throws(() => store.update(d => { d.volunteers[0].name = 'x'.repeat(MAX_FILE_BYTES); }), /Change not saved.*both CSV and JSON/);
  assert.deepEqual(store.snapshot(), before);
  const tooBig = copy(); tooBig.volunteers[0].name = 'x'.repeat(MAX_FILE_BYTES);
  assert.throws(() => createRotaStore(tooBig), /archive capacity/);
});
