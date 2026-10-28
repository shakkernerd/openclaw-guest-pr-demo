'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { review, markdown, deliver } = require('..');
const { createManifest, parseManifest, verifyManifest } = require('../../directory-manifest');
const { fs, path, fixture, baseline, plan, snapshot, receipt } = require('./helpers');

test('real source handoff: intact, damaged, genuine error; inputs and earlier delivery preserved', async (t) => {
  const base = await fixture(t);
  const original = await baseline(path.join(base, 'Original café 世界'), { realSource: true });
  const intact = path.join(base, 'Received intact 世界');
  const damaged = path.join(base, 'Separate damaged copy');
  await fs.cp(original.root, intact, { recursive: true });
  await fs.cp(intact, damaged, { recursive: true });
  await fs.appendFile(path.join(damaged, 'README.md'), '\nDamage in separate copy only.\n');
  await fs.rmdir(path.join(damaged, 'empty directory 世界'));
  await fs.writeFile(path.join(damaged, '追加 メモ.txt'), 'new data\n');
  const input = await plan(base, [
    { name: 'intact', root: path.basename(intact) },
    { name: 'input error', root: 'does not exist', manifest: original.manifest },
    { name: 'damaged', root: path.basename(damaged) },
  ]);
  const before = await Promise.all([original.root, intact, damaged, input].map(snapshot));
  const report = await review(input);
  assert.deepEqual(report.folders.map((row) => row.status), ['match', 'error', 'different']);
  assert.deepEqual(report.summary, { requested: 3, attempted: 3, checked: 2, matched: 1, different: 1,
    errors: 1, skipped: 0, entries: { changed: 1, missing: 1, extra: 1 } });
  assert.equal(report.state, 'completed');
  assert.equal(report.coverage, 'partial');
  assert.equal(report.exitCode, 2);
  assert.equal(report.folders[1].checked, false);
  assert.equal(report.folders[1].counts, null);
  assert.equal(report.folders[1].result, null);
  assert.equal(report.folders[1].error.stage, 'inspection');
  assert.equal(report.folders[1].error.code, 'ENOENT');
  const saved = parseManifest(await fs.readFile(path.join(damaged, '.directory-manifest.json'), 'utf8'));
  assert.deepEqual(report.folders[2].result, await verifyManifest(damaged, saved));
  const first = await deliver(report, path.join(base, 'review 01'));
  await receipt(first);
  const earlier = await snapshot(first);
  await deliver(await review(input), path.join(base, 'review 02'));
  await assert.rejects(deliver(report, first), /Refusing to overwrite/);
  assert.deepEqual(await snapshot(first), earlier);
  assert.deepEqual(await Promise.all([original.root, intact, damaged, input].map(snapshot)), before);
  assert.equal((await verifyManifest(original.root, parseManifest(await fs.readFile(original.manifest, 'utf8')))).ok, true);
});

test('invalid rows and duplicate names are isolated; external/default baselines and relative paths', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const input = await plan(base, [null, { name: 'bad', root: '' },
    { name: 'same', root: 'good' }, { name: 'same', root: 'good' },
    { name: 'typo', root: 'good', baseline: 'wrong' },
    { name: 'good', root: 'good' }, { name: 'explicit', root: good.root, manifest: good.manifest }]);
  const report = await review(input);
  assert.deepEqual(report.folders.map((row) => row.status), ['error', 'error', 'error', 'error', 'error', 'match', 'match']);
  assert.equal(report.summary.attempted, 2);
  assert.equal(report.summary.checked, 2);
  assert.equal(report.folders[2].error.stage, 'input');
  assert.match(report.folders[3].error.message, /Duplicate/);
  await receipt(await deliver(report, path.join(base, 'out')));
});

test('malformed JSON/top-level list fails before any delivery; baseline errors remain per-row', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  for (const [i, value] of ['{', '{}', '{"version":1,"folders":[]}', '{"version":2,"folders":[{}]}',
    '{"version":1,"folders":[{}],"extra":true}'].entries()) {
    const filename = path.join(base, 'invalid-' + i + '.json');
    await fs.writeFile(filename, value);
    await assert.rejects(review(filename));
  }
  const invalid = path.join(base, 'broken baseline.json');
  await fs.writeFile(invalid, '{"version":99}');
  const report = await review(await plan(base, [
    { name: 'missing baseline', root: 'good', manifest: 'absent.json' },
    { name: 'malformed baseline', root: 'good', manifest: invalid },
    { name: 'directory baseline', root: 'good', manifest: good.root },
    { name: 'good', root: 'good' },
  ]));
  assert.deepEqual(report.folders.map((row) => row.status), ['error', 'error', 'error', 'match']);
  assert.ok(report.folders.slice(0, 3).every((row) => row.error.stage === 'baseline' && row.counts === null));
});

test('cooperative cancellation retains completed comparisons and labels unattempted folders', async (t) => {
  const base = await fixture(t);
  await baseline(path.join(base, 'good'));
  const input = await plan(base, ['one', 'two', 'three'].map((name) => ({ name, root: 'good' })));
  const controller = new AbortController();
  const report = await review(input, { signal: controller.signal, onProgress(event) {
    if (event.phase === 'checking') controller.abort('SIGINT');
  } });
  assert.deepEqual(report.folders.map((row) => row.status), ['match', 'skipped', 'skipped']);
  assert.equal(report.summary.attempted, 1);
  assert.equal(report.summary.checked, 1);
  assert.equal(report.state, 'cancelled');
  assert.equal(report.exitCode, 130);
  assert.equal(report.folders[1].startedAt, null);
  assert.equal(report.folders[1].counts, null);
  assert.match(markdown(report), /Checked \*\*1\/3\*\*/);
  const before = await review(input, { signal: AbortSignal.abort('SIGTERM') });
  assert.equal(before.summary.checked, 0);
  assert.equal(before.summary.skipped, 3);
  assert.equal(before.exitCode, 143);
  await receipt(await deliver(report, path.join(base, 'cancelled')));
});

test('difference reasons include same-size hashes, type changes and link targets; Markdown treats data as data', async (t) => {
  const base = await fixture(t);
  const root = path.join(base, 'root');
  await fs.mkdir(root);
  const tricky = 'pipe | <img src=x> & [link](evil) ' + String.fromCharCode(96) + '\n世界.txt';
  await fs.writeFile(path.join(root, tricky), 'abcd');
  await fs.mkdir(path.join(root, 'kind'));
  await fs.symlink('outside one', path.join(root, 'link'));
  const manifest = path.join(base, 'baseline.json');
  await fs.writeFile(manifest, JSON.stringify(await createManifest(root)));
  await fs.writeFile(path.join(root, tricky), 'wxyz');
  await fs.rmdir(path.join(root, 'kind'));
  await fs.writeFile(path.join(root, 'kind'), 'now a file');
  await fs.unlink(path.join(root, 'link'));
  await fs.symlink('outside two', path.join(root, 'link'));
  const maliciousName = tricky + ' *pretend verdict* _emphasis_ ![image](https://example.invalid/a.png)';
  const report = await review(await plan(base, [{ name: maliciousName, root, manifest }]));
  const md = markdown(report);
  assert.equal(report.exitCode, 1);
  assert.equal(report.summary.entries.changed, 3);
  assert.match(md, /SHA-256 changed/);
  assert.match(md, /type: directory → file/);
  assert.match(md, /symlink target:/);
  assert.ok(!md.includes('<code>'));
  assert.ok(!md.includes('<img'));
  assert.ok(md.includes('\\u007c'));
  assert.ok(md.includes('\\u0060'));
  assert.ok(md.includes('\\n世界.txt'));
  const code = new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + '\n]*)' + String.fromCharCode(96), 'gu');
  const values = [...md.matchAll(code)].map(match => JSON.parse(match[1]));
  assert.ok(values.includes(tricky));
  assert.ok(values.includes(maliciousName));
  const prose = md.replace(code, '');
  assert.ok(!prose.includes('[link](evil)'));
  assert.ok(!prose.includes('*pretend verdict*'));
  assert.ok(!prose.includes('_emphasis_'));
  assert.ok(!prose.includes('![image]'));
  assert.equal(report.folders[0].name, maliciousName);
});

test('real unsupported FIFO is an inspection error, not a missing/extra difference', async (t) => {
  if (process.platform === 'win32') return t.skip('mkfifo is a POSIX check');
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const damaged = path.join(base, 'with FIFO');
  await fs.cp(good.root, damaged, { recursive: true });
  const made = spawnSync('mkfifo', [path.join(damaged, 'pipe')]);
  if (made.error?.code === 'ENOENT') return t.skip('mkfifo not installed');
  assert.equal(made.status, 0);
  const report = await review(await plan(base, [
    { name: 'FIFO', root: damaged }, { name: 'valid after error', root: good.root },
  ]));
  assert.equal(report.folders[0].error.stage, 'inspection');
  assert.match(report.folders[0].error.message, /Unsupported filesystem entry/);
  assert.equal(report.folders[0].counts, null);
  assert.equal(report.folders[1].status, 'match');
});
