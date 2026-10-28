'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createManifest, serializeManifest } = require('../../directory-manifest');

const cli = path.resolve(__dirname, '../cli.js');
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'release-folder-report-test-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

async function baseline(root, { realSource = false } = {}) {
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'empty directory 世界'));
  if (realSource) {
    for (const name of ['index.js', 'cli.js', 'README.md', 'package.json']) {
      await fs.copyFile(path.resolve(__dirname, '../../directory-manifest', name), path.join(root, name));
    }
    await fs.mkdir(path.join(root, 'docs with spaces'));
    await fs.copyFile(path.resolve(__dirname, '../../directory-manifest/README.md'), path.join(root, 'docs with spaces', 'Usage café 世界.md'));
  } else await fs.writeFile(path.join(root, 'file café.txt'), 'original\n');
  const manifest = path.join(root, '.directory-manifest.json');
  await fs.writeFile(manifest, serializeManifest(await createManifest(root, { excludes: ['.directory-manifest.json'] })), { flag: 'wx' });
  return { root, manifest };
}

async function plan(base, folders, name = 'input.json') {
  const filename = path.join(base, name);
  await fs.writeFile(filename, JSON.stringify({ version: 1, folders }), { flag: 'wx' });
  return filename;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000, ...options });
}

// Contents and non-atime metadata, including directory identity and symlink text.
async function snapshot(root) {
  const rows = [];
  async function visit(filename, relative) {
    const stat = await fs.lstat(filename, { bigint: true });
    const row = { path: relative, mode: String(stat.mode), mtime: String(stat.mtimeNs),
      ctime: String(stat.ctimeNs), ino: String(stat.ino), size: String(stat.size) };
    if (stat.isFile()) row.sha256 = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    if (stat.isSymbolicLink()) row.target = await fs.readlink(filename);
    rows.push(row);
    if (stat.isDirectory()) for (const name of (await fs.readdir(filename)).sort()) {
      await visit(path.join(filename, name), relative ? relative + '/' + name : name);
    }
  }
  await visit(root, '');
  return rows;
}

async function receipt(directory) {
  const record = JSON.parse(await fs.readFile(path.join(directory, 'COMPLETE.json'), 'utf8'));
  assert.equal(record.version, 1);
  assert.deepEqual(Object.keys(record.files).sort(), ['report.json', 'report.md']);
  for (const [name, expected] of Object.entries(record.files)) {
    const bytes = await fs.readFile(path.join(directory, name));
    assert.equal(bytes.length, expected.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  }
  const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  assert.equal(record.runId, report.runId);
  return report;
}

module.exports = { fs, path, cli, fixture, baseline, plan, run, snapshot, receipt };
