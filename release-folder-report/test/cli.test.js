'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { review, deliver } = require('..');
const { fs, path, cli, fixture, baseline, plan, run, snapshot, receipt } = require('./helpers');

test('CLI exit statuses, receipt, stdout/stderr separation and input-list-relative resolution', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const input = await plan(base, [{ name: 'good 世界', root: 'good' }]);
  const out = path.join(base, 'report 01');
  const ok = run([input, '--out', out], { cwd: path.dirname(base) });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).delivered, true);
  assert.match(ok.stderr, /Checking \[1\/1\]/);
  assert.equal((await receipt(out)).exitCode, 0);
  await fs.appendFile(path.join(good.root, 'file café.txt'), 'modified');
  const diff = run([input, '--out', path.join(base, 'report 02')]);
  assert.equal(diff.status, 1, diff.stderr);
  assert.equal((await receipt(path.join(base, 'report 02'))).summary.different, 1);
  const broken = await plan(base, [{ name: 'bad', root: 'missing', manifest: good.manifest },
    { name: 'different', root: 'good' }], 'errors.json');
  const errors = run([broken, '--out', path.join(base, 'report 03')]);
  assert.equal(errors.status, 2);
  const report = await receipt(path.join(base, 'report 03'));
  assert.deepEqual(report.folders.map((row) => row.status), ['error', 'different']);
  const before = await snapshot(out);
  const repeat = run([input, '--out', out]);
  assert.equal(repeat.status, 2);
  assert.equal(repeat.stdout, '');
  assert.match(repeat.stderr, /Refusing to overwrite/);
  assert.deepEqual(await snapshot(out), before);
});

test('CLI rejects missing/repeated/unknown options and invalid lists without creating outputs', async (t) => {
  const base = await fixture(t);
  const out = path.join(base, 'should not exist');
  for (const args of [[], ['nope'], ['--wat'], ['input', '--out'], ['input', '--out', out, '--out', out],
    ['input', '--out', out, 'extra'], ['--help', 'extra'], ['input', '--out', '--unknown']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /130 SIGINT/);
  assert.equal(help.stderr, '');
  const invalid = path.join(base, 'invalid.json');
  await fs.writeFile(invalid, '{');
  assert.equal(run([invalid, '--out', out]).status, 2);
  await assert.rejects(fs.lstat(out), { code: 'ENOENT' });
  await baseline(path.join(base, 'good'));
  await plan(base, [{ name: 'good', root: 'good' }], '-input.json');
  const dash = run(['--out', './dash out', '--', '-input.json'], { cwd: base });
  assert.equal(dash.status, 0, dash.stderr);
  await receipt(path.join(base, 'dash out'));
});

test('delivery rejects existing files, directories and dangling links, as well as source overlaps and aliases', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const input = await plan(base, [{ name: 'good', root: good.root }]);
  const report = await review(input);
  const before = await snapshot(good.root);
  const existingFile = path.join(base, 'file');
  const existingDirectory = path.join(base, 'directory');
  const dangling = path.join(base, 'dangling');
  await fs.writeFile(existingFile, 'keep');
  await fs.mkdir(existingDirectory);
  await fs.symlink('absent', dangling);
  for (const out of [existingFile, existingDirectory, dangling]) await assert.rejects(deliver(report, out), /Refusing to overwrite/);
  assert.equal(await fs.readFile(existingFile, 'utf8'), 'keep');
  assert.equal(await fs.readlink(dangling), 'absent');
  const alias = path.join(base, 'alias');
  await fs.symlink(good.root, alias, 'dir');
  for (const out of [good.root, path.join(good.root, 'report'), path.join(alias, 'report'), input, good.manifest]) {
    await assert.rejects(deliver(report, out), /overlaps an input/);
  }
  await assert.rejects(deliver(report, path.join(base, 'missing parent', 'out')), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(good.root), before);
  // A report must not create the location of a missing requested input either.
  const missing = path.join(base, 'future', 'input');
  const failed = await review(await plan(base, [{ name: 'missing', root: missing, manifest: good.manifest }], 'missing.json'));
  await assert.rejects(deliver(failed, path.join(base, 'future')), /overlaps an input/);
});

test('two real CLI deliveries racing for one name: exactly one succeeds', async (t) => {
  const base = await fixture(t);
  await baseline(path.join(base, 'good'));
  const input = await plan(base, [{ name: 'good', root: 'good' }]);
  const out = path.join(base, 'contended');
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, input, '--out', out]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([launch(), launch()]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 2]);
  assert.match(results.find((r) => r.code === 2).stderr, /Refusing to overwrite/);
  await receipt(out);
});

test('failure after the first report write preserves evidence and never creates a valid completion receipt', async (t) => {
  const base = await fixture(t);
  await baseline(path.join(base, 'good'));
  const report = await review(await plan(base, [{ name: 'good', root: 'good' }]));
  const out = path.join(base, 'partial');
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, 'open', async (filename, ...args) => {
    if (filename === path.join(out, 'report.md')) throw Object.assign(new Error('simulated storage failure'), { code: 'ENOSPC' });
    return originalOpen(filename, ...args);
  });
  await assert.rejects(deliver(report, out), /Incomplete delivery/);
  mocked.mock.restore();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8')), report);
  await assert.rejects(fs.lstat(path.join(out, 'COMPLETE.json')), { code: 'ENOENT' });
  await assert.rejects(deliver(report, out), /Refusing to overwrite/);
  await receipt(await deliver(report, path.join(base, 'new name')));
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test('real CLI ' + signal + ' finishes the active folder, delivers partial coverage and exits ' + code, { timeout: 30000 }, async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX signal semantics');
    const base = await fixture(t);
    const good = await baseline(path.join(base, 'good'));
    // A sparse file makes the active read long enough to signal deterministically;
    // it is an ordinary extra entry, not a fake verifier or injected timer.
    const handle = await fs.open(path.join(good.root, 'large file'), 'wx');
    await handle.truncate(64 * 1024 * 1024);
    await handle.close();
    const input = await plan(base, ['one', 'two', 'three'].map((name) => ({ name, root: 'good' })));
    const out = path.join(base, 'cancelled');
    let sent = false;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, input, '--out', out]);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI signal check timed out')); }, 20000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (!sent && stderr.includes('Checking [1/3]')) { sent = true; child.kill(signal); }
      });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    assert.equal(sent, true);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, code, result.stderr);
    const report = await receipt(out);
    assert.equal(report.state, 'cancelled');
    assert.equal(report.cancellation.reason, signal);
    assert.equal(report.exitCode, code);
    assert.deepEqual(report.folders.map((row) => row.status), ['different', 'skipped', 'skipped']);
    assert.equal(JSON.parse(result.stdout).delivered, true);
    assert.equal(report.summary.entries.extra, 1);
  });
}


for (const absoluteTarget of [false, true]) {
  test('dangling baseline alias preserves symlink-before-dotdot traversal (' +
    (absoluteTarget ? 'absolute target' : 'relative target') + ')', async (t) => {
    const base = await fixture(t);
    const good = await baseline(path.join(base, 'good'));
    await fs.mkdir(path.join(base, 'real'));
    await fs.mkdir(path.join(base, 'real', 'deep'));
    await fs.symlink('real/deep', path.join(base, 'hop'), 'dir');
    // Do not normalize the target: the OS follows hop before interpreting '..'.
    const target = (absoluteTarget ? base + path.sep : '') + 'hop/../late';
    await fs.symlink(target, path.join(base, 'late-alias'), 'dir');
    const missingBaseline = path.join(base, 'late-alias', 'report.json');
    const input = await plan(base, [
      { name: 'missing through alias', root: 'good', manifest: 'late-alias/report.json' },
      { name: 'independent good folder', root: 'good' },
    ]);
    const protectedPaths = [good.root, input, path.join(base, 'hop'), path.join(base, 'late-alias')];
    const before = await Promise.all(protectedPaths.map(snapshot));
    await assert.rejects(fs.lstat(missingBaseline), { code: 'ENOENT' });
    const safe = path.join(base, 'safe-report');
    const control = run([input, '--out', safe]);
    assert.equal(control.status, 2, control.stderr);
    assert.equal(JSON.parse(control.stdout).delivered, true);
    const partial = await receipt(safe);
    assert.deepEqual(partial.folders.map(row => row.status), ['error', 'match']);
    assert.equal(partial.folders[0].error.stage, 'baseline');
    assert.equal(partial.folders[0].error.code, 'ENOENT');
    await assert.rejects(fs.lstat(missingBaseline), { code: 'ENOENT' });
    const safeBefore = await snapshot(safe);

    const overlapping = path.join(base, 'real', 'late');
    const refused = run([input, '--out', overlapping]);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /overlaps an input path/);
    await assert.rejects(fs.lstat(overlapping), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(missingBaseline), { code: 'ENOENT' });
    assert.deepEqual(await snapshot(safe), safeBefore);
    assert.deepEqual(await Promise.all(protectedPaths.map(snapshot)), before);

    // Positive control: a valid input-parent alias with the same traversal and
    // a harmless output-parent alias must both remain supported.
    await fs.mkdir(path.join(base, 'real', 'saved'));
    await fs.copyFile(good.manifest, path.join(base, 'real', 'saved', 'baseline.json'));
    await fs.symlink((absoluteTarget ? base + path.sep : '') + 'hop/../saved', path.join(base, 'saved-alias'), 'dir');
    await fs.symlink('real', path.join(base, 'out-alias'), 'dir');
    const valid = await plan(base, [{ name: 'valid aliases', root: 'good', manifest: 'saved-alias/baseline.json' }], 'valid.json');
    const delivered = run([valid, '--out', path.join(base, 'out-alias', 'valid-report')]);
    assert.equal(delivered.status, 0, delivered.stderr);
    assert.equal((await receipt(path.join(base, 'real', 'valid-report'))).folders[0].status, 'match');
    assert.deepEqual(await snapshot(safe), safeBefore);
    assert.deepEqual(await Promise.all(protectedPaths.map(snapshot)), before);
    await assert.rejects(fs.lstat(missingBaseline), { code: 'ENOENT' });
  });
}
