'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseManifest, verifyManifest } = require('../directory-manifest');
const { textPath, readJsonFile, deliver: writeDelivery } = require('./io');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const now = () => new Date().toISOString();
const zeroCounts = () => ({ changed: 0, missing: 0, extra: 0 });

function validatePlan(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'folders,version' ||
      value.version !== 1 || !Array.isArray(value.folders) || value.folders.length === 0) {
    throw new Error('Expected {"version":1,"folders":[...]} with at least one folder and no other top-level fields');
  }
}

function prepare(input, index, base, names) {
  const record = object(input) ? input : {};
  const name = typeof record.name === 'string' ? record.name : '(entry ' + (index + 1) + ')';
  const root = textPath(record.root) ? path.resolve(base, record.root) : null;
  const manifest = Object.hasOwn(record, 'manifest')
    ? (textPath(record.manifest) ? path.resolve(base, record.manifest) : null)
    : (root ? path.join(root, '.directory-manifest.json') : null);
  let invalid = null;
  if (!object(input) || Object.keys(record).some((key) => !['name', 'root', 'manifest'].includes(key)) ||
      !textPath(record.name) || record.name.trim() === '' || !root || !manifest) {
    invalid = 'Expected name and root as nonempty strings, optional manifest as a nonempty string, and no other fields';
  } else if (names.get(name) > 1) {
    invalid = 'Duplicate folder name: ' + JSON.stringify(name) + ' (all occurrences rejected)';
  }
  return { invalid, row: {
    index: index + 1, name, input, root, manifest,
    status: 'skipped', attempted: false, checked: false,
    startedAt: null, finishedAt: null, counts: null, result: null, error: null,
    skipReason: 'cancelled before this folder was attempted',
  } };
}

function errorInfo(stage, error) {
  return { stage, code: typeof error.code === 'string' ? error.code : null, message: error.message };
}

function summarize(folders) {
  const summary = { requested: folders.length, attempted: 0, checked: 0,
    matched: 0, different: 0, errors: 0, skipped: 0, entries: zeroCounts() };
  for (const row of folders) {
    if (row.attempted) summary.attempted++;
    if (row.checked) summary.checked++;
    summary[{ match: 'matched', different: 'different', error: 'errors', skipped: 'skipped' }[row.status]]++;
    if (row.counts) for (const key of Object.keys(summary.entries)) summary.entries[key] += row.counts[key];
  }
  return summary;
}

/** Read-only, serial checks. A failed row never discards another row's result.
 * Abort is cooperative BETWEEN rows: directory-manifest has no abort API. */
async function review(inputFile, { signal, onProgress = () => {} } = {}) {
  if (!textPath(inputFile)) throw new Error('Input list must be a nonempty path');
  const startedAt = now();
  const source = path.resolve(inputFile);
  const plan = JSON.parse(await readJsonFile(source));
  validatePlan(plan);
  const names = new Map();
  for (const row of plan.folders) if (object(row) && typeof row.name === 'string') {
    names.set(row.name, (names.get(row.name) || 0) + 1);
  }
  const prepared = plan.folders.map((row, i) => prepare(row, i, path.dirname(source), names));
  for (const { row, invalid } of prepared) {
    if (signal?.aborted) break;
    row.startedAt = now();
    row.skipReason = null;
    if (invalid) {
      row.status = 'error';
      row.error = errorInfo('input', new Error(invalid));
    } else {
      row.attempted = true;
      await onProgress({ phase: 'checking', index: row.index, total: prepared.length, name: row.name });
      let stage = 'baseline';
      try {
        const manifest = parseManifest(await readJsonFile(row.manifest));
        stage = 'inspection';
        // Keep the library's result unchanged, including expected/actual entries.
        row.result = await verifyManifest(row.root, manifest);
        row.checked = true;
        row.status = row.result.ok ? 'match' : 'different';
        row.counts = zeroCounts();
        for (const change of row.result.changes) row.counts[change.status]++;
      } catch (error) {
        row.status = 'error';
        row.error = errorInfo(stage, error);
      }
    }
    row.finishedAt = now();
    await onProgress({ phase: 'finished', index: row.index, total: prepared.length, name: row.name, status: row.status });
  }
  const folders = prepared.map(({ row }) => row);
  const summary = summarize(folders);
  const cancellation = signal?.aborted ? {
    reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'Cancelled'),
    exitCode: signal.reason === 'SIGTERM' ? 143 : 130,
  } : null;
  return {
    version: 1, runId: randomUUID(), source, startedAt, finishedAt: now(),
    state: cancellation ? 'cancelled' : 'completed',
    coverage: summary.checked === summary.requested ? 'complete' : 'partial',
    cancellation, summary, folders,
    exitCode: cancellation ? cancellation.exitCode : summary.errors ? 2 : summary.different ? 1 : 0,
  };
}

// Pure Markdown, with no raw HTML or HTML entities. A JSON code span keeps
// Markdown syntax inert. Escape its delimiter, table pipes, HTML metacharacters
// and Unicode line separators as JSON escapes: still single-line and lossless.
function quoted(value) {
  const text = JSON.stringify(value).replace(/[<>&|\x60\u2028\u2029]/gu, (char) =>
    '\\u' + char.codePointAt(0).toString(16).padStart(4, '0'));
  const tick = String.fromCharCode(96);
  return tick + text + tick;
}

function attention(report) {
  const s = report.summary;
  const differences = report.folders.filter(row => row.status === 'different');
  const unchecked = report.folders.filter(row => row.status === 'error' || row.status === 'skipped');
  const lines = ['## Attention needed', '',
    s.checked === s.requested
      ? 'Coverage complete: **' + s.checked + '/' + s.requested + ' folders checked**.'
      : '**Incomplete coverage: ' + s.checked + '/' + s.requested + ' folders checked; ' +
        s.errors + ' could not be checked, ' + s.skipped + ' skipped.**', '',
    '**A matching manifest is not release approval.**', '',
    '### Content differences (' + differences.length + ')', ''];
  if (!differences.length) lines.push('None reported from completed checks.');
  for (const row of differences) lines.push('- #' + row.index + ' ' + quoted(row.name) + ' — ' +
    row.counts.changed + ' changed, ' + row.counts.missing + ' missing, ' + row.counts.extra +
    ' extra entries; review the detailed evidence below.');
  lines.push('', '### Could not be checked or skipped (' + unchecked.length + ')', '');
  if (!unchecked.length) lines.push('None; every requested folder was checked.');
  for (const row of unchecked) {
    if (row.status === 'skipped') {
      lines.push('- #' + row.index + ' ' + quoted(row.name) + ' — **skipped**: ' + quoted(row.skipReason) + '.');
    } else {
      const chars = Array.from(row.error.message);
      const brief = chars.length > 160 ? chars.slice(0, 160).join('') + '…' : row.error.message;
      lines.push('- #' + row.index + ' ' + quoted(row.name) + ' — **not checked** (' + row.error.stage +
        (row.error.code ? ' / ' + row.error.code : '') + '): ' + quoted(brief) + '.');
    }
  }
  lines.push('', 'Full paths, errors and per-entry changes follow; unchecked folders are not matches.', '');
  return lines;
}

function reason({ expected, actual }) {
  if (expected.type !== actual.type) return 'type: ' + expected.type + ' → ' + actual.type;
  if (expected.type === 'symlink') return 'symlink target: ' + quoted(expected.target) + ' → ' + quoted(actual.target);
  const reasons = [];
  if (expected.size !== actual.size) reasons.push('size: ' + expected.size + ' → ' + actual.size + ' bytes');
  if (expected.sha256 !== actual.sha256) reasons.push('SHA-256 changed');
  return reasons.join('; ');
}

function markdown(report) {
  const s = report.summary;
  const lines = [
    '# Release folder review', '',
    'Run: ' + quoted(report.runId), '',
    'Input list: ' + quoted(report.source), '',
    'Started: ' + report.startedAt + ' · Finished: ' + report.finishedAt, '',
    '**Run: ' + report.state + '. Coverage: ' + report.coverage + '. Review exit status: ' + report.exitCode + '.**', '',
    'Checked **' + s.checked + '/' + s.requested + '** folders; attempted ' + s.attempted + '. ' +
      s.matched + ' match, ' + s.different + ' different, ' + s.errors + ' error, ' + s.skipped + ' skipped.', '',
    'Completed checks only: **' + s.entries.changed + ' changed, ' + s.entries.missing + ' missing, ' + s.entries.extra + ' extra entries**.', '',
    'An error is NOT a content difference. Unchecked folders have no difference counts; they are not matches.', '',
  ];
  if (report.cancellation) lines.push(
    '**Cancelled:** ' + quoted(report.cancellation.reason) + '. The active check was allowed to finish; later folders were not inspected.', '');
  lines.push(...attention(report), '## Folder details', '');
  lines.push('| # | Folder | Status | Attempted | Checked | Changed | Missing | Extra |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of report.folders) lines.push(
    '| ' + row.index + ' | ' + quoted(row.name) + ' | ' + row.status + ' | ' + (row.attempted ? 'yes' : 'no') + ' | ' + (row.checked ? 'yes' : 'no') + ' | ' +
    (row.counts?.changed ?? '—') + ' | ' + (row.counts?.missing ?? '—') + ' | ' + (row.counts?.extra ?? '—') + ' |');
  for (const row of report.folders) {
    lines.push('', '## ' + row.index + '. ' + quoted(row.name), '',
      'Root: ' + quoted(row.root), '', 'Baseline: ' + quoted(row.manifest), '',
      'Status: **' + row.status + '**. Attempted: ' + (row.attempted ? 'yes' : 'no') + '. Checked: ' + (row.checked ? 'yes' : 'no') + '.', '');
    if (row.status === 'match') lines.push('Directory matches the saved baseline.');
    if (row.error) lines.push('**Error (' + row.error.stage + (row.error.code ? ' / ' + row.error.code : '') + '):** ' + quoted(row.error.message));
    if (row.status === 'skipped') lines.push('Not checked: ' + row.skipReason + '.');
    for (const change of row.result?.changes ?? []) {
      lines.push('- **' + change.status + '** ' + quoted(change.path) +
        (change.status === 'changed' ? ' — ' + reason(change) : ' (' + (change.actual ?? change.expected).type + ')'));
    }
  }
  lines.push('', '## Interpretation and delivery', '',
    '- Counts measure entries, including empty directories, not bytes or individual change reasons.',
    '- Only fully completed library comparisons are reported; a failed scan has no trustworthy partial inventory.',
    '- JSON retains the full expected/actual entries. SHA-256 comparison is not baseline authentication.',
    '- Inspection does not repair inputs. Use quiescent folders; this is not an atomic filesystem snapshot.',
    '- A valid COMPLETE.json receipt with matching hashes for both report files marks delivery complete. A cancelled review can still be fully delivered.', '');
  return lines.join('\n');
}

async function deliver(report, destination) {
  return writeDelivery(report, destination, markdown(report));
}

module.exports = { review, markdown, deliver };
