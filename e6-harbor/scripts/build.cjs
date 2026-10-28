'use strict';
// Offline static packaging: built-ins only; no bundler or dependency installation.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const files = ['index.html', 'styles.css', 'core.js', 'storage.js', 'app.js'];
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
assert.match(html, /connect-src 'none'/);
assert.match(html, /<meta name="viewport"/);
const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(ref => !ref.startsWith('#'));
assert.deepEqual(references.sort(), files.filter(f => f !== 'index.html').sort());
for (const name of files) {
  const source = fs.readFileSync(path.join(root, name), 'utf8');
  assert.ok(source.length > 0, name + ' is empty');
  assert.doesNotMatch(source, /https?:\/\/|@import|@font-face/, name + ' must not reference external resources');
  if (name.endsWith('.js')) {
    new vm.Script(source, { filename: name });
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, name + ' must not use network APIs');
  }
}
require('../core.js').validateState(require('../core.js').demo());
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
for (const name of files) fs.copyFileSync(path.join(root, name), path.join(out, name));
const manifest = Object.fromEntries(files.map(name => {
  const source = fs.readFileSync(path.join(root, name));
  const packed = fs.readFileSync(path.join(out, name));
  assert.deepEqual(packed, source);
  return [name, { bytes: packed.length, sha256: crypto.createHash('sha256').update(packed).digest('hex') }];
}));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('PASS: 5 local assets syntax/resource checked and packaged byte-for-byte in e6-harbor/dist/; manifest.json written. No network or dependencies.');
