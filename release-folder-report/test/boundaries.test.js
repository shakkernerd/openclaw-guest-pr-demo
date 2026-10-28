'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { review, deliver } = require('..');
const { createManifest } = require('../../directory-manifest');
const { fs, path, cli, fixture, baseline, plan, receipt, snapshot, run } = require('./helpers');

test('empty roots match an external saved baseline; empty added directories count as entries', async (t) => {
  const base = await fixture(t);
  const root = path.join(base, 'empty 世界');
  await fs.mkdir(root);
  const manifest = path.join(base, 'baseline.json');
  await fs.writeFile(manifest, JSON.stringify(await createManifest(root)));
  const input = await plan(base, [{ name: 'empty', root, manifest }]);
  assert.equal((await review(input)).exitCode, 0);
  await fs.mkdir(path.join(root, 'empty extra'));
  const result = await review(input);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.summary.entries, { changed: 0, missing: 0, extra: 1 });
  assert.equal(result.folders[0].result.changes[0].actual.type, 'directory');
});

test('final symlinks and invalid UTF-8 inputs fail without losing independent rows', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const linkedRoot = path.join(base, 'root link');
  const linkedBaseline = path.join(base, 'baseline link');
  await fs.symlink(good.root, linkedRoot, 'dir');
  await fs.symlink(good.manifest, linkedBaseline);
  const badUtf8 = path.join(base, 'invalid utf8.json');
  await fs.writeFile(badUtf8, Buffer.from([0xc3, 0x28]));
  const input = await plan(base, [
    { name: 'root link', root: linkedRoot, manifest: good.manifest },
    { name: 'baseline link', root: good.root, manifest: linkedBaseline },
    { name: 'bad encoding', root: good.root, manifest: badUtf8 },
    { name: 'good', root: good.root },
  ]);
  const report = await review(input);
  assert.deepEqual(report.folders.map((row) => row.status), ['error', 'error', 'error', 'match']);
  assert.deepEqual(report.folders.slice(0, 3).map((row) => row.error.stage), ['inspection', 'baseline', 'baseline']);
  const inputAlias = path.join(base, 'list link');
  await fs.symlink(input, inputAlias);
  await assert.rejects(review(inputAlias), /regular file/);
  await assert.rejects(review(badUtf8));
  await receipt(await deliver(report, path.join(base, 'out')));
});

test('cancellation during delivery is explicit without rewriting the finalized review snapshot', async (t) => {
  const base = await fixture(t);
  await baseline(path.join(base, 'good'));
  const input = await plan(base, [{ name: 'good', root: 'good' }]);
  const out = path.join(base, 'late signal');
  // Deterministic injection at the delivery boundary (actual OS signals are
  // exercised separately in cli.test.js). No changes to production hooks.
  const script = [
    "const fs = require('node:fs/promises');",
    'const original = fs.open;',
    'fs.open = async (filename, ...args) => {',
    "  if (filename.endsWith('/report.md')) process.emit('SIGTERM');",
    '  return original(filename, ...args);',
    '};',
    'require(' + JSON.stringify(cli) + ').main(' + JSON.stringify([input, '--out', out]) + ').then(code => { process.exitCode = code; });',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 143, result.stderr);
  const ack = JSON.parse(result.stdout);
  assert.equal(ack.reviewExitCode, 0);
  assert.equal(ack.commandExitCode, 143);
  assert.equal(ack.signalDuringDelivery, 'SIGTERM');
  assert.match(result.stderr, /snapshot was already finalized/);
  const report = await receipt(out);
  assert.equal(report.state, 'completed');
  assert.equal(report.coverage, 'complete');
  assert.equal(report.exitCode, 0);
});

test('failed location preflight leaves prior reports and input bytes unchanged', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const input = await plan(base, [{ name: 'good', root: good.root }]);
  const first = path.join(base, 'first');
  assert.equal(run([input, '--out', first]).status, 0);
  const before = await Promise.all([good.root, input, first].map(snapshot));
  const result = run([input, '--out', path.join(good.root, 'bad output')]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /overlaps an input/);
  assert.deepEqual(await Promise.all([good.root, input, first].map(snapshot)), before);
});

test('cyclic and overlong input paths do not veto other results or safe report delivery', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const cycle = path.join(base, 'cycle');
  await fs.symlink('cycle', cycle);
  const input = await plan(base, [
    { name: 'cycle', root: path.join(cycle, 'child'), manifest: good.manifest },
    { name: 'too long', root: 'x'.repeat(300), manifest: good.manifest },
    { name: 'good', root: 'good' },
  ]);
  const result = run([input, '--out', path.join(base, 'report')]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).delivered, true);
  const report = await receipt(path.join(base, 'report'));
  assert.deepEqual(report.folders.map((row) => row.status), ['error', 'error', 'match']);
  assert.equal(report.folders[0].error.code, 'ELOOP');
  assert.equal(report.folders[1].error.code, 'ENAMETOOLONG');
});

test('real permission errors remain isolated, including inaccessible ancestors', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('requires non-root POSIX permission enforcement');
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const denied = path.join(base, 'denied');
  await fs.mkdir(denied);
  await fs.mkdir(path.join(denied, 'child'));
  const unreadable = path.join(base, 'unreadable.json');
  await fs.copyFile(good.manifest, unreadable);
  const before = await fs.readFile(unreadable);
  await fs.chmod(denied, 0);
  await fs.chmod(unreadable, 0);
  try {
    const input = await plan(base, [
      { name: 'ancestor access denied', root: path.join(denied, 'child'), manifest: good.manifest },
      { name: 'baseline access denied', root: good.root, manifest: unreadable },
      { name: 'good', root: 'good' },
    ]);
    const result = run([input, '--out', path.join(base, 'report')]);
    assert.equal(result.status, 2, result.stderr);
    const report = await receipt(path.join(base, 'report'));
    assert.deepEqual(report.folders.map((row) => row.status), ['error', 'error', 'match']);
    assert.equal(report.folders[0].error.code, 'EACCES');
    assert.equal(report.folders[1].error.code, 'EACCES');
    assert.equal((await fs.stat(denied)).mode & 0o777, 0);
    assert.equal((await fs.stat(unreadable)).mode & 0o777, 0);
  } finally {
    // Restore permissions only on this test's own disposable fixture for cleanup.
    await fs.chmod(denied, 0o700);
    await fs.chmod(unreadable, 0o600);
  }
  assert.deepEqual(await fs.readFile(unreadable), before);
});
