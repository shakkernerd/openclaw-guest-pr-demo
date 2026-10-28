#!/usr/bin/env node
'use strict';

// A reproducible real-source exercise. Only a NEW explicitly named directory is
// created. All copies, baselines, prior reports and evidence are retained.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createManifest, serializeManifest, verifyManifest, parseManifest } = require('../directory-manifest');
const { snapshot, receipt } = require('./test/helpers');

async function exercise(destination) {
  if (!destination) throw new Error('Usage: node release-folder-report/exercise.js NEW_DIRECTORY');
  const directory = path.resolve(destination);
  await fs.mkdir(directory); // exclusive; no recursive creation or cleanup
  const source = path.join(directory, 'Original release café 世界');
  const intact = path.join(directory, 'Received intact café 世界');
  const damaged = path.join(directory, 'Separate damaged copy 世界');
  await fs.mkdir(source);
  await fs.mkdir(path.join(source, 'incoming empty'));
  await fs.mkdir(path.join(source, 'docs with spaces'));
  await fs.mkdir(path.join(source, 'metadata'));
  const originals = ['index.js', 'cli.js', 'package.json', 'README.md'].map((name) => path.join(__dirname, '../directory-manifest', name));
  originals.push(path.join(__dirname, '../directory-manifest/README.md'));
  const originalsBefore = await Promise.all(originals.map(snapshot));
  for (const filename of originals.slice(0, 4)) await fs.copyFile(filename, path.join(source, path.basename(filename)));
  await fs.copyFile(originals[4], path.join(source, 'docs with spaces', 'Usage café 世界.md'));
  const relativeBaseline = 'metadata/baseline.json';
  const baseline = path.join(source, relativeBaseline);
  await fs.writeFile(baseline, serializeManifest(await createManifest(source, { excludes: [relativeBaseline] })), { flag: 'wx' });
  const sourceBefore = await snapshot(source);
  await fs.cp(source, intact, { recursive: true, force: false, errorOnExist: true });
  await fs.cp(intact, damaged, { recursive: true, force: false, errorOnExist: true });
  // Only this separately copied fixture is deliberately damaged.
  await fs.appendFile(path.join(damaged, 'README.md'), '\nChanged in the demonstration copy only.\n');
  await fs.rmdir(path.join(damaged, 'incoming empty'));
  await fs.writeFile(path.join(damaged, '追加 メモ.txt'), 'Unexpected note in damaged copy.\n', { flag: 'wx' });
  const named = (name, root) => ({ name, root: path.basename(root), manifest: path.basename(root) + '/' + relativeBaseline });
  const intactList = path.join(directory, 'intact.json');
  const batchList = path.join(directory, 'received.json');
  await fs.writeFile(intactList, JSON.stringify({ version: 1, folders: [named('Intact baseline', intact)] }, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(batchList, JSON.stringify({ version: 1, folders: [
    named('Intact release café 世界', intact),
    { name: 'Genuine input error', root: 'Folder never received', manifest: path.basename(source) + '/' + relativeBaseline },
    named('Separate damaged copy', damaged),
  ] }, null, 2) + '\n', { flag: 'wx' });
  const inspected = [source, intact, damaged, intactList, batchList];
  const before = await Promise.all(inspected.map(snapshot));
  function invoke(input, output) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), input, '--out', output], { encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  const firstDir = path.join(directory, 'report 01 intact');
  const secondDir = path.join(directory, 'report 02 batch');
  const first = invoke(intactList, firstDir);
  assert.equal(first.exitCode, 0, first.stderr);
  await receipt(firstDir);
  const firstBefore = await snapshot(firstDir);
  const second = invoke(batchList, secondDir);
  assert.equal(second.exitCode, 2, second.stderr);
  const batch = await receipt(secondDir);
  assert.deepEqual(batch.folders.map((row) => row.status), ['match', 'error', 'different']);
  assert.deepEqual(batch.summary.entries, { changed: 1, missing: 1, extra: 1 });
  const secondBefore = await snapshot(secondDir);
  const refused = invoke(batchList, secondDir);
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /Refusing to overwrite/);
  assert.deepEqual(await snapshot(firstDir), firstBefore);
  assert.deepEqual(await snapshot(secondDir), secondBefore);
  assert.deepEqual(await Promise.all(inspected.map(snapshot)), before);
  assert.deepEqual(await snapshot(source), sourceBefore);
  assert.deepEqual(await Promise.all(originals.map(snapshot)), originalsBefore);
  for (const root of [source, intact]) {
    assert.equal((await verifyManifest(root, parseManifest(await fs.readFile(path.join(root, relativeBaseline), 'utf8')))).ok, true);
  }
  const evidence = { node: process.version, platform: process.platform, directory,
    first, second, refused, summary: batch.summary,
    preserved: { originalRepositoryFiles: true, originalRelease: true, allInspectedInputs: true, bothEarlierReports: true },
    snapshots: { originals: originalsBefore, inspected: before, firstReport: firstBefore, secondReport: secondBefore } };
  await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  return { directory, summary: batch.summary, preserved: evidence.preserved };
}

if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node release-folder-report/exercise.js NEW_DIRECTORY'); process.exitCode = 2; }
  else exercise(process.argv[2]).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error.message); process.exitCode = 2;
  });
}

module.exports = { exercise };
