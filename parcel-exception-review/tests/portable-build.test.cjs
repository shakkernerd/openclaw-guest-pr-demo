"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Script } = require('node:vm');
const { buildPortable } = require('../portable/build.cjs');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'review.html'),'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('standalone artifact reproduces exactly from unchanged modular inputs', () => {
  assert.equal(buildPortable(), html); assert.equal(buildPortable(), buildPortable());
});
test('portable edition has one classic inline script and hash-allowed inline styles', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(scripts.length, 1); assert.equal(styles.length, 1);
  new Script(scripts[0][1]);
  for (const text of [scripts[0][1], styles[0][1]]) {
    const hash = crypto.createHash('sha256').update(text).digest('base64');
    assert.ok(html.includes("'sha256-" + hash + "'"));
  }
  assert.ok(html.includes("connect-src 'none'"));
  assert.equal(/type="module"|<script[^>]*src=|<link[^>]*href="(?!data:)/i.test(html), false);
  assert.equal(/^\s*(?:import|export)\s/m.test(scripts[0][1]), false);
  assert.equal(/\bfetch\s*\(/.test(scripts[0][1]), false);
});
test('portable artifact embeds the exact upstream code, never a second audit algorithm', () => {
  const source = fs.readFileSync(path.resolve(root,'../parcel-event-audit/index.js'),'utf8');
  assert.ok(html.includes('(function(module, require) {\n' + source + '\n})(module, require);'));
  assert.ok(html.includes('upstream SHA-256: ' + sha(source)));
});
test('offline usage, example and visible disabled-startup fallback are embedded', () => {
  assert.ok(html.includes('id="portable-help"'));
  assert.ok(html.includes('Review engine has not started.'));
  assert.match(html, /<input id="file"[^>]*disabled/);
  assert.ok(html.includes('PORTABLE_EXAMPLE_TEXT = '));
  assert.ok(!html.includes('href="example.json"'));
  assert.ok(!html.includes('href="README.md"'));
});
test('reusable artifact does not embed task evidence or received-file locations', () => {
  for (const term of ['media/inbound/', 'partner-review/', 'proof/', 'preservation.json', 'verification.json']) assert.ok(!html.includes(term), term);
});
