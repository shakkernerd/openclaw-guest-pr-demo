'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const textPath = (value) => typeof value === 'string' && value.length > 0 &&
  !value.includes('\0') && value.isWellFormed();

function stable(a, b) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);
}

// Do not block on a FIFO or follow a final symlink masquerading as JSON.
async function readJsonFile(filename) {
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile()) throw new Error('JSON input must be a regular file, not a symlink');
  const handle = await fs.open(filename, constants.O_RDONLY |
    (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !stable(before, opened)) throw new Error('JSON input changed while opening');
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== opened.size || !stable(opened, await handle.stat({ bigint: true })) ||
        !stable(opened, await fs.lstat(filename, { bigint: true }))) {
      throw new Error('JSON input changed while reading');
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

// Resolve missing paths without normalizing a symlink target prematurely:
// in 'hop/../late', hop must be followed BEFORE applying '..'.
async function potentialRealpath(filename) {
  try { return await fs.realpath(filename); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }

  let current = path.parse(filename).root;
  const split = value => (process.platform === 'win32'
    ? value.replaceAll(String.fromCharCode(92), '/') : value).split('/');
  let pending = split(filename.slice(current.length));
  let links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (part === '' || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    let info;
    try { info = await fs.lstat(next); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      current = next; // Retain a missing component; later '..' is still ordered.
      continue;
    }
    if (info.isSymbolicLink()) {
      if (++links > 40) throw Object.assign(new Error('Too many symlinks while checking report location'), { code: 'ELOOP' });
      const target = await fs.readlink(next);
      const anchor = path.parse(target).root;
      if (anchor && !path.isAbsolute(target)) {
        throw Object.assign(new Error('Drive-relative symlink target is unsupported'), { code: 'EINVAL' });
      }
      if (anchor) current = path.resolve(current, anchor); // Anchor only, not target components.
      pending = [...split(target.slice(anchor.length)), ...pending];
    } else {
      current = await fs.realpath(next); // Preserve canonical filesystem casing.
    }
  }
  return current;
}

async function reportLocation(report, destination) {
  if (!textPath(destination)) throw new Error('Output directory must be a nonempty path');
  const logical = path.resolve(destination);
  const parent = await fs.realpath(path.dirname(logical));
  if (!(await fs.stat(parent)).isDirectory()) throw new Error('Output parent must already be a directory');
  const output = path.join(parent, path.basename(logical));
  const protectedPaths = [report.source, ...report.folders.flatMap((row) => [row.root, row.manifest])].filter(Boolean);
  for (const source of protectedPaths) {
    const candidates = [path.resolve(source)];
    try { candidates.push(await potentialRealpath(source)); }
    catch (error) {
      // These paths cannot be inspected or traversed by this process. Retain
      // lexical overlap checks, but do not let one bad row veto safe delivery
      // elsewhere. Unexpected storage failures still fail closed.
      if (!['ELOOP', 'EACCES', 'EPERM', 'ENAMETOOLONG', 'EINVAL'].includes(error.code)) throw error;
    }
    for (const candidate of candidates) {
      if (inside(candidate, output) || inside(output, candidate)) {
        throw new Error('Report directory overlaps an input path: ' + JSON.stringify(source));
      }
    }
  }
  return output;
}

async function writeNew(filename, content) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); }
  finally { await handle.close(); }
}

// mkdir is the exclusive reservation; the receipt is written LAST. Never remove
// partial files: they may be the only evidence of an interrupted delivery.
async function deliver(report, destination, markdown) {
  const output = await reportLocation(report, destination);
  try { await fs.mkdir(output, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Refusing to overwrite existing report path: ' + JSON.stringify(output));
    throw error;
  }
  try {
    const contents = {
      'report.json': JSON.stringify(report, null, 2) + '\n',
      'report.md': markdown,
    };
    const files = {};
    for (const [name, content] of Object.entries(contents)) {
      await writeNew(path.join(output, name), content);
      files[name] = { bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
    }
    await writeNew(path.join(output, 'COMPLETE.json'), JSON.stringify({
      version: 1, runId: report.runId, files,
    }, null, 2) + '\n');
    return output;
  } catch (error) {
    throw new Error('Incomplete delivery at ' + JSON.stringify(output) +
      '; keep it and choose a NEW output directory. ' + error.message, { cause: error });
  }
}

module.exports = { textPath, readJsonFile, deliver };
