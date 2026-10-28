import { auditExports, InputError } from './audit.browser.mjs';

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_RECORDS = 10000;
const encoder = new TextEncoder();
const whitespace = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';

// JSON.parse establishes grammar only. Slice the ORIGINAL elements rather than
// serializing parsed objects (which would erase duplicate keys and spelling).
export function arrayElements(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new Error('Invalid JSON. Use one UTF-8 JSON array, without a BOM, comments, or trailing commas.');
  }
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of event objects, not JSONL or a report object.');
  if (parsed.length > MAX_RECORDS) throw new Error('Too many records: maximum 10,000. Nothing was reviewed.');
  const records = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  const first = text.indexOf('[');
  for (let i = first + 1; i < text.length; i++) {
    const c = text[i];
    if (start === -1) {
      if (whitespace(c)) continue;
      if (c === ']') break;
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (depth === 0 && (c === ',' || c === ']')) {
      let end = i;
      while (end > start && whitespace(text[end - 1])) end--;
      records.push({ start, end, rawJSON: text.slice(start, end) });
      start = -1;
      if (c === ']') break;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  if (records.length !== parsed.length) throw new Error('Unable to locate every array record. Nothing was reviewed.');
  return records;
}

// Only physical CR/LF outside strings become spaces. Preserve all member names,
// escapes, values and duplicate keys for the existing package's strict validator.
function singleLine(raw) {
  let quoted = false, escaped = false, result = '';
  for (const c of raw) {
    result += !quoted && (c === '\n' || c === '\r') ? ' ' : c;
    if (quoted && escaped) escaped = false;
    else if (quoted && c === '\\') escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  return result;
}

export function reviewBytes(input, filename = 'events.json') {
  if (!(input instanceof Uint8Array)) throw new TypeError('Expected input bytes.');
  if (input.byteLength > MAX_BYTES) throw new Error('File exceeds the 5 MiB limit. Nothing was reviewed.');
  const bytes = input.slice();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('Invalid UTF-8 encoding. Re-export as UTF-8 JSON; no partial review is available.'); }
  const records = arrayElements(text);
  let cursor = 0, offset = 0, line = 1;
  records.forEach((record, index) => {
    const gap = text.slice(cursor, record.start);
    offset += encoder.encode(gap).length;
    line += (gap.match(/\r\n|[\r\n]/g) || []).length;
    record.recordIndex = index + 1;
    record.line = line;
    record.byteStart = offset;
    offset += encoder.encode(record.rawJSON).length;
    record.byteEnd = offset;
    line += (record.rawJSON.match(/\r\n|[\r\n]/g) || []).length;
    cursor = record.end;
  });
  let audited;
  try {
    audited = auditExports([{ filename, text: records.map(record => singleLine(record.rawJSON)).join('\n') }]);
  } catch (error) {
    if (error instanceof InputError && error.line !== null) {
      const source = records[error.line - 1];
      throw new Error('Record ' + error.line + ' (line ' + source.line + '): ' + error.reason + '. No partial review is available.');
    }
    throw error;
  }
  // Enrich provenance, not reconciliation. Internal JSONL ordinal is replaced
  // with the actual source line plus an unambiguous one-based array record index.
  const mapEvent = event => ({ ...event, sources: event.sources.map(source => {
    const record = records[source.line - 1];
    return { ...source, line: record.line, recordIndex: record.recordIndex,
      byteStart: record.byteStart, byteEnd: record.byteEnd, rawJSON: record.rawJSON };
  }) });
  const report = { ...audited,
    parcels: audited.parcels.map(parcel => ({ ...parcel, timeline: parcel.timeline.map(mapEvent) })),
    exceptions: audited.exceptions.map(issue => issue.code === 'EVENT_ID_CONFLICT'
      ? { ...issue, variants: issue.variants.map(mapEvent) }
      : { ...issue, delivered: issue.delivered.map(mapEvent), cancelled: issue.cancelled.map(mapEvent) }),
  };
  return { bytes, text, filename, report };
}

export const issueEvents = issue => issue.code === 'EVENT_ID_CONFLICT' ? issue.variants : [...issue.delivered, ...issue.cancelled];
export const issueParcels = issue => [...new Set(issueEvents(issue).map(event => event.parcelId))].sort();
export const issueLabel = code => code === 'EVENT_ID_CONFLICT' ? 'Event ID conflict' : 'Delivery / cancellation';
export function matchingIndices(report, { parcel = '', issue = '', query = '' } = {}) {
  const p = parcel.toLowerCase(), q = query.toLowerCase();
  return report.exceptions.flatMap((exception, index) => {
    const parcels = issueParcels(exception);
    const haystack = [exception.code, issueLabel(exception.code), exception.eventId || '', ...parcels].join(' ').toLowerCase();
    return (!p || parcels.some(id => id.toLowerCase().includes(p))) &&
      (!issue || exception.code === issue) && (!q || haystack.includes(q)) ? [index] : [];
  });
}
export function selectedExceptions(report, selected) {
  // Always audit order, never click order. No filtering or evidence trimming.
  return report.exceptions.filter((_, index) => selected.has(index));
}
export const exportSelection = (report, selected) => JSON.stringify(selectedExceptions(report, selected), null, 2) + '\n';
