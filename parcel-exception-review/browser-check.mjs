// Real browser checks using installed Chromium + Node built-ins only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { reviewBytes } from './review.mjs';
const require = createRequire(import.meta.url);
const { createServer } = require('./serve.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(30); }
  throw new Error('Timed out: ' + label);
}
async function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const root of ['/opt/ms-playwright', join(process.env.HOME || '', '.cache/ms-playwright')]) {
    for (const name of await readdir(root).catch(() => [])) {
      if (name.startsWith('chromium-')) for (const platform of ['chrome-linux-arm64', 'chrome-linux64', 'chrome-linux']) candidates.push(join(root, name, platform, 'chrome'));
    }
  }
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error('No installed Chromium found. Set CHROMIUM_PATH; no packages or browsers will be installed.');
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      } else for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    });
  }
  static async open(url) {
    const ws = new WebSocket(url); await once(ws, 'open'); return new CDP(ws);
  }
  on(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

const temporary = await mkdtemp(join(tmpdir(), 'parcel-browser-'));
const server = createServer();
let chrome, browser, page;
let passed = 0;
const check = name => { passed++; console.log('PASS ' + name); };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const executable = await chromiumPath();
  chrome = spawn(executable, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + join(temporary, 'profile'), 'about:blank'], { stdio: 'ignore', env: { ...process.env, XDG_CACHE_HOME: join(temporary, 'cache'), XDG_CONFIG_HOME: join(temporary, 'config') } });
  let spawnError; chrome.on('error', error => { spawnError = error; });
  const endpoint = await until(async () => {
    if (spawnError) throw spawnError;
    if (chrome.exitCode !== null) throw new Error('Chromium exited: ' + chrome.exitCode);
    try { return await readFile(join(temporary, 'profile/DevToolsActivePort'), 'utf8'); } catch { return null; }
  }, 'installed Chromium startup');
  const [port, websocketPath] = endpoint.trim().split('\n');
  browser = await CDP.open('ws://127.0.0.1:' + port + websocketPath);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  page = await CDP.open(targets.find(target => target.id === targetId).webSocketDebuggerUrl);
  const errors = [], requests = [];
  page.on('Runtime.exceptionThrown', item => errors.push(item.exceptionDetails.text + ': ' + (item.exceptionDetails.exception?.description || '')));
  page.on('Network.requestWillBeSent', item => requests.push(item.request));
  await page.send('Runtime.enable'); await page.send('Network.enable'); await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: temporary, eventsEnabled: true });
  const evaluate = async expression => {
    const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const click = id => evaluate('document.getElementById(' + JSON.stringify(id) + ').click()');
  const text = id => evaluate('document.getElementById(' + JSON.stringify(id) + ').textContent');
  const visible = id => evaluate('!document.getElementById(' + JSON.stringify(id) + ').hidden');
  const input = (id, value) => evaluate('(() => { const el = document.getElementById(' + JSON.stringify(id) + '); el.value = ' + JSON.stringify(value) + '; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); })()');
  const upload = async (filename, bytes) => {
    const path = join(temporary, filename); await writeFile(path, bytes);
    const { root } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [path] });
    await until(async () => !(await text('file-status')).startsWith('Reading'), 'file validation');
    return path;
  };
  const downloaded = filename => until(async () => { try { return await readFile(join(temporary, filename)); } catch { return null; } }, 'download ' + filename);
  const fixture = await readFile(new URL('./example.json', import.meta.url));
  await page.send('Page.navigate', { url: base });
  await until(() => evaluate('document.readyState === "complete" && !!document.getElementById("file")'), 'page ready');
  assert.equal(await visible('empty'), true); assert.equal(await visible('review'), false);
  assert.equal(await evaluate('document.getElementById("download").disabled'), true);
  check('initial empty state and disabled export');

  await click('example'); await until(() => visible('review'), 'synthetic example');
  assert.equal(await evaluate('document.querySelector("[data-total=inputRecords] strong").textContent'), '9');
  assert.equal(await evaluate('document.querySelector("[data-total=exceptions] strong").textContent'), '2');
  assert.match(await text('inspector'), /PKG-NORTH/); assert.match(await text('inspector'), /PKG-SOUTH/);
  assert.match(await text('inspector'), /no winner/);
  check('synthetic example, global totals, both conflict variants and original records');

  if (process.env.SCREENSHOT_PATH) {
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(resolve(process.env.SCREENSHOT_PATH), Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate('document.querySelector("#rows input").click()');
  await input('parcel-filter', 'HARBOR');
  assert.match(await text('selection-count'), /1 selected · 1 hidden/);
  assert.equal(await evaluate('document.querySelector("[data-total=inputRecords] strong").textContent'), '9');
  assert.match(await text('inspector'), /2026-10-28T11:00:00\+01:00/);
  await click('download');
  const hiddenExport = JSON.parse(await downloaded('selected-exceptions.json'));
  assert.deepEqual(hiddenExport, [reviewBytes(fixture, 'synthetic-example.json').report.exceptions[0]]);
  check('filter hides but never deselects; actual JSON download contains exactly the hidden selection');

  await rm(join(temporary, 'selected-exceptions.json'));
  await click('clear-selection'); assert.equal(await evaluate('document.getElementById("download").disabled'), true);
  await click('select-matches'); await click('clear-filters');
  assert.equal(await evaluate('document.querySelectorAll("#rows input:checked").length'), 1);
  await click('download');
  assert.deepEqual(JSON.parse(await downloaded('selected-exceptions.json')), [reviewBytes(fixture, 'synthetic-example.json').report.exceptions[1]]);
  check('clear selection and select matches export only the selected complete contradiction');

  const originalPath = await upload('partner-shape.json', fixture);
  assert.match(await text('selection-count'), /0 selected/);
  await evaluate('document.getElementById("original").open = true'); await click('download-original');
  assert.deepEqual(await downloaded('original-partner-shape.json'), fixture);
  assert.deepEqual(await readFile(originalPath), fixture);
  check('actual file picker, reset on replacement, unchanged input and byte-identical original download');

  const invalidCases = [
    ['invalid.json', Buffer.from('[{"eventId":"e"},]')],
    ['duplicate.json', Buffer.from('[{"eventId":"a","event\\u0049d":"b","parcelId":"P","type":"created","occurredAt":"2026-10-28T08:00:00Z"}]')],
    ['utf8.json', Buffer.from([91, 0xc0, 0xaf, 93])],
    ['late-bad.json', Buffer.from(JSON.stringify([...JSON.parse(fixture), { eventId: 'bad', parcelId: 'CLEAN', type: 'created', occurredAt: '2026-02-30T08:00:00Z' }]))],
  ];
  for (const [name, bytes] of invalidCases) {
    await upload(name, bytes);
    assert.equal(await visible('error'), true, name); assert.equal(await visible('review'), false, name);
    assert.equal(await evaluate('document.querySelectorAll("#rows tr").length'), 0);
    assert.equal(await evaluate('document.getElementById("download").disabled'), true);
  }
  check('visible invalid-file errors; no stale totals, partial results, selection, or export');

  await upload('empty.json', '[]'); assert.equal(await visible('review'), true);
  assert.match(await text('no-matches'), /not shipment authorization/);
  assert.equal(await evaluate('document.querySelector("[data-total=inputRecords] strong").textContent'), '0');
  check('valid empty array differs from invalid file and never grants clearance');

  const unsafe = '<img src=x onerror=globalThis.injected=true>';
  const sourceEvent = { eventId: 'x', parcelId: unsafe, type: 'delivered', occurredAt: '2026-10-28T08:00:00Z' };
  await upload('injection.json', JSON.stringify([sourceEvent, { ...sourceEvent, type: 'cancelled' }]));
  assert.equal(await evaluate('document.querySelectorAll("#rows img, #inspector img").length'), 0);
  assert.equal(await evaluate('globalThis.injected === undefined'), true);
  assert.match(await text('rows'), /<img/);
  check('untrusted IDs are text, never executable markup');

  const many = [];
  for (let i = 0; i < 35; i++) {
    many.push({ ...sourceEvent, parcelId: 'P-' + i, eventId: 'id-' + i }, { ...sourceEvent, parcelId: 'Q-' + i, eventId: 'id-' + i });
  }
  await upload('many.json', JSON.stringify(many));
  assert.equal(await evaluate('document.querySelectorAll("#rows tr").length'), 30);
  await click('select-matches'); assert.match(await text('selection-count'), /35 selected/);
  await click('next'); assert.equal(await evaluate('document.querySelectorAll("#rows input:checked").length'), 5);
  await input('search', 'nonexistent'); assert.match(await text('selection-count'), /35 selected · 35 hidden/);
  await rm(join(temporary, 'selected-exceptions.json')); await click('download');
  assert.equal(JSON.parse(await downloaded('selected-exceptions.json')).length, 35);
  check('pagination and all-matches selection include every page; zero matches preserve selections');

  // Delay File.arrayBuffer to exercise latest-request-wins, not just fast loads.
  await evaluate('globalThis.realArrayBuffer = File.prototype.arrayBuffer; File.prototype.arrayBuffer = async function() { if (this.name === "slow.json") await new Promise(resolve => setTimeout(resolve, 250)); return realArrayBuffer.call(this); }');
  const slow = join(temporary, 'slow.json'); await writeFile(slow, fixture);
  let root = (await page.send('DOM.getDocument')).root;
  let nodeId = (await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })).nodeId;
  await page.send('DOM.setFileInputFiles', { nodeId, files: [slow] });
  await upload('newest.json', '[]'); await delay(350);
  assert.match(await text('file-status'), /Validated newest.json/);
  root = (await page.send('DOM.getDocument')).root;
  nodeId = (await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })).nodeId;
  await page.send('DOM.setFileInputFiles', { nodeId, files: [slow] }); await click('reset'); await delay(350);
  assert.equal(await visible('empty'), true); assert.equal(await visible('review'), false);
  await evaluate('File.prototype.arrayBuffer = realArrayBuffer');
  check('newer load and clear-review invalidate pending file reads');

  await click('example'); await until(() => visible('review'), 'reload for mobile');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  assert.equal(await evaluate('document.querySelectorAll("input:not([aria-label]):not([type=search])").length'), 0);
  check('390px contained layout has no horizontal page overflow');
  if (process.env.MOBILE_SCREENSHOT_PATH) {
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(resolve(process.env.MOBILE_SCREENSHOT_PATH), Buffer.from(screenshot.data, 'base64'));
  }

  // Exercise an ordinary same-origin sandboxed preview, including its download permission.
  const { frameTree } = await page.send('Page.getFrameTree');
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id,
    html: '<!doctype html><iframe title="Contained preview" sandbox="allow-scripts allow-same-origin allow-downloads" style="width:100%;height:800px;border:0" src="' + base + '"></iframe>' });
  await until(() => evaluate('document.querySelector("iframe").contentDocument?.readyState === "complete" && !!document.querySelector("iframe").contentDocument?.getElementById("example")'), 'contained preview ready');
  await evaluate('document.querySelector("iframe").contentDocument.getElementById("example").click()');
  await until(() => evaluate('document.querySelector("iframe").contentDocument.getElementById("review")?.hidden === false'), 'contained preview review');
  await rm(join(temporary, 'selected-exceptions.json'));
  await evaluate('document.querySelector("iframe").contentDocument.getElementById("select-matches").click(); document.querySelector("iframe").contentDocument.getElementById("download").click()');
  assert.deepEqual(JSON.parse(await downloaded('selected-exceptions.json')), reviewBytes(fixture, 'synthetic-example.json').report.exceptions);
  check('sandboxed contained preview loads and downloads complete selected exceptions');

  assert.deepEqual(errors, []);
  assert.equal(requests.filter(request => !request.url.startsWith(base) && !request.url.startsWith('blob:') && !request.url.startsWith('data:')).length, 0);
  assert.equal(requests.filter(request => request.method !== 'GET').length, 0);
  check('no browser script errors, external asset requests, or uploads');
  console.log(passed + ' browser scenario groups passed. Chromium: ' + executable);
} finally {
  page?.close(); browser?.close();
  if (chrome && chrome.exitCode === null) { const exited = once(chrome, 'exit'); chrome.kill('SIGTERM'); await exited; }
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
