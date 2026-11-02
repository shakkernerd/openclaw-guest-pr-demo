#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createManifest, verifyManifest, parseManifest, serializeManifest } = require('./index.js');

const usage = `Usage:
  directory-manifest create ROOT [MANIFEST]
  directory-manifest verify ROOT [MANIFEST] [--json]

MANIFEST defaults to ROOT/.directory-manifest.json. Explicit paths are relative
to the working directory. Create refuses to overwrite any existing path.
Use -- before positional paths that begin with a dash.
Exit codes: 0 success, 1 differences, 2 invalid input or I/O failure.
`;

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Expand external aliases one component at a time. A single realpath(parent)
// could enter the tree through an alias and silently follow an in-tree link.
async function manifestParent(root, absolute) {
  let current = path.parse(absolute).root;
  const split = (value) => value.split(process.platform === 'win32' ? /[\\/]/u : '/');
  let pending = split(absolute.slice(current.length));
  let links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (part === '' || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    const info = await fs.lstat(next);
    if (info.isSymbolicLink()) {
      if (inside(root, next)) throw new Error('Manifest parent must be a directory, not an in-tree symlink');
      if (++links > 40) throw new Error('Too many manifest parent symlinks');
      const target = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(await fs.readlink(next, { encoding: 'buffer' }));
      const anchor = path.parse(target).root;
      if (anchor && !path.isAbsolute(target)) throw new Error('Drive-relative manifest parent symlink is unsupported');
      if (anchor) current = anchor;
      // Do not normalize the target: its own links and .. components must be
      // visited in order, not collapsed before the in-tree checks.
      pending = [...split(target.slice(anchor.length)), ...pending];
    } else {
      if (!info.isDirectory()) throw new Error('Manifest parent must be a directory');
      current = await fs.realpath(next); // Also canonicalize filesystem casing.
    }
  }
  return current;
}

// Resolve an explicitly chosen external location, but never traverse links in
// the selected tree to reach a manifest. Parent directories must already exist.
async function locations(rootInput, manifestInput) {
  const logicalRoot = path.resolve(rootInput);
  if (!(await fs.lstat(logicalRoot)).isDirectory()) throw new Error('Root must be a directory, not a symlink');
  const root = await fs.realpath(logicalRoot);
  let filename = path.resolve(manifestInput ?? path.join(root, '.directory-manifest.json'));
  if (inside(logicalRoot, filename)) filename = path.join(root, path.relative(logicalRoot, filename));
  filename = path.join(await manifestParent(root, path.dirname(filename)), path.basename(filename));
  const relative = inside(root, filename) ? path.relative(root, filename).split(path.sep).join('/') : null;
  if (relative === '') throw new Error('Manifest must be a file, not the root directory');
  return { root, filename, relative };
}

async function readManifest(filename) {
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile()) throw new Error('Manifest must be a regular file, not a symlink');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Manifest changed while opening');
    }
    const bytes = await handle.readFile();
    return parseManifest(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } finally {
    await handle.close();
  }
}

function changedReason({ expected, actual }) {
  if (expected.type !== actual.type) return `type: ${expected.type} -> ${actual.type}`;
  if (expected.type === 'symlink') return 'symlink target changed';
  const reasons = [];
  if (expected.size !== actual.size) reasons.push(`size: ${expected.size} -> ${actual.size} bytes`);
  if (expected.sha256 !== actual.sha256) reasons.push('SHA-256 changed');
  return reasons.join('; ');
}

// Presentation only: do not add counts or reasons to the public JSON result.
function textReport(result) {
  const counts = { changed: 0, missing: 0, extra: 0 };
  for (const change of result.changes) counts[change.status]++;
  const lines = [`Summary: ${counts.changed} changed, ${counts.missing} missing, ${counts.extra} extra.`];
  if (result.ok) lines.push('OK: directory matches manifest.');
  else for (const change of result.changes) {
    const reason = change.status === 'changed' ? ` (${changedReason(change)})` : '';
    lines.push(`${change.status} ${JSON.stringify(change.path)}${reason}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(usage);
    return 0;
  }
  const [command, ...rest] = argv;
  if (command !== 'create' && command !== 'verify') throw new Error(usage.trim());
  const positional = [];
  let json = false;
  let options = true;
  for (const arg of rest) {
    if (options && arg === '--') options = false;
    else if (options && arg === '--json' && command === 'verify' && !json) json = true;
    else if (options && arg.startsWith('-')) throw new Error(`Unknown or repeated option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || positional.some((arg) => arg === '')) {
    throw new Error(usage.trim());
  }
  const { root, filename, relative } = await locations(...positional);
  if (command === 'create') {
    // Check early for a helpful error; wx is the authoritative race-safe check.
    try {
      await fs.lstat(filename);
      throw new Error(`Refusing to overwrite existing manifest path: ${filename}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const manifest = await createManifest(root, { excludes: relative === null ? [] : [relative] });
    const handle = await fs.open(filename, 'wx');
    try {
      await handle.writeFile(serializeManifest(manifest), 'utf8');
    } finally {
      await handle.close();
    }
    process.stdout.write(`Created ${JSON.stringify(filename)} (${manifest.entries.length} entries).\n`);
    return 0;
  }
  const result = await verifyManifest(root, await readManifest(filename));
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(textReport(result));
  return result.ok ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`directory-manifest: ${JSON.stringify(error.message)}\n`);
  process.exitCode = 2;
});
