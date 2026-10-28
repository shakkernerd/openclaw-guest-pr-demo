/** Read-only compatibility challenge against the pinned scheduler modules. Not an adapter. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importRota, exportCSV, exportJSON, createRotaStore, validateRota } from './rota.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node e6-harbor/transfer/compatibility-check.mjs /path/to/pinned-scheduler/e6-harbor');
const root = path.resolve(directory);
const hashes = {
  'core.js': '7db1fb8707354c677f0a8a7796df628e80f80a0026ec41b322e1a3260b5971d0',
  'storage.js': '031957939e65bddaaf14150df5f60d0b7452332e93fe1602f5f190b96b1494ea'
};
for (const [name, expected] of Object.entries(hashes)) {
  assert.equal(createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex'), expected, name + ': not the reviewed PR #23 head 5cf53e2');
}
const require = createRequire(import.meta.url);
const Core = require(path.join(root, 'core.js'));
const Storage = require(path.join(root, 'storage.js'));
const source = Core.demo();
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
// This lossy projection exists ONLY inside this test to expose missing information.
// It is deliberately not exported, offered in the app, or claimed to be integration.
const project = state => ({ version: 1,
  volunteers: state.volunteers.map(({ id, name }) => ({ id, name })),
  shifts: state.shifts.map(({ id, date, start, end, role }) => ({ id, date, start, end, role,
    volunteerIds: state.assignments.filter(a => a.shiftId === id).map(a => a.volunteerId) }))
});
const common = project(source);
check('both native schemas reject the other format despite version:1', () => {
  assert.throws(() => importRota(JSON.stringify(source), 'json'), /unsupported field.*assignments/);
  assert.throws(() => Core.validateState(JSON.parse(exportJSON(common))), /Unrecognized rota data/);
});
check('scheduler snapshot rejection preserves an unexported transfer correction', () => {
  const store = createRotaStore(common);
  store.update(s => { s.volunteers[0].name = 'Zoë, "Skipper" 青井'; });
  const before = store.snapshot();
  assert.throws(() => store.import(JSON.stringify(source), 'json'), /unsupported field/);
  assert.deepEqual(store.snapshot(), before);
});
check('shared-field projection survives CSV and JSON but loses scheduling metadata', () => {
  for (const format of ['csv', 'json']) {
    const archived = format === 'csv' ? exportCSV(common) : exportJSON(common);
    assert.deepEqual(importRota(archived, format), common);
  }
  assert.equal(common.shifts.reduce((n, s) => n + s.volunteerIds.length, 0), source.assignments.length);
  assert.ok(source.volunteers[0].availability.length && source.volunteers[0].roles.length);
  assert.equal(common.volunteers[0].availability, undefined);
  assert.equal(common.volunteers[0].roles, undefined);
  assert.equal(common.volunteers[0].notes, undefined);
  assert.equal(common.shifts[0].title, undefined);
  assert.equal(common.shifts[0].required, undefined);
  assert.equal(common.shifts[0].notes, undefined);
  assert.equal(common.assignments, undefined); // Assignment IDs are absent, not recoverable from pair links.
});
check('adding scheduling metadata to companion data is rejected, not silently discarded', () => {
  const enriched = structuredClone(common);
  enriched.volunteers[0].availability = source.volunteers[0].availability;
  assert.throws(() => validateRota(enriched), /unsupported field.*availability/);
});
check('ID and text domains differ; a native scheduler-valid ID need not transfer', () => {
  const unusual = structuredClone(source);
  const id = unusual.volunteers[0].id;
  unusual.volunteers[0].id = 'crew 青井';
  unusual.assignments.forEach(a => { if (a.volunteerId === id) a.volunteerId = 'crew 青井'; });
  Core.validateState(unusual);
  assert.throws(() => validateRota(project(unusual)), /letters, digits/);
  const longName = structuredClone(common); longName.volunteers[0].name = 'N'.repeat(81);
  validateRota(longName);
  assert.throws(() => Core.saveVolunteer(source, { ...source.volunteers[0], name: longName.volunteers[0].name }), /maximum 80/);
});
check('free-text roles and wider dates cannot automatically become valid scheduler shifts', () => {
  const changed = structuredClone(common);
  changed.shifts[0].role = 'Quayside welcome'; changed.shifts[0].date = '1899-12-31';
  validateRota(changed);
  assert.throws(() => Core.saveShift(source, { ...source.shifts[0], role: changed.shifts[0].role }), /valid shift role/);
  assert.throws(() => Core.saveShift(source, { ...source.shifts[0], date: changed.shifts[0].date }), /valid shift date/);
});
check('scheduler qualification and availability must not be invented to accept assignments', () => {
  const assigned = source.assignments[0];
  const v = source.volunteers.find(v => v.id === assigned.volunteerId);
  assert.throws(() => Core.saveVolunteer(source, { ...v, availability: [] }), /Unavailable/);
  assert.throws(() => Core.saveVolunteer(source, { ...v, roles: ['Launch crew'] }), /Not eligible/);
  assert.deepEqual(Core.demo(), source, 'Rejected attempts did not mutate scheduling source');
});
check('hybrid metadata can pass scheduler validation while conflicting embedded links are ignored', () => {
  const hybrid = structuredClone(source);
  hybrid.shifts[0].volunteerIds = ['missing-person'];
  assert.equal(Core.validateState(hybrid), hybrid);
  // Thus simply adding the missing envelope fields is not a bridge: assignments are authoritative.
  assert.deepEqual(hybrid.assignments, source.assignments);
});
check('scheduler persistence refuses companion replacement without overwriting saved data', () => {
  let saved = JSON.stringify(source);
  const storage = Storage.open(() => ({ getItem: () => saved, setItem: (_, value) => { saved = value; } }));
  const before = saved;
  assert.throws(() => storage.save(common), /Unrecognized rota data/);
  assert.equal(saved, before);
  assert.equal(Storage.KEY, 'e6-harbor.rota.v1');
});
check('scheduler known-field edits do not preserve arbitrary per-record extensions', () => {
  const extended = structuredClone(source);
  extended.reviewExtension = 'root metadata';
  extended.volunteers[0].reviewExtension = 'person metadata';
  extended.volunteers[1].reviewExtension = 'untouched metadata';
  Core.validateState(extended);
  const { id, name, roles, availability, notes } = extended.volunteers[0];
  const changed = Core.saveVolunteer(extended, { id, name, roles, availability, notes });
  assert.equal(changed.volunteers[0].reviewExtension, undefined);
  assert.equal(changed.reviewExtension, 'root metadata');
  assert.equal(changed.volunteers[1].reviewExtension, 'untouched metadata');
  assert.equal(extended.volunteers[0].reviewExtension, 'person metadata', 'Input remains unmutated');
});
console.log(passed + '/10 compatibility checks passed. These assertions establish gaps, NOT working integration.');
