import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { reviewBytes, matchingIndices, exportSelection, MAX_BYTES, MAX_RECORDS } from './review.mjs';
const require = createRequire(import.meta.url);
const { auditExports } = require('../parcel-event-audit');
const fixture = readFileSync(new URL('./example.json', import.meta.url));
const encode = text => new TextEncoder().encode(text);
const event = (overrides = {}) => ({ eventId: 'e', parcelId: 'P', type: 'created', occurredAt: '2026-10-28T08:00:00Z', ...overrides });
const from = records => reviewBytes(encode(JSON.stringify(records)), 'events.json');
const withoutEnrichment = report => JSON.parse(JSON.stringify(report, (key, value) => {
  if (key === 'sources') return value.map(source => ({ filename: source.filename, line: source.recordIndex, occurredAt: source.occurredAt }));
  return value;
}));

test('browser wrapper uses upstream reconciliation with identical complete evidence', () => {
  const records = JSON.parse(fixture);
  const review = reviewBytes(fixture, 'fixture.json');
  const upstream = auditExports([{ filename: 'fixture.json', text: records.map(record => JSON.stringify(record)).join('\n') }]);
  assert.deepEqual(withoutEnrichment(review.report), upstream);
  assert.deepEqual(review.report.summary, { inputRecords: 9, uniqueEvents: 8, retryDuplicates: 1, parcels: 4, conflictingEventIds: 1, contradictoryParcels: 1, exceptions: 2 });
  assert.equal(review.report.exceptions[0].variants.length, 2);
  assert.equal(review.report.exceptions[1].delivered[0].sources.length, 2);
});
test('whole input bytes and raw UTF8/CRLF/escaped record spelling remain exact', () => {
  const raw = '{\r\n  "parcelId": "包裹🚚", "eventId":"e", "type":"created", "occurredAt":"2026-10-28T09:00:00+01:00"\r\n}';
  const input = encode(' \r\n[\r\n ' + raw + ', ' + raw + '\r\n]\r\n');
  const original = input.slice();
  const review = reviewBytes(input, 'unicode.json');
  assert.deepEqual(review.bytes, original); assert.deepEqual(input, original);
  input[0] = 0; assert.deepEqual(review.bytes, original, 'retains independent byte copy');
  const sources = review.report.parcels[0].timeline[0].sources;
  assert.equal(sources.length, 2); assert.equal(sources[0].line, 3); assert.equal(sources[1].line, 5);
  for (const source of sources) {
    assert.equal(source.rawJSON, raw);
    assert.equal(new TextDecoder().decode(review.bytes.slice(source.byteStart, source.byteEnd)), raw);
    assert.equal(source.occurredAt, '2026-10-28T09:00:00+01:00');
  }
});
test('physical CR LF CRLF provenance preserves exact bytes and spelling', async t => {
  for (const [label, eol] of [['CR', '\r'], ['LF', '\n'], ['CRLF', '\r\n']]) {
    await t.test(label, () => {
      const raw = '{' + eol + '  "parcel\\u0049d":"包裹", "eventId":"e\\\\r\\\\nx",' + eol +
        '  "type":"created", "occurredAt":"2026-10-28T09:00:00+01:00"' + eol + '}';
      const prefix = ' ' + eol + '[' + eol + ' ', gap = ',' + eol + eol + ' ';
      const text = prefix + raw + gap + raw + eol + ']' + eol;
      const input = encode(text), original = input.slice();
      const review = reviewBytes(input, label + '.json');
      assert.deepEqual(input, original); assert.deepEqual(review.bytes, original);
      assert.equal(review.text, text);
      const timeline = review.report.parcels[0].timeline[0], sources = timeline.sources;
      assert.equal(timeline.eventId, 'e\\r\\nx');
      assert.deepEqual(sources.map(source => source.line), [3, 8]);
      assert.deepEqual(sources.map(source => source.recordIndex), [1, 2]);
      const starts = [encode(prefix).length, encode(prefix + raw + gap).length];
      sources.forEach((source, index) => {
        assert.equal(source.filename, label + '.json');
        assert.equal(source.byteStart, starts[index]);
        assert.equal(source.byteEnd, starts[index] + encode(raw).length);
        assert.equal(source.rawJSON, raw);
        assert.deepEqual(review.bytes.slice(source.byteStart, source.byteEnd), encode(raw));
        assert.equal(source.occurredAt, '2026-10-28T09:00:00+01:00');
      });
      const invalid = raw.replace('"created"', '"approved"');
      assert.throws(() => reviewBytes(encode(prefix + raw + gap + invalid + eol + ']')),
        /Record 2 \(line 8\):/);
      // JSON-escaped CR/LF are not physical breaks; the strict ID rule still rejects them.
      const escapedControl = JSON.stringify(event()).replace('"e"', '"e\\r\\nx"');
      assert.throws(() => reviewBytes(encode('[' + eol + raw + ',' + eol + escapedControl + ']')),
        /Record 2 \(line 6\): eventId/);
    });
  }
});
test('raw array tokenizer handles delimiter-like strings and escaped quotes', () => {
  const records = [event({ eventId: 'e"},]\\', parcelId: 'P[{},]' }), event({ eventId: 'other', type: 'cancelled' })];
  const review = from(records);
  assert.equal(review.report.summary.inputRecords, 2);
  assert.equal(review.report.parcels.find(parcel => parcel.parcelId === 'P[{},]').timeline[0].eventId, records[0].eventId);
});
test('rejects duplicate keys before they can be silently overwritten, including escaped keys', () => {
  const raw = JSON.stringify(event());
  for (const duplicate of ['"eventId":"other",', '"event\\u0049d":"other",']) {
    assert.throws(() => reviewBytes(encode('[{' + duplicate + raw.slice(1) + ']')), /Record 1.*duplicate JSON key/);
  }
});
test('rejects whole file on invalid record even if clean parcel would be filtered out', () => {
  const records = JSON.parse(fixture); records.push(event({ parcelId: 'CLEAN-BUT-INVALID', occurredAt: '2026-02-30T08:00:00Z' }));
  assert.throws(() => from(records), /Record 10.*invalid calendar/);
});
for (const [label, text] of [
  ['empty bytes',''], ['object','{}'], ['JSONL',JSON.stringify(event()) + '\n' + JSON.stringify(event())],
  ['BOM','\ufeff[]'], ['trailing comma','[{},]'], ['trailing data','[] true'],
  ['null','[null]'], ['nested array','[[]]'], ['number','[1]'],
  ['unknown field',JSON.stringify([event({ extra: 'do not discard me' })])],
  ['bad type',JSON.stringify([event({ type: 'approved' })])],
  ['bad timestamp',JSON.stringify([event({ occurredAt: '2026-10-28' })])],
  ['padded ID',JSON.stringify([event({ parcelId: ' P' })])],
  ['unpaired surrogate',JSON.stringify([event({ parcelId: '\ud800' })])],
]) test('rejects ' + label + ' without a result', () => assert.throws(() => reviewBytes(encode(text))));
test('strict UTF8, byte and record limits fail rather than truncate', () => {
  assert.throws(() => reviewBytes(new Uint8Array([91, 0xc0, 0xaf, 93])), /Invalid UTF-8/);
  assert.throws(() => reviewBytes(new Uint8Array(MAX_BYTES + 1)), /5 MiB/);
  assert.throws(() => from(Array.from({ length: MAX_RECORDS + 1 }, () => event())), /10,000/);
});
test('valid empty arrays, clean files and benign retries are not exceptions', () => {
  assert.equal(from([]).report.summary.inputRecords, 0);
  assert.equal(from([event(), event()]).report.summary.retryDuplicates, 1);
  assert.deepEqual(from([event(), event()]).report.exceptions, []);
});
test('filtering does not alter global totals, cross-parcel variants, or hidden selection', () => {
  const { report } = reviewBytes(fixture);
  const before = JSON.stringify(report);
  const matches = matchingIndices(report, { parcel: 'pkg-north', query: 'shared', issue: 'EVENT_ID_CONFLICT' });
  assert.deepEqual(matches, [0]);
  assert.equal(report.exceptions[matches[0]].variants.length, 2);
  assert.deepEqual(matchingIndices(report, { parcel: 'HARBOR', query: 'cancellation' }), [1]);
  assert.deepEqual(matchingIndices(report, { parcel: 'MISSING' }), []);
  const selected = new Set([1, 0]);
  assert.deepEqual(JSON.parse(exportSelection(report, selected)), report.exceptions);
  selected.delete(0);
  assert.deepEqual(JSON.parse(exportSelection(report, selected)), [report.exceptions[1]]);
  assert.deepEqual(JSON.parse(exportSelection(report, new Set())), []);
  assert.equal(JSON.stringify(report), before);
});
test('repeated reviews and selected JSON are deterministic, independent of click order', () => {
  const first = reviewBytes(fixture, 'same.json').report;
  const second = reviewBytes(fixture, 'same.json').report;
  assert.deepEqual(first, second);
  assert.equal(exportSelection(first, new Set([1,0])), exportSelection(second, new Set([0,1])));
  const reverse = from(JSON.parse(fixture).reverse()).report;
  assert.deepEqual(reverse.summary, first.summary);
  const identity = report => report.exceptions.map(issue => [issue.code, issue.eventId || issue.parcelId]);
  assert.deepEqual(identity(reverse), identity(first));
});
