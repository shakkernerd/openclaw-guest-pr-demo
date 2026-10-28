import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { importRota, exportCSV, exportJSON } from './rota.mjs';
const root = new URL('.', import.meta.url);
let modules = 0;
async function checkModules(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) { if (!entry.name.startsWith('.')) await checkModules(url); }
    else if (entry.name.endsWith('.mjs')) { const result = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); modules++; }
  }
}
await checkModules(root);
for (const name of ['../README.md', 'README.md', 'COMPATIBILITY.md']) {
  const url = new URL(name, root), markdown = await readFile(url, 'utf8');
  assert.ok(!markdown.includes('\u0000'), name + ': unexpected NUL character');
  for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:\/\//.test(target) || target.startsWith('#')) continue;
    await access(new URL(target.split('#')[0], url));
  }
}
const html = await readFile(new URL('index.html', root), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  if (match[1].startsWith('#')) assert.ok(ids.includes(match[1].slice(1)), `Missing anchor ${match[1]}`);
  else { assert.ok(!/^(https?:)?\/\//.test(match[1]), 'No external runtime assets'); await readFile(new URL(match[1], root)); }
}
for (const match of html.matchAll(/\bfor="([^"]+)"/g)) assert.ok(ids.includes(match[1]));
const sample = importRota(await readFile(new URL('examples/harbor-rota.json', root), 'utf8'), 'json');
assert.deepEqual(importRota(await readFile(new URL('examples/harbor-rota.csv', root), 'utf8'), 'csv'), sample);
assert.deepEqual(importRota(exportCSV(sample), 'csv'), importRota(exportJSON(sample), 'json'));
const server = await startServer(0);
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [asset, type] of [['/', 'text/html'], ['/app.mjs', 'text/javascript'], ['/rota.mjs', 'text/javascript'], ['/styles.css', 'text/css'], ['/examples/harbor-rota.csv', 'text/csv'], ['/examples/harbor-rota.json', 'application/json'], ['/README.md', 'text/plain']]) {
    const response = await fetch(base + asset); assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').startsWith(type)); assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(base + '/%2e%2e%2fREADME.md')).status, 404);
  assert.equal((await fetch(base + '/index.html', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/tests/rota.test.mjs')).status, 404);
} finally { await new Promise(resolve => server.close(resolve)); }
console.log(`Validation passed: ${modules} JS modules, unique HTML IDs, documentation links, local links/assets, sample parity, lossless exports, HTTP MIME types and server boundaries. No build step or dependencies required.`);
