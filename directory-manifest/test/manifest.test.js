'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createManifest, verifyManifest, validateManifest, parseManifest, serializeManifest } = require('..');
const { fixture, symlinkOrSkip } = require('./helpers.js');

const digest = (data) => createHash('sha256').update(data).digest('hex');
const empty = () => ({ version: 1, algorithm: 'sha256', excludes: [], entries: [] });
const file = (name) => ({ path: name, type: 'file', size: 0, sha256: digest('') });
const directory = (name) => ({ path: name, type: 'directory' });

test('real files: sizes, hashes, empty directories, Unicode, spaces, binary and stable serialization', async (t) => {
  const { root, at } = await fixture(t);
  await fs.mkdir(at('empty folder'));
  await fs.mkdir(at('資料'));
  const binary = Buffer.alloc(150_001, 0xa5);
  await fs.writeFile(at('資料', 'café 😀.bin'), binary);
  await fs.writeFile(at('z.txt'), '');
  await fs.writeFile(at('a file.txt'), 'héllo\n');
  const manifest = await createManifest(root);
  assert.deepEqual(manifest.entries, [
    { path: 'a file.txt', type: 'file', size: Buffer.byteLength('héllo\n'), sha256: digest('héllo\n') },
    directory('empty folder'), file('z.txt'), directory('資料'),
    { path: '資料/café 😀.bin', type: 'file', size: binary.length, sha256: digest(binary) },
  ]);
  assert.equal(serializeManifest(manifest), serializeManifest(await createManifest(root)));
  assert.deepEqual(parseManifest(serializeManifest(manifest)), manifest);
  assert.deepEqual(await verifyManifest(root, manifest), { ok: true, changes: [] });
});

test('inspection preserves file bytes, mode, mtime and link count', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('data'), 'leave me alone', { mode: 0o640 });
  await fs.utimes(at('data'), new Date('2020-01-02'), new Date('2020-01-02'));
  const before = await fs.stat(at('data'), { bigint: true });
  const manifest = await createManifest(root);
  await verifyManifest(root, manifest);
  const after = await fs.stat(at('data'), { bigint: true });
  assert.equal(await fs.readFile(at('data'), 'utf8'), 'leave me alone');
  for (const key of ['mode', 'mtimeNs', 'size', 'nlink', 'ino']) assert.equal(after[key], before[key], key);
  assert.deepEqual(await fs.readdir(root), ['data']);
});

test('changed, missing and extra entries are globally sorted; same-size edits and type changes count', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('z missing'), 'gone');
  await fs.writeFile(at('b changed'), 'old');
  await fs.mkdir(at('c type'));
  await fs.writeFile(at('c type', 'child'), 'child');
  await fs.writeFile(at('d grows'), 'x');
  const manifest = await createManifest(root);
  await fs.unlink(at('z missing'));
  await fs.writeFile(at('b changed'), 'new');
  await fs.rm(at('c type'), { recursive: true });
  await fs.writeFile(at('c type'), 'file now');
  await fs.writeFile(at('d grows'), 'bigger');
  await fs.mkdir(at('a extra'));
  const result = await verifyManifest(root, manifest);
  assert.equal(result.ok, false);
  assert.deepEqual(result.changes.map(({ path, status }) => [path, status]), [
    ['a extra', 'extra'], ['b changed', 'changed'], ['c type', 'changed'],
    ['c type/child', 'missing'], ['d grows', 'changed'], ['z missing', 'missing'],
  ]);
  assert.equal(result.changes[1].expected.sha256, digest('old'));
  assert.equal(result.changes[1].actual.sha256, digest('new'));
  assert.equal(await fs.readFile(at('b changed'), 'utf8'), 'new');
});

test('empty root and exact exclusions; no accidental subtree exclusion', async (t) => {
  const { root, at } = await fixture(t);
  assert.deepEqual(await createManifest(root), empty());
  await fs.mkdir(at('meta'));
  const manifest = await createManifest(root, { excludes: ['meta/snapshot.json'] });
  await fs.writeFile(at('meta', 'snapshot.json'), serializeManifest(manifest));
  assert.deepEqual(await verifyManifest(root, manifest), { ok: true, changes: [] });
  await fs.writeFile(at('meta', 'snapshot.json.backup'), 'extra');
  assert.deepEqual((await verifyManifest(root, manifest)).changes.map((entry) => entry.path), ['meta/snapshot.json.backup']);
  await assert.rejects(createManifest(root, { excludes: ['meta'] }), /Excluded path is a directory/);
  await fs.unlink(at('meta', 'snapshot.json'));
  await fs.mkdir(at('meta', 'snapshot.json'));
  await assert.rejects(verifyManifest(root, manifest), /Excluded path is a directory/);
});

test('links are opaque: outside, dangling, directory and cycle targets are never traversed', async (t) => {
  const { base, root, at } = await fixture(t);
  await fs.mkdir(path.join(base, 'outside'));
  await fs.writeFile(path.join(base, 'outside', 'secret'), 'not inventoried');
  if (!await symlinkOrSkip(t, '../outside', at('outside'), 'dir')) return;
  await fs.symlink('missing', at('dangling'), 'file');
  await fs.symlink('.', at('cycle'), 'dir');
  await fs.mkdir(at('folder'));
  await fs.writeFile(at('folder', 'file'), 'inside');
  await fs.symlink('folder', at('internal'), 'dir');
  const manifest = await createManifest(root);
  assert.equal(manifest.entries.length, 6);
  assert.deepEqual(manifest.entries.find((entry) => entry.path === 'outside'),
    { path: 'outside', type: 'symlink', target: '../outside' });
  assert(!manifest.entries.some((entry) => entry.path.startsWith('outside/')));
  await fs.writeFile(path.join(base, 'outside', 'secret'), 'changed outside');
  assert.equal((await verifyManifest(root, manifest)).ok, true);
  await fs.unlink(at('dangling'));
  await fs.symlink('other-missing', at('dangling'), 'file');
  assert.deepEqual((await verifyManifest(root, manifest)).changes.map(({ path, status }) => [path, status]), [['dangling', 'changed']]);
  await assert.rejects(createManifest(at('internal')), /Root must be a directory/);
  await assert.rejects(createManifest(`${at('internal')}${path.sep}`), /Root must be a directory/);
});

test('file replaced by outside symlink is changed, not hashed through the link', async (t) => {
  const { base, root, at } = await fixture(t);
  await fs.writeFile(at('entry'), 'before');
  const manifest = await createManifest(root);
  await fs.unlink(at('entry'));
  if (!await symlinkOrSkip(t, path.join(base, 'does-not-exist'), at('entry'), 'file')) return;
  const result = await verifyManifest(root, manifest);
  assert.equal(result.changes[0].status, 'changed');
  assert.equal(result.changes[0].actual.type, 'symlink');
});

for (const unsafe of ['', '.', '..', '../escape', 'a/../b', '/absolute', '//server/share',
  'a//b', 'a/./b', 'a/', 'a\\b', 'C:/windows', 'C:relative', 'a:b', 'a\0b', '\ud800']) {
  test(`reject unsafe manifest path ${JSON.stringify(unsafe)}`, async () => {
    const manifest = { ...empty(), entries: [file(unsafe)] };
    assert.throws(() => validateManifest(manifest), /Invalid manifest/);
    assert.throws(() => validateManifest({ ...empty(), excludes: [unsafe] }), /Invalid manifest/);
    // Validation must happen before any filesystem operation.
    await assert.rejects(verifyManifest('/this-root-does-not-exist', manifest), /Invalid manifest/);
  });
}

test('reject malformed shapes, duplicates, conflicting parents, bad metadata and exclusions', () => {
  const bad = [null, [], {}, { ...empty(), version: 2 }, { ...empty(), algorithm: 'md5' },
    { ...empty(), extra: true }, { ...empty(), entries: null }, { ...empty(), excludes: 'file' },
    { ...empty(), entries: [null] }, { ...empty(), entries: [file('a'), file('a')] },
    { ...empty(), entries: [directory('a'), file('a')] },
    { ...empty(), entries: [file('a/b')] },
    { ...empty(), entries: [file('a'), file('a/b')] },
    { ...empty(), entries: [{ path: 'a', type: 'symlink', target: '../elsewhere' }, file('a/b')] },
    { ...empty(), excludes: ['a', 'a'] }, { ...empty(), excludes: ['a', 'a/b'] },
    { ...empty(), excludes: ['a'], entries: [file('a')] },
    { ...empty(), excludes: ['missing/parent'] },
    ...[-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', NaN, Infinity].map((size) => ({ ...empty(), entries: [{ ...file('a'), size }] })),
    ...['', 'A'.repeat(64), 'z'.repeat(64), 123].map((sha256) => ({ ...empty(), entries: [{ ...file('a'), sha256 }] })),
    { ...empty(), entries: [{ ...directory('a'), size: 0 }] },
    { ...empty(), entries: [{ path: 'a', type: 'device' }] },
    ...['', null, '\0', '\ud800'].map((target) => ({ ...empty(), entries: [{ path: 'a', type: 'symlink', target }] })),
  ];
  for (const manifest of bad) assert.throws(() => validateManifest(manifest), /Invalid manifest/);
  assert.throws(() => parseManifest('{not json'), SyntaxError);
  assert.throws(() => parseManifest(Buffer.from('{}')), /must be a string/);
});

test('canonicalization sorts copies, preserves spelling and does not mutate caller objects', () => {
  const manifest = { ...empty(), excludes: ['z', 'a'], entries: [file('é'), file('é'), directory('__proto__')] };
  const before = JSON.stringify(manifest);
  const copy = validateManifest(manifest);
  assert.deepEqual(copy.entries.map((entry) => entry.path), ['__proto__', 'é', 'é']);
  assert.deepEqual(copy.excludes, ['a', 'z']);
  copy.entries[0].path = 'changed';
  assert.equal(JSON.stringify(manifest), before);
});

test('unsupported stat types fail rather than being silently omitted', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('special'), 'data');
  const lstat = fs.lstat;
  // Node has no portable mknod/mkfifo; substitute only the type of a real stat.
  t.mock.method(fs, 'lstat', async (filename, options) => {
    const info = await lstat(filename, options);
    if (filename === at('special')) info.isFile = () => false;
    return info;
  });
  await assert.rejects(createManifest(root), /Unsupported filesystem entry/);
});

test('read failures abort without returning a partial manifest', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('unreadable'), 'still here');
  const open = fs.open;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (filename === at('unreadable')) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
    return open(filename, ...args);
  });
  await assert.rejects(createManifest(root), { code: 'EACCES' });
  assert.equal(await fs.readFile(at('unreadable'), 'utf8'), 'still here');
});

test('file changes between stat and open are detected and the handle is closed', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('changing'), 'before');
  const open = fs.open;
  let opened;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await open(filename, ...args);
    if (filename === at('changing')) {
      opened = handle;
      await fs.writeFile(filename, 'a different size');
    }
    return handle;
  });
  await assert.rejects(createManifest(root), /changed during inspection/);
  assert.equal(opened.fd, -1);
});

test('non-portable and invalid UTF-8 filesystem names fail rather than being rewritten', { skip: process.platform === 'win32' }, async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('a\\b'), 'data');
  await assert.rejects(createManifest(root), /unsafe relative path/);
  await fs.unlink(at('a\\b'));
  if (process.platform === 'linux') {
    const invalid = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]);
    await fs.writeFile(invalid, 'data');
    await assert.rejects(createManifest(root), /encoded data was not valid/);
  }
});
