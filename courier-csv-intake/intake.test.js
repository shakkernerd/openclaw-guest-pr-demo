"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { auditExports, InputError } = require('./index.js');
const auditor = require('../parcel-event-audit');
const HEADERS = ['eventId', 'parcelId', 'type', 'occurredAt'];
const event = (changes = {}) => ({ eventId: 'e1', parcelId: 'p1', type: 'created', occurredAt: '2026-10-28T08:00:00Z', ...changes });
const quote = value => /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
const csv = (events, headers = HEADERS, ending = '\n') => [headers, ...events.map(event => headers.map(name => event[name] ?? ''))]
  .map(row => row.map(quote).join(',')).join(ending);
const source = (text, filename = 'input.csv') => ({ filename, bytes: Buffer.from(text) });
const audit = (events, headers) => auditExports([source(csv(events, headers))]);
const withoutSources = report => JSON.parse(JSON.stringify(report, (key, value) => key === 'sources' ? undefined : value));

function verifyEvidence(report, inputs) {
  for (const evidence of report.evidence) {
    const bytes = inputs.find(source => source.filename === evidence.filename).bytes;
    assert.deepEqual(Buffer.from(evidence.bytesBase64, 'base64'), bytes);
    assert.equal(evidence.byteLength, bytes.length);
    assert.equal(evidence.sha256, createHash('sha256').update(bytes).digest('hex'));
    const records = [evidence.header, ...evidence.records];
    assert.equal(records.map(record => record.raw + record.terminator).join(''), bytes.toString('utf8'));
    for (const record of records) {
      assert.equal(bytes.subarray(record.byteStart, record.byteEnd).toString('utf8'), record.raw);
      for (const field of record.fields) {
        assert.equal(bytes.subarray(field.byteStart, field.byteEnd).toString('utf8'), field.raw);
        for (const [offset, lineKey, columnKey] of [[field.byteStart, 'line', 'column'], [field.byteEnd, 'endLine', 'endColumn']]) {
          const prefix = bytes.subarray(0, offset);
          assert.equal(field[lineKey], 1 + [...prefix].filter(byte => byte === 10).length);
          assert.equal(field[columnKey], prefix.length - prefix.lastIndexOf(10));
        }
      }
    }
  }
  const events = report.audit.parcels.flatMap(parcel => parcel.timeline);
  for (const exception of report.audit.exceptions) events.push(...(exception.variants ?? [...exception.delivered, ...exception.cancelled]));
  for (const event of events) for (const ref of event.sources) {
    const record = report.evidence.find(evidence => evidence.filename === ref.filename).records.find(record => record.record === ref.record);
    for (const key of ['line', 'endLine', 'byteStart', 'byteEnd']) assert.equal(ref[key], record[key]);
    for (const [name, fieldRef] of Object.entries(ref.fields)) {
      const field = record.fields[fieldRef.index - 1];
      assert.equal(field.name, name);
      for (const [key, value] of Object.entries(fieldRef)) assert.equal(field[key], value);
      assert.equal(field.value, name === 'occurredAt' ? ref.occurredAt : event[name]);
    }
  }
}

test('quoted commas, quotes, newlines, Unicode and every extra column survive', () => {
  const headers = ['note', 'occurredAt', 'parcelId', 'type', 'eventId', '__proto__', 'constructor', ' space ', 'line\nheader'];
  const extras = Object.fromEntries([['__proto__', 'metadata'], ['constructor', 'untouched'], [' space ', ' padded '], ['line\nheader', '']]);
  const events = [event({ eventId: 'é,雪😀"id', parcelId: 'e\u0301', note: 'first, "quoted"\r\nsecond\nthird\rfourth\u0000', ...extras }), event({ eventId: 'last', note: '', ...extras })];
  const input = source(csv(events, headers, '\r\n') + '\r\n');
  const before = Buffer.from(input.bytes);
  const report = auditExports([input]);
  assert.deepEqual(input.bytes, before);
  assert.deepEqual(report.evidence[0].records.map(record => [record.record, record.line, record.endLine]), [[2, 3, 5], [3, 6, 6]]);
  assert.deepEqual(report.evidence[0].records[0].fields.map(field => field.value), headers.map(name => events[0][name]));
  verifyEvidence(report, [input]);
});

test('different courier metadata remains an auditor retry, with both originals retained', () => {
  const events = [event({ note: 'first' }), event({ occurredAt: '2026-10-28T09:00:00.000+01:00', note: 'DIFFERENT' })];
  const report = audit(events, [...HEADERS, 'note']);
  assert.equal(report.audit.summary.uniqueEvents, 1);
  assert.equal(report.audit.summary.retryDuplicates, 1);
  assert.equal(report.audit.summary.exceptions, 0);
  assert.equal(report.audit.parcels[0].timeline[0].sources.length, 2);
  assert.deepEqual(report.evidence[0].records.map(record => record.fields.at(-1).value), ['first', 'DIFFERENT']);
});

test('full and filtered semantics match unchanged auditor across retries, conflicts and contradictions', () => {
  const events = [event({ eventId: 'clean', parcelId: 'CLEAN' }), event({ eventId: 'seed', parcelId: 'LEFT' }),
    event({ eventId: 'shared', parcelId: 'LEFT', type: 'delivered' }),
    event({ eventId: 'shared', parcelId: 'RIGHT', type: 'cancelled' }),
    event({ eventId: 'cancel', parcelId: 'LEFT', type: 'cancelled', occurredAt: '2026-10-28T07:00:00Z' }),
    event({ eventId: 'shared', parcelId: 'LEFT', type: 'delivered', occurredAt: '2026-10-28T09:00:00+01:00' }),
    event({ eventId: 'other-delivery', parcelId: 'LEFT', type: 'delivered' }),
    event({ eventId: 'retry-only', parcelId: 'RETRY' }), event({ eventId: 'retry-only', parcelId: 'RETRY' }),
    event({ eventId: 'shared', parcelId: 'RIGHT', type: 'cancelled', occurredAt: '2026-10-28T08:00:00.001Z' })];
  const inputs = [source(csv(events.slice(0, 5)), 'z.csv'), source(csv(events.slice(5)), 'a.csv')];
  for (const exceptionsOnly of [false, true]) {
    const options = { exceptionsOnly };
    const report = auditExports(inputs, options);
    const direct = auditor.auditExports([{ filename: 'direct', text: events.map(event => JSON.stringify(event)).join('\n') }], options);
    assert.deepEqual(withoutSources(report.audit), withoutSources(direct));
    assert.equal(JSON.stringify(report), JSON.stringify(auditExports(inputs.toReversed(), options)));
    verifyEvidence(report, inputs);
    assert.equal(report.evidence.reduce((count, file) => count + file.records.length, 0), events.length);
  }
  const full = auditExports(inputs), filtered = auditExports(inputs, { exceptionsOnly: true });
  assert.deepEqual(filtered.evidence, full.evidence);
  assert.deepEqual(filtered.audit.exceptions, full.audit.exceptions);
  assert.deepEqual(filtered.audit.parcels, full.audit.parcels.filter(parcel => ['LEFT', 'RIGHT'].includes(parcel.parcelId)));
});

test('no trimming, Unicode normalization, case folding or unknown type guessing', () => {
  assert.equal(audit([event({ eventId: 'é' }), event({ eventId: 'e\u0301' }), event({ eventId: 'É' })]).audit.summary.uniqueEvents, 3);
  for (const changes of [{ eventId: ' x' }, { parcelId: 'x ' }, { eventId: '' }, { parcelId: 'x\ny' },
    { eventId: '\u007f' }, { type: 'DELIVERED' }, { type: 'unknown' }, { type: ' delivered' }]) {
    assert.throws(() => audit([event(changes)]), InputError);
  }
});

for (const occurredAt of ['2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
  '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00-00:00',
  '2026-01-01T00:00:00', '2026-01-01t00:00:00z', '2026-01-01T00:00:00.1234Z',
  '0000-01-01T00:00:00Z', '0001-01-01T00:00:00+01:00', '9999-12-31T23:00:00-02:00']) {
  test('auditor rejects ' + occurredAt + ' at original CSV field', () => {
    const text = csv([event({ note: 'one\ntwo' }), event({ occurredAt, note: 'three\nfour' })], ['note', ...HEADERS]);
    assert.throws(() => auditExports([source(text)]), error => {
      assert.ok(error instanceof InputError);
      assert.equal(error.record, 3); assert.equal(error.line, 5);
      assert.equal(error.fieldIndex, 5); assert.equal(error.fieldName, 'occurredAt');
      assert.equal(error.byteOffset, Buffer.byteLength(text.slice(0, text.lastIndexOf(occurredAt))));
      return true;
    });
  });
}

test('valid timestamp boundaries and fractions are delegated exactly', () => {
  for (const occurredAt of ['0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z',
    '2000-02-29T00:00:00+23:59', '2024-03-01T00:30:00+01:00', '2026-01-01T00:00:00.1Z', '2026-01-01T00:00:00.12+00:00']) {
    const expected = auditor.auditExports([{ filename: 'x', text: JSON.stringify(event({ occurredAt })) }]);
    assert.deepEqual(withoutSources(audit([event({ occurredAt })]).audit), withoutSources(expected));
  }
});

for (const [name, text, reason] of [
  ['empty', '', /missing CSV header/], ['BOM', '\ufeff' + csv([]), /BOM/],
  ['wrong case', csv([]).replace('eventId', 'EventId'), /missing required header/],
  ['padded required header', csv([]).replace('eventId', ' eventId'), /missing required header/],
  ['empty header', csv([]) + ',', /header names must not be empty/],
  ['duplicate required header', csv([]) + ',eventId', /duplicate header/],
  ['duplicate extra header', csv([]) + ',note,note', /duplicate header/],
  ['no header', 'e,p,created,2026-10-28T00:00:00Z', /missing required header/],
  ['short row', csv([]) + '\ne,p,created', /expected 4 fields, received 3/],
  ['long row', csv([event()]) + ',extra', /expected 4 fields, received 5/],
  ['blank row', csv([event()]) + '\n\n', /expected 4 fields, received 1/],
  ['bare CR separator', csv([]) + '\rx', /bare CR/],
  ['unquoted quote', csv([]) + '\ne"x,p,created,t', /quote inside/],
  ['unclosed quote', csv([]) + '\n"e\nx', /unterminated/],
  ['post quote space', csv([]) + '\n"e" ,p,created,t', /after closing quote/],
  ['post quote text', csv([]) + '\n"e"x,p,created,t', /after closing quote/]]) {
  test('rejects ' + name + ' with location', () => {
    assert.throws(() => auditExports([source(text)]), error => {
      assert.ok(error instanceof InputError); assert.match(error.reason, reason);
      assert.equal(error.filename, 'input.csv');
      assert.ok(error.record >= 1 && error.line >= 1 && error.column >= 1 && error.byteOffset >= 0);
      return true;
    });
  });
}

test('empty extra cells, final newline and header-only are explicit', () => {
  for (const ending of ['', '\n', '\r\n']) {
    const empty = auditExports([source(csv([]) + ending)]);
    assert.equal(empty.audit.summary.inputRecords, 0); verifyEvidence(empty, [source(csv([]) + ending)]);
    const input = source(csv([event()], [...HEADERS, 'empty']) + ending);
    const report = auditExports([input]);
    assert.equal(report.evidence[0].records[0].fields.at(-1).value, ''); verifyEvidence(report, [input]);
  }
  assert.equal(auditExports([source(csv([event()], [...HEADERS, 'empty']) + '""')]).evidence[0].records[0].fields.at(-1).value, '');
  assert.equal(auditExports([source(csv([]))], { exceptionsOnly: true }).audit.view, 'exceptions-only');
});

test('invalid UTF-8 is located in unknown fields and headers, never replaced', () => {
  const prefix = Buffer.from(csv([], [...HEADERS, 'note']) + '\ne,p,created,2026-10-28T08:00:00Z,');
  for (const invalid of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf4, 0x90, 0x80, 0x80]]) {
    assert.throws(() => auditExports([{ filename: 'bytes.csv', bytes: Buffer.concat([prefix, Buffer.from(invalid)]) }]), error => {
      assert.equal(error.record, 2); assert.equal(error.line, 2); assert.equal(error.fieldIndex, 5);
      assert.equal(error.fieldName, 'note'); assert.equal(error.byteOffset, prefix.length);
      assert.match(error.reason, /invalid UTF-8/); return true;
    });
  }
  assert.throws(() => auditExports([{ filename: 'bytes.csv', bytes: Buffer.from([0xff]) }]), /invalid UTF-8/);
});

test('source error ordering is deterministic even under exceptions-only', () => {
  const valid = source(csv([event({ type: 'delivered' }), event({ eventId: 'c', type: 'cancelled' })]), 'z.csv');
  const bad = source(csv([event({ parcelId: ' padded' })]), 'a.csv');
  const malformed = source('unterminated"', 'b.csv');
  for (const inputs of [[valid, malformed, bad], [bad, malformed, valid]]) {
    assert.throws(() => auditExports(inputs, { exceptionsOnly: true }), error => error.filename === 'a.csv' && error.fieldName === 'parcelId');
  }
});

test('byte API validates arguments, leaves input untouched, has no global state', () => {
  const inputs = [source(csv([event()]), 'z'), source(csv([]), 'a')];
  const snapshots = inputs.map(input => Buffer.from(input.bytes));
  const options = Object.freeze({ exceptionsOnly: false });
  const first = auditExports(Object.freeze(inputs), options);
  assert.deepEqual(inputs.map(input => input.filename), ['z', 'a']);
  assert.deepEqual(inputs.map(input => input.bytes), snapshots);
  assert.deepEqual(auditExports([{ filename: 'z', bytes: new Uint8Array(snapshots[0]) }, inputs[1]], options), first);
  first.evidence[0].header.fields[0].value = 'MUTATED';
  assert.equal(auditExports(inputs).evidence[0].header.fields[0].value, 'eventId');
  for (const value of [undefined, null, [], {}, [null], [{ filename: '', bytes: Buffer.alloc(0) }],
    [{ filename: 'a', text: csv([]) }], [{ filename: 'a', bytes: csv([]) }]]) assert.throws(() => auditExports(value), TypeError);
  assert.throws(() => auditExports([source(csv([]), 'a'), source(csv([]), 'a')]), InputError);
  for (const options of [null, true, [], { unexpected: true }, { exceptionsOnly: 1 }, { [Symbol()]: true }]) assert.throws(() => auditExports(inputs, options), TypeError);
});

test('deterministic generated round trips preserve arbitrary extra strings', () => {
  let seed = 20261028;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = ['a', 'é', 'e\u0301', '雪', '😀', '"', ',', '\r', '\n', ' ', '\t', '\u0000', '\ufeff'];
  const events = Array.from({ length: 180 }, (_, i) => event({ eventId: 'e-' + i,
    note: Array.from({ length: next() % 25 }, () => alphabet[next() % alphabet.length]).join('') }));
  for (const newline of ['\n', '\r\n']) {
    const input = source(csv(events, ['note', ...HEADERS], newline) + newline);
    const report = auditExports([input]);
    assert.deepEqual(report.evidence[0].records.map(record => record.fields[0].value), events.map(event => event.note));
    verifyEvidence(report, [input]);
  }
});
