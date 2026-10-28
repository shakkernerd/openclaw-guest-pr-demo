"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { auditFiles, auditExports, InputError } = require('./index.js');
const cli = path.join(__dirname, 'cli.js');
const fixture = name => path.join(__dirname, 'examples', name);
const a = fixture('export-a.csv'), b = fixture('export-b.csv'), bad = fixture('malformed.csv');
const header = 'eventId,parcelId,type,occurredAt,note\n';
const row = 'e,p,created,2026-10-28T08:00:00Z,note\n';
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 20 * 1024 * 1024, ...options });
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'courier-csv-intake-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('real CLI exits 0/1, retains bytes, deterministically reconciles both export orders', async () => {
  const filenames = [a, b];
  const bytes = await Promise.all(filenames.map(filename => readFile(filename)));
  const clean = run([a]);
  assert.equal(clean.status, 0, clean.stderr); assert.equal(clean.stderr, '');
  assert.equal(JSON.parse(clean.stdout).audit.summary.exceptions, 0);
  const result = run(filenames);
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.audit.summary, { inputRecords: 6, uniqueEvents: 5, retryDuplicates: 1, parcels: 2, conflictingEventIds: 1, contradictoryParcels: 1, exceptions: 2 });
  assert.equal(result.stdout, JSON.stringify(report, null, 2) + '\n');
  assert.equal(run([b, a]).stdout, result.stdout);
  assert.deepEqual(report, await auditFiles(filenames));
  assert.deepEqual(report, auditExports(filenames.map((filename, i) => ({ filename, bytes: bytes[i] }))));
  assert.deepEqual(await Promise.all(filenames.map(filename => readFile(filename))), bytes);
  for (const evidence of report.evidence) assert.deepEqual(Buffer.from(evidence.bytesBase64, 'base64'), bytes[filenames.indexOf(evidence.filename)]);
  const delivered = report.audit.parcels[0].timeline.find(event => event.type === 'delivered');
  assert.deepEqual(delivered.sources.map(source => [source.record, source.line]), [[2, 2], [2, 2]]);
  const transit = report.audit.parcels[1].timeline[0];
  assert.deepEqual([transit.sources[0].record, transit.sources[0].line], [4, 5]);
});

test('real CLI output is independent of locale and timezone', () => {
  const outputs = [{ TZ: 'UTC', LANG: 'C' }, { TZ: 'America/New_York', LANG: 'en_US.UTF-8' }, { TZ: 'Asia/Kolkata', LANG: 'tr_TR.UTF-8' }]
    .map(env => run([a, b], { env: { ...process.env, ...env } }));
  for (const result of outputs) { assert.equal(result.status, 1); assert.equal(result.stderr, ''); assert.equal(result.stdout, outputs[0].stdout); }
});

test('exceptions-only preserves all original evidence, totals and affected timelines', async t => {
  const dir = await temporary(t), clean = path.join(dir, 'clean.csv');
  await writeFile(clean, header + row + row);
  const full = JSON.parse(run([a, b, clean]).stdout);
  const filtered = run([a, '--exceptions-only', b, clean, '--exceptions-only']);
  assert.equal(filtered.status, 1, filtered.stderr);
  const report = JSON.parse(filtered.stdout);
  assert.equal(report.audit.view, 'exceptions-only');
  assert.deepEqual(report.audit.summary, full.audit.summary);
  assert.deepEqual(report.audit.exceptions, full.audit.exceptions);
  assert.deepEqual(report.evidence, full.evidence);
  assert.deepEqual(report.audit.parcels, full.audit.parcels.filter(parcel => parcel.parcelId !== 'p'));
  const onlyClean = run(['--exceptions-only', clean]);
  assert.equal(onlyClean.status, 0);
  assert.deepEqual(JSON.parse(onlyClean.stdout).audit.parcels, []);
  assert.equal(JSON.parse(onlyClean.stdout).evidence[0].records.length, 2);
});

test('malformed input and usage exit 2 with useful errors and zero stdout', () => {
  for (const args of [[], ['--unknown'], ['--'], ['--help', a], [a, a], [fixture('missing.csv')], [a, bad], ['--exceptions-only', a, bad]]) {
    const result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args) + result.stderr);
    assert.equal(result.stdout, ''); assert.match(result.stderr, /^courier-csv-intake: /);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  const result = run([bad]);
  assert.match(result.stderr, /malformed\.csv":3:\d+ \(record 2, field 5, "occurredAt"\): occurredAt has an invalid calendar/);
  assert.equal(run([bad, a]).stderr, run([a, bad]).stderr);
});

test('invalid UTF-8, missing fields and broken quoting cannot produce partial success', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'invalid.csv');
  const prefix = Buffer.from(header + row + 'e2,p,created,2026-10-28T09:00:00Z,');
  for (const bytes of [Buffer.concat([prefix, Buffer.from([0xff])]), Buffer.from(header + row + 'short,row\n'), Buffer.from(header + row + '"unterminated\n')]) {
    await writeFile(filename, bytes);
    const result = run(['--exceptions-only', a, filename]);
    assert.equal(result.status, 2, result.stderr); assert.equal(result.stdout, '');
    assert.match(result.stderr, /record 3, field/);
    assert.deepEqual(await readFile(filename), bytes);
  }
});

test('help, literal flags as filenames, safe diagnostics, and imports have no side effects', async t => {
  for (const arg of ['--help', '-h']) { const result = run([arg]); assert.equal(result.status, 0); assert.match(result.stdout, /^Usage:/); assert.equal(result.stderr, ''); }
  const dir = await temporary(t), filename = path.join(dir, '--exceptions-only');
  await writeFile(filename, header + row);
  const result = run(['--', '--exceptions-only'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).evidence[0].filename, '--exceptions-only');
  const strange = 'missing\n"filename.csv';
  const diagnostic = run([strange], { cwd: dir });
  assert.equal(diagnostic.status, 2); assert.equal(diagnostic.stderr.split('\n').length, 2);
  const imported = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(cli) + '); require(' + JSON.stringify(__dirname) + ');'], { encoding: 'utf8' });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
  assert.equal(await readFile(filename, 'utf8'), header + row);
});

test('file API rejects bad arguments, missing files, directories and devices', async t => {
  const dir = await temporary(t);
  await assert.rejects(auditFiles([]), TypeError);
  await assert.rejects(auditFiles([a, a]), InputError);
  await assert.rejects(auditFiles([a], { exceptionsOnly: 'yes' }), TypeError);
  await assert.rejects(auditFiles([dir]), /regular file/);
  await assert.rejects(auditFiles([path.join(dir, 'missing')]), error => error instanceof InputError && error.line === null && error.reason === 'ENOENT');
  if (process.platform !== 'win32') {
    await assert.rejects(auditFiles(['/dev/null']), /regular file/);
    const alias = path.join(dir, 'alias.csv'); await symlink(a, alias);
    assert.equal((await auditFiles([alias])).evidence[0].filename, alias);
    const fifo = path.join(dir, 'fifo');
    const made = spawnSync('mkfifo', [fifo]);
    if (!made.error && made.status === 0) { const result = run([fifo]); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /regular file/); }
  }
});

test('broken stdout is status 2, with no uncaught stack', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [cli, a], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 2); assert.match(stderr, /^courier-csv-intake: stdout: EPIPE\n$/);
});

for (const closeEarly of [false, true]) {
  test('combined stdout/stderr pipe ' + (closeEarly ? 'closed early' : 'drained normally'), { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const dir = await temporary(t), filename = path.join(dir, 'large.csv');
    const bytes = Buffer.from(header + row.repeat(1200)); await writeFile(filename, bytes);
    const child = spawn('sh', ['-c', 'exec "$@" 2>&1', 'csv-pipe-test', process.execPath, cli, filename], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let output = '', shellError = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (closeEarly) child.stdout.destroy(); });
    child.stderr.on('data', chunk => { shellError += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, closeEarly ? 2 : 0); assert.equal(shellError, '');
    assert.match(output, /^\{/); assert.doesNotMatch(output, /Unhandled 'error' event|node:events|\n\s+at /);
    if (!closeEarly) assert.equal(JSON.parse(output).audit.summary.retryDuplicates, 1199);
    assert.deepEqual(await readFile(filename), bytes);
  });
}
