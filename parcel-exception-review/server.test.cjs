"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./serve.cjs');
test('static server serves local assets only; rejects writes and non-allowlisted files', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/', '/styles.css', '/app.mjs', '/review.mjs', '/audit.browser.mjs', '/example.json', '/README.md']) {
    const response = await fetch(root + route); assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    await response.text();
  }
  const head = await fetch(root + '/example.json', { method: 'HEAD' }); assert.equal(await head.text(), '');
  for (const route of ['/serve.cjs', '/.git/config', '/%2e%2e/parcel-event-audit/index.js', '/secret.json']) {
    const response = await fetch(root + route); assert.equal(response.status, 404); await response.text();
  }
  const response = await fetch(root + '/', { method: 'POST', body: 'private export' });
  assert.equal(response.status, 405); assert.match(await response.text(), /Read-only/);
});
