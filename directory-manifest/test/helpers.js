'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function fixture(t) {
  // Canonicalize macOS /var -> /private/var and similar temp-directory aliases.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'directory-manifest-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'tree with spaces');
  await fs.mkdir(root);
  return { base, root, at: (...parts) => path.join(root, ...parts) };
}

async function symlinkOrSkip(t, target, filename, type) {
  try {
    await fs.symlink(target, filename, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('Symlink creation unavailable on this Windows account');
      return false;
    }
    throw error;
  }
}

module.exports = { fixture, symlinkOrSkip };
