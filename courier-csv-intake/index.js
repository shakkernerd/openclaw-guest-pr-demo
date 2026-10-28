"use strict";

const { open } = require("node:fs/promises");
const { constants } = require("node:fs");
const { createHash } = require("node:crypto");
const { TextDecoder } = require("node:util");
const auditor = require("../parcel-event-audit");

const REQUIRED = ["eventId", "parcelId", "type", "occurredAt"];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

class InputError extends Error {
  constructor(filename, reason, location = {}) {
    const { record = null, line = null, column = null, byteOffset = null,
      fieldIndex = null, fieldName = null } = location;
    const where = [record === null ? null : `record ${record}`,
      fieldIndex === null ? null : `field ${fieldIndex}`,
      fieldName === null ? null : JSON.stringify(fieldName)].filter(v => v !== null);
    const point = line === null ? "" : `:${line}${column === null ? "" : `:${column}`}`;
    super(`${JSON.stringify(filename)}${point}${where.length ? ` (${where.join(", ")})` : ""}: ${reason}`);
    this.name = "InputError";
    Object.assign(this, { filename, reason, record, line, column, byteOffset, fieldIndex, fieldName });
  }
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => key !== "exceptionsOnly") ||
      (Object.hasOwn(options, "exceptionsOnly") && typeof options.exceptionsOnly !== "boolean")) {
    throw new TypeError("options must contain only an optional boolean exceptionsOnly");
  }
  return { exceptionsOnly: Object.hasOwn(options, "exceptionsOnly") && options.exceptionsOnly };
}

function validateFilenames(filenames) {
  if (!Array.isArray(filenames) || filenames.length === 0) throw new TypeError("provide at least one CSV export");
  const seen = new Set();
  for (const filename of filenames) {
    if (typeof filename !== "string" || !filename) throw new TypeError("filename must be a nonempty string");
    if (seen.has(filename)) throw new InputError(filename, "source filename supplied more than once");
    seen.add(filename);
  }
}

function fieldLocation(record, field, fieldName = null) {
  return { record: record.record, line: field.line, column: field.column,
    byteOffset: field.byteStart, fieldIndex: field.index, fieldName };
}

// Scan ASCII CSV syntax over bytes, not lines or Unicode code units. UTF-8
// continuation bytes cannot masquerade as quote/comma/CR/LF delimiters.
function parseCSV(bytes, filename) {
  let i = 0, line = 1, column = 1;
  const records = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const position = () => ({ byteStart: i, line, column });
  const advance = () => {
    if (bytes[i++] === 10) { line++; column = 1; } else column++;
  };
  const fail = (reason, index, point = position()) => {
    throw new InputError(filename, reason, { record: records.length + 1,
      line: point.line, column: point.column, byteOffset: point.byteStart,
      fieldIndex: index, fieldName: records[0]?.fields[index - 1]?.value ?? null });
  };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("UTF-8 BOM is not supported; header must start at byte 0", 1);
  }
  while (i < bytes.length) {
    const start = position();
    const fields = [];
    let terminator = "";
    while (true) {
      const fieldStart = position();
      const index = fields.length + 1;
      const quoted = bytes[i] === 34;
      if (quoted) {
        advance();
        let closed = false;
        while (i < bytes.length) {
          if (bytes[i] !== 34) { advance(); continue; }
          advance();
          if (bytes[i] === 34) { advance(); continue; }
          closed = true;
          break;
        }
        if (!closed) fail("unterminated quoted field", index, fieldStart);
        if (i < bytes.length && ![44, 10, 13].includes(bytes[i])) {
          fail("expected comma, line ending, or EOF after closing quote", index);
        }
      } else {
        while (i < bytes.length && ![44, 10, 13].includes(bytes[i])) {
          if (bytes[i] === 34) fail("quote inside an unquoted field", index);
          advance();
        }
      }
      let raw;
      try { raw = decoder.decode(bytes.subarray(fieldStart.byteStart, i)); }
      catch { fail("invalid UTF-8 in field", index, fieldStart); }
      fields.push({ index, value: quoted ? raw.slice(1, -1).replace(/""/g, '"') : raw,
        raw, ...fieldStart, byteEnd: i, endLine: line, endColumn: column });
      if (bytes[i] === 44) { advance(); continue; }
      break;
    }
    const end = i;
    const endLine = line;
    const endColumn = column;
    if (bytes[i] === 13) {
      if (bytes[i + 1] !== 10) fail("bare CR record separator is not supported; use LF or CRLF", fields.length);
      terminator = "\r\n"; advance(); advance();
    } else if (bytes[i] === 10) { terminator = "\n"; advance(); }
    records.push({ record: records.length + 1, ...start, byteEnd: end, endLine, endColumn,
      raw: bytes.subarray(start.byteStart, end).toString("utf8"), terminator, fields });
  }
  return records;
}

function prepare(filename, received) {
  // Own the snapshot; callers can neither mutate our result through their buffer
  // nor lose the received spelling through UTF-8 replacement or re-encoding.
  const bytes = Buffer.from(received);
  const records = parseCSV(bytes, filename);
  if (!records.length) throw new InputError(filename, "missing CSV header", { record: 1, line: 1, column: 1, byteOffset: 0 });
  const [header, ...data] = records;
  const names = new Map();
  for (const field of header.fields) {
    if (field.value === "") throw new InputError(filename, "header names must not be empty", fieldLocation(header, field));
    if (names.has(field.value)) throw new InputError(filename, "duplicate header name", fieldLocation(header, field, field.value));
    names.set(field.value, field.index - 1);
  }
  for (const name of REQUIRED) {
    if (!names.has(name)) throw new InputError(filename, `missing required header ${JSON.stringify(name)} (exact spelling required)`,
      { record: 1, line: 1, column: 1, byteOffset: 0, fieldName: name });
  }
  const events = [];
  for (const record of data) {
    if (record.fields.length !== header.fields.length) {
      const index = Math.min(record.fields.length, header.fields.length) + 1;
      const field = record.fields[index - 1];
      throw new InputError(filename, `expected ${header.fields.length} fields, received ${record.fields.length}`,
        { record: record.record, line: field?.line ?? record.endLine, column: field?.column ?? record.endColumn,
          byteOffset: field?.byteStart ?? record.byteEnd, fieldIndex: index, fieldName: header.fields[index - 1]?.value ?? null });
    }
    for (const field of record.fields) field.name = header.fields[field.index - 1].value;
    events.push(Object.fromEntries(REQUIRED.map(name => [name, record.fields[names.get(name)].value])));
  }
  const converted = { filename, text: events.map(event => JSON.stringify(event)).join("\n") };
  // The auditor owns ALL event semantics. Do not replicate its validators or
  // change identity to include courier metadata. This pass also locates errors
  // in each sorted source before proceeding to a later source.
  try { auditor.auditExports([converted]); }
  catch (error) {
    if (!(error instanceof auditor.InputError)) throw error;
    const record = data[error.line - 1];
    const name = REQUIRED.find(name => error.reason.startsWith(`${name} `));
    throw new InputError(filename, error.reason, name
      ? fieldLocation(record, record.fields[names.get(name)], name)
      : { record: record.record, line: record.line, column: record.column, byteOffset: record.byteStart });
  }
  return { converted, evidence: { filename, encoding: "utf-8", byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64"), header, records: data } };
}

function finish(prepared, options) {
  const audit = auditor.auditExports(prepared.map(source => source.converted), options);
  const evidence = prepared.map(source => source.evidence);
  const byFilename = new Map(evidence.map(source => [source.filename, source]));
  const seen = new Set();
  function attach(event) {
    // The reconciler shares event objects between timelines and exceptions.
    if (seen.has(event)) return;
    seen.add(event);
    event.sources = event.sources.map(source => {
      const record = byFilename.get(source.filename).records[source.line - 1];
      return { filename: source.filename, record: record.record, line: record.line, endLine: record.endLine,
        byteStart: record.byteStart, byteEnd: record.byteEnd, occurredAt: source.occurredAt,
        fields: Object.fromEntries(REQUIRED.map(name => {
          const field = record.fields.find(field => field.name === name);
          return [name, { index: field.index, line: field.line, column: field.column,
            endLine: field.endLine, endColumn: field.endColumn, byteStart: field.byteStart, byteEnd: field.byteEnd }];
        })) };
    });
  }
  for (const parcel of audit.parcels) for (const event of parcel.timeline) attach(event);
  for (const exception of audit.exceptions) {
    for (const event of exception.variants ?? [...exception.delivered, ...exception.cancelled]) attach(event);
  }
  return { schemaVersion: 1, format: "courier-csv-intake", audit, evidence };
}

/** Pure synchronous API. Byte input is mandatory so original bytes survive. */
function auditExports(sources, options = {}) {
  const validated = validateOptions(options);
  if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
  validateFilenames(sources.map(source => source?.filename));
  for (const source of sources) {
    if (!(source.bytes instanceof Uint8Array)) throw new TypeError("source bytes must be a Buffer or Uint8Array; text input is not accepted");
  }
  return finish([...sources].sort((a, b) => compare(a.filename, b.filename))
    .map(source => prepare(source.filename, source.bytes)), validated);
}

/** Read-only regular-file API, including symlinks to regular files. */
async function auditFiles(filenames, options = {}) {
  const validated = validateOptions(options);
  validateFilenames(filenames);
  const prepared = [];
  for (const filename of [...filenames].sort(compare)) {
    let handle, bytes;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) throw new Error("input must be a regular file");
      bytes = await handle.readFile();
    } catch (error) {
      throw new InputError(filename, error.code || error.message);
    } finally {
      if (handle) {
        try { await handle.close(); }
        catch (error) { throw new InputError(filename, error.code || error.message); }
      }
    }
    prepared.push(prepare(filename, bytes));
  }
  return finish(prepared, validated);
}

module.exports = { auditExports, auditFiles, InputError };
