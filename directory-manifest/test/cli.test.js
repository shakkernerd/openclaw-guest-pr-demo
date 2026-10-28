'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createManifest, verifyManifest, serializeManifest } = require('..');
const { fixture, symlinkOrSkip } = require('./helpers.js');
const cli = path.resolve(__dirname, '../cli.js');

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('CLI default manifest lives in the tree, excludes itself, verifies and refuses overwrites', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('hello 世界.txt'), 'hello');
  await fs.mkdir(at('empty'));
  const original = await fs.stat(at('hello 世界.txt'), { bigint: true });
  const created = run(['create', root]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.stderr, '');
  const bytes = await fs.readFile(at('.directory-manifest.json'), 'utf8');
  const manifest = JSON.parse(bytes);
  assert.deepEqual(manifest.excludes, ['.directory-manifest.json']);
  assert.deepEqual(manifest.entries.map((entry) => entry.path), ['empty', 'hello 世界.txt']);
  const verified = run(['verify', root]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout, 'Summary: 0 changed, 0 missing, 0 extra.\nOK: directory matches manifest.\n');
  const json = run(['verify', root, '--json']);
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, changes: [] });
  assert.equal(json.status, 0);
  const again = run(['create', root]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /Refusing to overwrite/);
  assert.equal(await fs.readFile(at('.directory-manifest.json'), 'utf8'), bytes);
  assert.equal((await fs.stat(at('hello 世界.txt'), { bigint: true })).mtimeNs, original.mtimeNs);
  assert.equal(await fs.readFile(at('hello 世界.txt'), 'utf8'), 'hello');
});

test('CLI text and JSON differences have deterministic path order and exit 1', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('b same size'), 'old');
  await fs.writeFile(at('z removed'), 'gone');
  assert.equal(run(['create', root]).status, 0);
  await fs.writeFile(at('b same size'), 'new');
  await fs.unlink(at('z removed'));
  await fs.mkdir(at('a added'));
  const text = run(['verify', root]);
  assert.equal(text.status, 1, text.stderr);
  assert.equal(text.stdout, 'Summary: 1 changed, 1 missing, 1 extra.\n' +
    'extra "a added"\nchanged "b same size" (SHA-256 changed)\nmissing "z removed"\n');
  const json = run(['verify', '--json', root]);
  assert.equal(json.status, 1, json.stderr);
  assert.equal(json.stderr, '');
  const result = JSON.parse(json.stdout);
  const manifest = JSON.parse(await fs.readFile(at('.directory-manifest.json'), 'utf8'));
  assert.deepEqual(result, await verifyManifest(root, manifest));
  assert.deepEqual(Object.keys(result), ['ok', 'changes']);
  for (const entry of result.changes) {
    assert.deepEqual(Object.keys(entry), entry.status === 'changed'
      ? ['path', 'status', 'expected', 'actual']
      : ['path', 'status', entry.status === 'missing' ? 'expected' : 'actual']);
  }
  assert.equal(result.ok, false);
  assert.deepEqual(result.changes.map(({ path, status }) => [path, status]),
    [['a added', 'extra'], ['b same size', 'changed'], ['z removed', 'missing']]);
  assert.equal(run(['verify', '--json', root]).stdout, json.stdout);
  assert.equal(await fs.readFile(at('b same size'), 'utf8'), 'new');
  await assert.rejects(fs.stat(at('z removed')), { code: 'ENOENT' });
});

test('CLI explicit external and nested manifests, relative paths and -- delimiter', async (t) => {
  const { base, root, at } = await fixture(t);
  await fs.writeFile(at('file'), 'data');
  const external = path.join(base, 'outside manifest.json');
  assert.equal(run(['create', path.basename(root), path.basename(external)], base).status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(external, 'utf8')).excludes, []);
  assert.equal(run(['verify', root, external]).status, 0);
  await fs.mkdir(at('meta'));
  const nested = at('meta', 'snapshot.json');
  const created = run(['create', root, nested]);
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(nested, 'utf8')).excludes, ['meta/snapshot.json']);
  assert.equal(run(['verify', root, nested]).status, 0);
  const dashed = path.join(base, '-tree');
  await fs.mkdir(dashed);
  assert.equal(run(['create', '--', '-tree', '-snapshot.json'], base).status, 0);
  assert.equal(run(['verify', '--json', '--', '-tree', '-snapshot.json'], base).status, 0);
});

test('moving a self-contained tree and its manifest keeps it verifiable', async (t) => {
  const { base, root, at } = await fixture(t);
  await fs.mkdir(at('資料'));
  await fs.writeFile(at('資料', 'a file'), 'portable');
  assert.equal(run(['create', root]).status, 0);
  const moved = path.join(base, 'moved tree');
  await fs.rename(root, moved);
  const result = run(['verify', moved]);
  assert.equal(result.status, 0, result.stderr);
});

test('CLI validation and I/O errors use exit 2 without creating or changing files', async (t) => {
  const { base, root, at } = await fixture(t);
  await fs.writeFile(at('data'), 'safe');
  const external = path.join(base, 'manifest.json');
  const valid = await createManifest(root);
  const invalid = [
    '{bad JSON',
    JSON.stringify({ ...valid, entries: [...valid.entries, valid.entries[0]] }),
    JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], path: '../escape' }] }),
    JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], sha256: 'bad' }] }),
    Buffer.from([0xff]),
  ];
  for (const content of invalid) {
    await fs.writeFile(external, content);
    const result = run(['verify', root, external, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
  }
  for (const args of [[], ['unknown'], ['create'], ['verify'], ['create', root, '--json'],
    ['verify', root, '--json', '--json'], ['create', root, 'one', 'two'], ['create', root, '--wat'],
    ['verify', root, path.join(base, 'absent')], ['create', path.join(base, 'absent')],
    ['create', at('data')], ['create', root, at('missing-parent', 'manifest')], ['create', root, root]]) {
    const result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await fs.readdir(root), ['data']);
  assert.equal(await fs.readFile(at('data'), 'utf8'), 'safe');
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, '');
});

test('CLI never overwrites a data file, directory, or final output symlink', async (t) => {
  const { base, root, at } = await fixture(t);
  await fs.writeFile(at('data'), 'original');
  await fs.mkdir(at('directory'));
  for (const output of [at('data'), at('directory')]) {
    assert.equal(run(['create', root, output]).status, 2);
  }
  const outside = path.join(base, 'outside');
  await fs.writeFile(outside, 'outside original');
  if (!await symlinkOrSkip(t, outside, at('output-link'), 'file')) return;
  assert.equal(run(['create', root, at('output-link')]).status, 2);
  assert.equal(run(['verify', root, at('output-link')]).status, 2);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside original');
  assert.equal(await fs.readFile(at('data'), 'utf8'), 'original');
});

test('CLI rejects a manifest parent symlink instead of writing outside the tree', async (t) => {
  const { base, root, at } = await fixture(t);
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  if (!await symlinkOrSkip(t, outside, at('escape'), 'dir')) return;
  const result = run(['create', root, at('escape', 'manifest.json')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Manifest parent/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(root), ['escape']);
  assert.equal(run(['create', at('escape')]).status, 2);
});

test('external aliases cannot bypass the in-tree manifest-parent symlink policy', async (t) => {
  const { base, root, at } = await fixture(t);
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  if (!await symlinkOrSkip(t, outside, at('escape'), 'dir')) return;
  const alias = path.join(base, 'alias');
  const shortcut = path.join(base, 'shortcut');
  await fs.symlink(root, alias, 'dir');
  // The symlink's target itself also needs component-by-component checking.
  await fs.symlink(at('escape'), shortcut, 'dir');
  const saved = serializeManifest(await createManifest(root));
  await fs.writeFile(path.join(outside, 'saved.json'), saved);
  assert.equal(run(['verify', root, path.join(outside, 'saved.json')]).status, 0);
  for (const parent of [at('escape'), path.join(alias, 'escape'), shortcut]) {
    for (const [command, name] of [['create', 'new.json'], ['verify', 'saved.json']]) {
      const result = run([command, root, path.join(parent, name)]);
      assert.equal(result.status, 2, command + ': ' + parent);
      assert.match(result.stderr, /Manifest parent/);
      assert.equal(result.stdout, '');
    }
  }
  assert.deepEqual(await fs.readdir(outside), ['saved.json']);
  assert.equal(await fs.readFile(path.join(outside, 'saved.json'), 'utf8'), saved);
});

test('a harmless external alias into the root still gets exact self-exclusion', async (t) => {
  const { base, root, at } = await fixture(t);
  await fs.writeFile(at('data'), 'data');
  await fs.mkdir(path.join(base, 'aliases'));
  const alias = path.join(base, 'aliases', 'alias');
  if (!await symlinkOrSkip(t, path.join('..', path.basename(root)), alias, 'dir')) return;
  const source = path.join(alias, 'snapshot.json');
  const created = run(['create', root, source]);
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(at('snapshot.json'), 'utf8')).excludes, ['snapshot.json']);
  assert.equal(run(['verify', root, source]).status, 0);
});

test('cyclic external manifest-parent aliases fail instead of hanging', async (t) => {
  const { base, root } = await fixture(t);
  const alias = path.join(base, 'loop');
  if (!await symlinkOrSkip(t, 'loop', alias, 'dir')) return;
  for (const command of ['create', 'verify']) {
    const result = run([command, root, path.join(alias, 'manifest.json')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Too many manifest parent symlinks/);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test('CLI rejects malicious manifests before traversing the claimed paths', async (t) => {
  const { base, root } = await fixture(t);
  const manifest = await createManifest(root);
  const source = path.join(base, 'evil.json');
  manifest.entries.push({ path: '../not-here', type: 'directory' });
  await fs.writeFile(source, JSON.stringify(manifest));
  const result = run(['verify', root, source]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsafe relative path/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('CLI quotes unusual names onto one output line', { skip: process.platform === 'win32' }, async (t) => {
  const { base, root, at } = await fixture(t);
  const source = path.join(base, 'manifest.json');
  await fs.writeFile(source, serializeManifest(await createManifest(root)));
  await fs.writeFile(at('line\nbreak'), 'data');
  const result = run(['verify', root, source]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'Summary: 0 changed, 0 missing, 1 extra.\nextra "line\\nbreak"\n');
});

test('CLI explains size/hash and type changes, counting each entry only once', async (t) => {
  const { root, at } = await fixture(t);
  await fs.writeFile(at('a grows'), 'x');
  await fs.mkdir(at('b type'));
  await fs.writeFile(at('c size only'), 'abc');
  assert.equal(run(['create', root]).status, 0);
  const manifest = JSON.parse(await fs.readFile(at('.directory-manifest.json'), 'utf8'));
  // A valid baseline can claim a different size with the same digest.
  manifest.entries.find((entry) => entry.path === 'c size only').size = 4;
  await fs.writeFile(at('.directory-manifest.json'), serializeManifest(manifest));
  await fs.writeFile(at('a grows'), 'more');
  await fs.rmdir(at('b type'));
  await fs.writeFile(at('b type'), 'now a file');
  const result = run(['verify', root]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, 'Summary: 3 changed, 0 missing, 0 extra.\n' +
    'changed "a grows" (size: 1 -> 4 bytes; SHA-256 changed)\n' +
    'changed "b type" (type: directory -> file)\n' +
    'changed "c size only" (size: 4 -> 3 bytes)\n');
  const json = run(['verify', root, '--json']);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), await verifyManifest(root, manifest));
});

test('CLI distinguishes symlink target changes from entry type changes', async (t) => {
  const { root, at } = await fixture(t);
  if (!await symlinkOrSkip(t, 'old target 世界', at('a link'), 'file')) return;
  await fs.symlink('missing', at('b type'), 'file');
  assert.equal(run(['create', root]).status, 0);
  await fs.unlink(at('a link'));
  await fs.symlink('new target', at('a link'), 'file');
  await fs.unlink(at('b type'));
  await fs.writeFile(at('b type'), 'regular file');
  const result = run(['verify', root]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, 'Summary: 2 changed, 0 missing, 0 extra.\n' +
    'changed "a link" (symlink target changed)\n' +
    'changed "b type" (type: symlink -> file)\n');
});

test('release handoff: actual source/docs, empty incoming, relocation and isolated damage', async (t) => {
  const { base, root, at } = await fixture(t);
  const source = path.resolve(__dirname, '..');
  for (const name of ['index.js', 'cli.js', 'package.json', 'README.md']) {
    await fs.copyFile(path.join(source, name), at(name));
  }
  for (const name of ['docs', 'incoming', 'metadata']) await fs.mkdir(at(name));
  await fs.copyFile(path.join(source, 'README.md'), at('docs', 'Usage café 世界.md'));
  const manifestPath = at('metadata', 'manifest.json');
  const created = run(['create', root, manifestPath]);
  assert.equal(created.status, 0, created.stderr);
  const saved = await fs.readFile(manifestPath);
  const manifest = JSON.parse(saved);
  assert.equal(manifest.entries.length, 8);
  assert.deepEqual(manifest.excludes, ['metadata/manifest.json']);
  assert(!manifest.entries.some((entry) => entry.path === 'metadata/manifest.json'));
  assert(manifest.entries.some((entry) => entry.path === 'incoming' && entry.type === 'directory'));
  const incoming = path.join(base, 'incoming transfer');
  await fs.mkdir(incoming);
  const empty = run(['verify', incoming, manifestPath]);
  assert.equal(empty.status, 1, empty.stderr);
  assert.equal(empty.stdout, 'Summary: 0 changed, 8 missing, 0 extra.\n' +
    manifest.entries.map((entry) => 'missing ' + JSON.stringify(entry.path) + '\n').join(''));
  assert.deepEqual(await fs.readdir(incoming), []);
  for (const name of await fs.readdir(root)) {
    await fs.cp(at(name), path.join(incoming, name), { recursive: true, force: false, errorOnExist: true });
  }
  assert.equal(run(['verify', incoming, path.join(incoming, 'metadata', 'manifest.json')]).status, 0);
  const consumer = path.join(base, 'Release café 世界');
  await fs.rename(incoming, consumer);
  const consumerManifest = path.join(consumer, 'metadata', 'manifest.json');
  const relocated = run(['verify', consumer, consumerManifest]);
  assert.equal(relocated.status, 0, relocated.stderr);
  assert.equal(relocated.stdout, 'Summary: 0 changed, 0 missing, 0 extra.\nOK: directory matches manifest.\n');
  const bundled = spawnSync(process.execPath, [path.join(consumer, 'cli.js'),
    'verify', '.', 'metadata/manifest.json'], { cwd: consumer, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(bundled.error);
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.equal(bundled.stdout, relocated.stdout);
  const consumerSnapshot = await createManifest(consumer); // Includes saved manifest bytes.
  const disposable = path.join(base, 'disposable review');
  await fs.cp(consumer, disposable, { recursive: true, force: false, errorOnExist: true });
  const originalReadme = await fs.readFile(path.join(consumer, 'README.md'));
  const addition = '\nConsumer-only trial edit.\n';
  await fs.appendFile(path.join(disposable, 'README.md'), addition);
  await fs.rmdir(path.join(disposable, 'incoming'));
  await fs.writeFile(path.join(disposable, '追加 メモ.txt'), 'Unexpected file.\n');
  const disposableManifest = path.join(disposable, 'metadata', 'manifest.json');
  const changed = run(['verify', disposable, disposableManifest]);
  assert.equal(changed.status, 1, changed.stderr);
  assert.equal(changed.stdout, 'Summary: 1 changed, 1 missing, 1 extra.\n' +
    'changed "README.md" (size: ' + originalReadme.length + ' -> ' +
    (originalReadme.length + Buffer.byteLength(addition)) + ' bytes; SHA-256 changed)\n' +
    'missing "incoming"\nextra "追加 メモ.txt"\n');
  assert.equal(run(['verify', disposable, disposableManifest]).stdout, changed.stdout);
  const json = run(['verify', disposable, disposableManifest, '--json']);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), await verifyManifest(disposable, manifest));
  assert.deepEqual(await createManifest(consumer), consumerSnapshot);
  assert.deepEqual(await fs.readFile(consumerManifest), saved);
  assert.deepEqual(await fs.readFile(disposableManifest), saved);
  assert.deepEqual(await fs.readFile(path.join(consumer, 'README.md')), originalReadme);
  assert.deepEqual(await fs.readdir(path.join(consumer, 'incoming')), []);
  assert.equal(run(['verify', consumer, consumerManifest]).status, 0);
});
