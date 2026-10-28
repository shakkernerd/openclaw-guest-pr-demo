'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Deliberately independent of the host locale and filesystem enumeration order.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values) => [...values].sort(compare);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(message) {
  throw new Error(`Invalid manifest: ${message}`);
}

function validText(value) {
  return typeof value === 'string' && !value.includes('\0') && value.isWellFormed();
}

function validatePath(value) {
  if (!validText(value) || value.length === 0 || /[\\:]/u.test(value) ||
      value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail(`unsafe relative path ${JSON.stringify(value)}`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))) {
    fail(`invalid ${label} fields`);
  }
}

function validateExcludes(excludes) {
  if (!Array.isArray(excludes)) fail('excludes must be an array');
  const seen = new Set();
  for (const value of excludes) {
    validatePath(value);
    if (seen.has(value)) fail(`duplicate excluded path ${JSON.stringify(value)}`);
    seen.add(value);
  }
  for (const value of seen) {
    const parts = value.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) fail('overlapping excluded paths');
    }
  }
  return sorted(seen);
}

/** Validate strictly and return a canonical, detached copy (never rewrite paths). */
function validateManifest(manifest) {
  exactKeys(manifest, ['version', 'algorithm', 'excludes', 'entries'], 'manifest');
  if (manifest.version !== 1 || manifest.algorithm !== 'sha256') {
    fail('expected version 1 and algorithm sha256');
  }
  const excludes = validateExcludes(manifest.excludes);
  const excluded = new Set(excludes);
  if (!Array.isArray(manifest.entries)) fail('entries must be an array');
  const entries = new Map();
  for (const entry of manifest.entries) {
    if (entry === null || typeof entry !== 'object') fail('invalid entry');
    validatePath(entry.path);
    if (entries.has(entry.path)) fail(`duplicate path ${JSON.stringify(entry.path)}`);
    if (excluded.has(entry.path)) fail(`excluded entry ${JSON.stringify(entry.path)}`);
    let copy;
    if (entry.type === 'file') {
      exactKeys(entry, ['path', 'type', 'size', 'sha256'], 'file entry');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || Object.is(entry.size, -0) ||
          typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
        fail(`invalid file size or SHA-256 for ${JSON.stringify(entry.path)}`);
      }
      copy = { path: entry.path, type: 'file', size: entry.size, sha256: entry.sha256 };
    } else if (entry.type === 'directory') {
      exactKeys(entry, ['path', 'type'], 'directory entry');
      copy = { path: entry.path, type: 'directory' };
    } else if (entry.type === 'symlink') {
      exactKeys(entry, ['path', 'type', 'target'], 'symlink entry');
      if (!validText(entry.target) || entry.target.length === 0) fail('invalid link target');
      copy = { path: entry.path, type: 'symlink', target: entry.target };
    } else {
      fail(`unknown entry type for ${JSON.stringify(entry.path)}`);
    }
    entries.set(entry.path, copy);
  }
  // Every parent must be explicit and must be a directory, never a file/link.
  for (const name of [...entries.keys(), ...excludes]) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (entries.get(parent)?.type !== 'directory') {
        fail(`missing or non-directory parent ${JSON.stringify(parent)}`);
      }
    }
  }
  return { version: 1, algorithm: 'sha256', excludes,
    entries: [...entries.values()].sort((a, b) => compare(a.path, b.path)) };
}

function parseManifest(text) {
  if (typeof text !== 'string') fail('JSON input must be a string');
  return validateManifest(JSON.parse(text));
}

function serializeManifest(manifest) {
  return `${JSON.stringify(validateManifest(manifest), null, 2)}\n`;
}

async function resolveRoot(root) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('root must be a path string');
  const absolute = path.resolve(root);
  // Strip trailing separators via resolve so lstat cannot dereference a final link.
  const stat = await fs.lstat(absolute, { bigint: true });
  if (!stat.isDirectory()) throw new Error('Root must be a directory, not a symlink');
  return { root: await fs.realpath(absolute), stat };
}

function sameObject(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function unchanged(a, b) {
  return sameObject(a, b) && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function changedDuringScan(name) {
  throw new Error(`Entry changed during inspection: ${JSON.stringify(name || '.')}`);
}

async function hashFile(filename, before, name) {
  // O_NONBLOCK also prevents hanging if a regular file is replaced by a FIFO.
  const handle = await fs.open(filename, constants.O_RDONLY |
    (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !unchanged(before, opened)) changedDuringScan(name);
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`File too large: ${JSON.stringify(name)}`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > Number(opened.size)) changedDuringScan(name);
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (size !== Number(opened.size) || !unchanged(opened, await handle.stat({ bigint: true })) ||
        !unchanged(opened, await fs.lstat(filename, { bigint: true }))) changedDuringScan(name);
    return { path: name, type: 'file', size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function inventory(rootInput, excludes) {
  const { root, stat } = await resolveRoot(rootInput);
  const excluded = new Set(excludes);
  const entries = [];

  async function walk(directory, prefix, before) {
    const current = await fs.lstat(directory, { bigint: true });
    if (!current.isDirectory() || !unchanged(before, current) ||
        await fs.realpath(directory) !== directory) changedDuringScan(prefix);
    const names = (await fs.readdir(directory, { encoding: 'buffer' }))
      .map((bytes) => decoder.decode(bytes)).sort(compare);
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      validatePath(relative);
      const filename = path.join(directory, name);
      const info = await fs.lstat(filename, { bigint: true });
      if (excluded.has(relative)) {
        if (info.isDirectory()) throw new Error(`Excluded path is a directory: ${JSON.stringify(relative)}`);
        continue;
      }
      if (info.isSymbolicLink()) {
        const target = decoder.decode(await fs.readlink(filename, { encoding: 'buffer' }));
        if (!unchanged(info, await fs.lstat(filename, { bigint: true }))) changedDuringScan(relative);
        entries.push({ path: relative, type: 'symlink', target });
      } else if (info.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await walk(filename, relative, info);
      } else if (info.isFile()) {
        entries.push(await hashFile(filename, info, relative));
      } else {
        throw new Error(`Unsupported filesystem entry: ${JSON.stringify(relative)}`);
      }
    }
    if (!unchanged(before, await fs.lstat(directory, { bigint: true }))) changedDuringScan(prefix);
  }

  await walk(root, '', stat);
  return entries.sort((a, b) => compare(a.path, b.path));
}

/** Inventory without writing to the tree. Exclusions are exact non-directory paths. */
async function createManifest(root, { excludes = [] } = {}) {
  const canonicalExcludes = validateExcludes(excludes);
  return validateManifest({ version: 1, algorithm: 'sha256', excludes: canonicalExcludes,
    entries: await inventory(root, canonicalExcludes) });
}

/** Invalid manifests and I/O failures throw; ordinary differences are returned. */
async function verifyManifest(root, manifest) {
  const expected = validateManifest(manifest); // Validate before touching the filesystem.
  const actual = await inventory(root, expected.excludes);
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const changes = [];
  for (const name of sorted(new Set([...expectedByPath.keys(), ...actualByPath.keys()]))) {
    const wanted = expectedByPath.get(name);
    const found = actualByPath.get(name);
    if (!found) changes.push({ path: name, status: 'missing', expected: wanted });
    else if (!wanted) changes.push({ path: name, status: 'extra', actual: found });
    else if (wanted.type !== found.type ||
        (wanted.type === 'file' && (wanted.size !== found.size || wanted.sha256 !== found.sha256)) ||
        (wanted.type === 'symlink' && wanted.target !== found.target)) {
      changes.push({ path: name, status: 'changed', expected: wanted, actual: found });
    }
  }
  return { ok: changes.length === 0, changes };
}

module.exports = { createManifest, verifyManifest, validateManifest, parseManifest, serializeManifest };
