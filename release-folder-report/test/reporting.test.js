'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { review, markdown, deliver } = require('..');
const { fs, path, fixture, baseline, plan, receipt } = require('./helpers');

function attention(md) {
  const start = md.indexOf('## Attention needed');
  const end = md.indexOf('## Folder details');
  assert.ok(start >= 0 && end > start);
  assert.ok(end < md.indexOf('| # | Folder |'));
  return md.slice(start, end);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('attention separates differences from errors/skips in input order without changing JSON evidence', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const changed = path.join(base, 'changed');
  await fs.cp(good.root, changed, { recursive: true });
  await fs.appendFile(path.join(changed, 'file café.txt'), 'change');
  const input = await plan(base, [
    { name: 'difference first', root: changed },
    { name: 'missing second', root: 'never received', manifest: good.manifest },
    { name: 'difference third', root: changed },
    { name: 'intact fourth', root: good.root },
    { name: 'skipped fifth', root: good.root },
  ]);
  const controller = new AbortController();
  const report = await review(input, { signal: controller.signal, onProgress(event) {
    if (event.phase === 'finished' && event.index === 4) controller.abort('SIGINT');
  } });
  const before = JSON.stringify(report);
  freeze(report);
  const md = markdown(report);
  const top = attention(md);
  assert.match(top, /Incomplete coverage: 3\/5 folders checked; 1 could not be checked, 1 skipped/);
  assert.match(top, /Content differences \(2\)/);
  assert.match(top, /Could not be checked or skipped \(2\)/);
  const groups = top.split('### Could not be checked or skipped');
  assert.ok(groups[0].indexOf('difference first') < groups[0].indexOf('difference third'));
  assert.ok(!groups[0].includes('missing second'));
  assert.ok(groups[1].indexOf('missing second') < groups[1].indexOf('skipped fifth'));
  assert.match(groups[0], /1 changed, 0 missing, 0 extra entries/);
  assert.match(groups[1], /inspection \/ ENOENT/);
  assert.match(groups[1], /cancelled before this folder was attempted/);
  assert.ok(!top.includes('intact fourth'));
  assert.match(top, /A matching manifest is not release approval/);
  const table = md.slice(md.indexOf('| # | Folder |'), md.indexOf('## 1.'));
  assert.deepEqual([...table.matchAll(/^\| (\d+) \|/gm)].map(match => Number(match[1])), [1, 2, 3, 4, 5]);
  const output = await deliver(report, path.join(base, 'report'));
  assert.deepEqual(await receipt(output), report);
  assert.equal(JSON.stringify(report), before);
  assert.equal(report.exitCode, 130);
});

test('all matches and differences-only runs state complete coverage without implying approval', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const input = await plan(base, [{ name: 'café 世界', root: good.root }]);
  const matched = await review(input);
  const top = attention(markdown(matched));
  assert.equal(matched.exitCode, 0);
  assert.match(top, /Coverage complete: \*\*1\/1 folders checked/);
  assert.match(top, /Content differences \(0\)/);
  assert.match(top, /None reported from completed checks/);
  assert.match(top, /A matching manifest is not release approval/);
  await fs.writeFile(path.join(good.root, 'extra.txt'), 'extra');
  const different = await review(input);
  const changedTop = attention(markdown(different));
  assert.equal(different.exitCode, 1);
  assert.match(changedTop, /0 changed, 0 missing, 1 extra entries/);
  assert.match(changedTop, /Could not be checked or skipped \(0\)/);
  assert.ok(!changedTop.includes('Incomplete coverage'));
});

test('all-skipped and baseline-validation errors are visibly incomplete, not no-difference approval', async (t) => {
  const base = await fixture(t);
  await baseline(path.join(base, 'good'));
  const input = await plan(base, [{ name: 'not started', root: 'good' }]);
  const skipped = await review(input, { signal: AbortSignal.abort('SIGTERM') });
  const skippedTop = attention(markdown(skipped));
  assert.equal(skipped.exitCode, 143);
  assert.match(skippedTop, /Incomplete coverage: 0\/1 folders checked; 0 could not be checked, 1 skipped/);
  assert.match(skippedTop, /None reported from completed checks/);
  assert.match(skippedTop, /\*\*skipped\*\*/);
  // Reuse the public manifest parser via review; no new validation engine.
  await fs.writeFile(path.join(base, 'invalid.json'), '{"version":99}');
  const invalid = await review(await plan(base, [{ name: 'bad baseline', root: 'good', manifest: 'invalid.json' }], 'bad-list.json'));
  const failedTop = attention(markdown(invalid));
  assert.equal(invalid.exitCode, 2);
  assert.match(failedTop, /Incomplete coverage: 0\/1 folders checked; 1 could not be checked, 0 skipped/);
  assert.match(failedTop, /not checked\*\* \(baseline\)/);
  assert.equal(invalid.folders[0].result, null);
  assert.equal(invalid.folders[0].counts, null);
});

test('HTML-free single-line code spans escape names, paths and errors losslessly without table injection', async (t) => {
  const base = await fixture(t);
  const good = await baseline(path.join(base, 'good'));
  const tick = String.fromCharCode(96);
  const tricky = '<code> & | ' + tick.repeat(3) + ' [link](evil) ![image](x) *pretend* _word_\n# injected\u2028世界';
  await fs.writeFile(path.join(good.root, tricky), 'extra');
  const input = await plan(base, [
    { name: tricky, root: good.root },
    { name: 'error with odd path', root: good.root, manifest: path.join(base, tricky + 'x'.repeat(60) + '.json') },
  ]);
  const report = await review(input);
  const before = JSON.stringify(report);
  const md = markdown(report);
  assert.ok(!/[<>]/u.test(md));
  assert.ok(!/&#?\w+;/u.test(md));
  const parts = md.split(tick);
  assert.equal(parts.length % 2, 1);
  const values = parts.filter((_, i) => i % 2 === 1).map(span => {
    assert.ok(!span.includes('|'));
    assert.ok(!span.includes('\n'));
    assert.ok(!span.includes('\u2028'));
    return JSON.parse(span);
  });
  assert.ok(values.includes(tricky));
  assert.ok(values.includes(report.folders[1].manifest));
  assert.ok(values.includes(report.folders[1].error.message));
  const fullError = Array.from(report.folders[1].error.message);
  assert.ok(fullError.length > 160);
  const topValues = attention(md).split(tick).filter((_, i) => i % 2 === 1).map(value => JSON.parse(value));
  assert.ok(topValues.includes(fullError.slice(0, 160).join('') + '…'));
  assert.ok(!topValues.includes(report.folders[1].error.message));
  assert.ok(values.includes(report.folders[0].result.changes[0].path));
  const prose = parts.filter((_, i) => i % 2 === 0).join('');
  for (const injection of ['[link](evil)', '![image](x)', '*pretend*', '# injected']) assert.ok(!prose.includes(injection));
  for (const line of md.split('\n').filter(line => line.startsWith('| '))) assert.equal(line.split('|').length, 10);
  assert.equal(JSON.stringify(report), before);
});

test('source-only handoff runs real-source checks and exercise without generated examples or local notes', async (t) => {
  const base = await fixture(t);
  const tool = path.join(base, 'release-folder-report');
  const library = path.join(base, 'directory-manifest');
  await fs.mkdir(tool);
  await fs.mkdir(library);
  for (const name of ['index.js', 'cli.js', 'package.json', 'README.md']) {
    await fs.copyFile(path.resolve(__dirname, '../../directory-manifest', name), path.join(library, name));
  }
  for (const name of ['index.js', 'io.js', 'cli.js', 'package.json', 'README.md', 'exercise.js']) {
    await fs.copyFile(path.resolve(__dirname, '..', name), path.join(tool, name));
  }
  await fs.cp(__dirname, path.join(tool, 'test'), { recursive: true });
  const readme = await fs.readFile(path.join(tool, 'README.md'), 'utf8');
  assert.ok(!readme.includes('VERIFICATION.md'));
  assert.ok(!readme.includes('example-run'));
  assert.match(readme, /Receiving-coordinator workflow/);
  // Select the existing real-filesystem suite, not this packaging test recursively.
  const checked = spawnSync(process.execPath, ['--test', 'release-folder-report/test/review.test.js'], { cwd: base, encoding: 'utf8', timeout: 20000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const exercised = spawnSync(process.execPath, ['release-folder-report/exercise.js', 'new exercise'], { cwd: base, encoding: 'utf8', timeout: 20000 });
  assert.equal(exercised.status, 0, exercised.stdout + exercised.stderr);
  assert.equal((await receipt(path.join(base, 'new exercise', 'report 02 batch'))).exitCode, 2);
});
