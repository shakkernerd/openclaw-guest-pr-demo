/** Real Chromium integration checks using its built-in DevTools protocol; no packages. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { exportJSON, exportCSV, importRota } from './rota.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error(`Timed out: ${description}`);
}
let candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
try { for (const entry of await readdir('/opt/ms-playwright')) if (entry.startsWith('chromium-')) { candidates.push(`/opt/ms-playwright/${entry}/chrome-linux-arm64/chrome`, `/opt/ms-playwright/${entry}/chrome-linux64/chrome`); } } catch {}
let executable;
for (const candidate of candidates.filter(Boolean)) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Chromium not found. Set CHROME_BIN to an existing Chromium executable; no browser is downloaded.');
const temp = await mkdtemp(path.join(tmpdir(), 'harbor-browser-'));
const downloads = path.join(temp, 'downloads'); await mkdir(downloads);
const server = await startServer(0);
let browser, socket;
try {
  browser = spawn(executable, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${temp}/profile`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, XDG_CACHE_HOME: path.join(temp, 'cache') } });
  let stderr = '', spawnError; browser.stderr.on('data', data => { stderr += data.toString(); }); browser.on('error', error => { spawnError = error; });
  const endpoint = await until(() => { if (spawnError) throw spawnError; if (browser.exitCode !== null) throw new Error(stderr); return stderr.match(/DevTools listening on (ws:[^\s]+)/)?.[1]; }, 'Chromium startup');
  const base = endpoint.replace('ws:', 'http:').split('/devtools/')[0];
  const targets = await (await fetch(base + '/json/list')).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const requests = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = requests.get(message.id); if (!item) return; requests.delete(message.id); clearTimeout(item.timer); if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ' ' + JSON.stringify(message.params.exceptionDetails.exception));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const value = (selector, text) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const key = async (key, code, virtualKey, modifiers = 0) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers }); };
  const activate = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await key('Enter', 'Enter', 13); };
  const upload = async file => { const { root } = await cdp('DOM.getDocument'); const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' }); await cdp('DOM.setFileInputFiles', { nodeId, files: [file] }); };
  const exportFile = async format => {
    const file = path.join(downloads, `harbor-rota.${format}`); await rm(file, { force: true });
    // Avoid Chromium's burst-download throttle; each is a distinct user action.
    await sleep(250);
    await click('#export-' + format);
    await until(async () => { try { await access(file); return !(await readdir(downloads)).some(f => f.endsWith('.crdownload')); } catch { return false; } }, format + ' download');
    return importRota(await readFile(file, 'utf8'), format);
  };
  const screenshot = async name => { if (!process.env.SCREENSHOT_DIR) return; await mkdir(process.env.SCREENSHOT_DIR, { recursive: true }); const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(process.env.SCREENSHOT_DIR, name + '.png'), Buffer.from(shot.data, 'base64')); };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('DOM.enable');
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(() => evaluate('document.querySelector("#results-summary")?.textContent.includes("Showing")'), 'app initialization');
  assert.equal(await evaluate('document.querySelector("#empty").hidden'), false);
  await key('Tab', 'Tab', 9); assert.equal(await evaluate('document.activeElement.textContent'), 'Skip to rota');
  console.log('PASS empty state and keyboard skip link');
  const expected = importRota(await readFile(path.join(root, 'examples/harbor-rota.json'), 'utf8'), 'json');
  await upload(path.join(root, 'examples/harbor-rota.csv'));
  await until(() => evaluate('!document.querySelector("#preview").hidden'), 'CSV preview');
  assert.equal(await evaluate('document.querySelector("#volunteer-count").textContent'), '0');
  await click('#confirm-import');
  assert.equal(await evaluate('document.querySelector("#volunteer-count").textContent'), '4');
  assert.equal(await evaluate('document.querySelector("#open-count").textContent'), '1');
  assert.deepEqual(await exportFile('json'), expected);
  console.log('PASS real CSV file upload, preview, confirmation and JSON download');
  for (const [filename, text] of [['bad.csv', 'record_type,wrong\n"unclosed'], ['bad.json', '{broken']]) {
    const file = path.join(temp, filename); await writeFile(file, text); await upload(file);
    await until(() => evaluate('!document.querySelector("#error").hidden'), 'malformed error');
    assert.match(await evaluate('document.querySelector("#error").textContent'), /current rota is unchanged/);
    assert.equal(await evaluate('document.activeElement.id'), 'error');
    assert.equal(await evaluate('document.querySelector("#preview").hidden'), true);
    assert.deepEqual(await exportFile('json'), expected);
  }
  const invalidUtf = path.join(temp, 'invalid.csv'); await writeFile(invalidUtf, Buffer.from([0xff, 0xfe, 0x41])); await upload(invalidUtf);
  await until(() => evaluate('document.querySelector("#error").textContent.includes("UTF-8")'), 'UTF-8 validation');
  assert.deepEqual(await exportFile('json'), expected);
  await upload(path.join(root, 'examples/harbor-rota.json'));
  await until(() => evaluate('!document.querySelector("#preview").hidden'), 'JSON preview');
  await click('#cancel-import'); assert.deepEqual(await exportFile('json'), expected);
  console.log('PASS malformed CSV/JSON/encoding preserve live rota; cancel preserves live rota');
  await click('[data-id="v-mara"]');
  assert.equal(await evaluate('document.activeElement.id'), 'edit-name');
  const correctedName = 'Renée, "Skipper" 青井 🌊';
  await value('#edit-name', correctedName); await click('#edit-form button[type=submit]'); expected.volunteers[0].name = correctedName;
  assert.equal(await evaluate('document.querySelector("#editor").open'), false);
  assert.equal(await evaluate('document.activeElement.dataset.id'), 'v-mara');
  await click('[data-id="s-welcome"]');
  await value('#edit-end', '07:00'); await click('#edit-form button[type=submit]');
  assert.equal(await evaluate('document.querySelector("#editor").open'), true);
  assert.match(await evaluate('document.querySelector("#editor-error").textContent'), /end must be after/);
  await value('#edit-date', '2028-02-29'); await value('#edit-start', '09:15'); await value('#edit-end', '11:45');
  await value('#edit-role', 'Welcome, "new crew" <img src=x onerror=alert(1)>');
  await evaluate('document.querySelector("input[value=v-jose]").checked = false; document.querySelector("input[value=v-aoi]").checked = true');
  await click('#edit-form button[type=submit]');
  Object.assign(expected.shifts[0], { date: '2028-02-29', start: '09:15', end: '11:45', role: 'Welcome, "new crew" <img src=x onerror=alert(1)>', volunteerIds: ['v-mara', 'v-aoi'] });
  assert.equal(await evaluate('document.querySelectorAll("#shifts img").length'), 0);
  assert.deepEqual(await exportFile('csv'), expected); assert.deepEqual(await exportFile('json'), expected);
  console.log('PASS accessible name/date/time/role/assignment edits, invalid edit rejection, text-safe rendering, both downloads');
  // Optional pinned scheduler snapshot: exercise the real incompatibility boundary in the UI.
  if (process.env.SCHEDULER_SNAPSHOT) {
    await upload(path.resolve(process.env.SCHEDULER_SNAPSHOT));
    await until(() => evaluate('!document.querySelector("#error").hidden'), 'scheduler snapshot rejection');
    assert.match(await evaluate('document.querySelector("#error").textContent'), /unsupported field.*assignments/);
    assert.equal(await evaluate('document.activeElement.id'), 'error');
    assert.equal(await evaluate('document.querySelector("#preview").hidden'), true);
    assert.deepEqual(await exportFile('json'), expected);
    assert.equal(await evaluate('document.querySelector("#undo").disabled'), false);
    console.log('PASS actual scheduler snapshot rejected without losing unexported edits or undo');
  }
  // Imports must preserve unsaved corrections AND the existing undo checkpoint.
  await upload(path.join(root, 'examples/harbor-rota.csv'));
  await until(() => evaluate('!document.querySelector("#preview").hidden'), 'pending CSV preview');
  await upload(path.join(temp, 'bad.json'));
  await until(() => evaluate('!document.querySelector("#error").hidden'), 'failed import after unsaved edits');
  assert.equal(await evaluate('document.querySelector("#preview").hidden'), true, 'Failed import clears any stale replacement candidate');
  assert.deepEqual(await exportFile('json'), expected);
  await upload(path.join(root, 'examples/harbor-rota.json'));
  await until(() => evaluate('!document.querySelector("#preview").hidden'), 'cancel after unsaved edits');
  await activate('#cancel-import'); assert.deepEqual(await exportFile('csv'), expected);
  assert.equal(await evaluate('document.querySelector("#undo").disabled'), false);
  const beforeShiftEdit = structuredClone(expected);
  beforeShiftEdit.shifts[0] = importRota(await readFile(path.join(root, 'examples/harbor-rota.json'), 'utf8'), 'json').shifts[0];
  await activate('#undo'); assert.deepEqual(await exportFile('json'), beforeShiftEdit);
  console.log('PASS failed/cancelled imports preserve unsaved edits and previous undo checkpoint');
  const corrected = path.join(temp, 'corrected.json'); await writeFile(corrected, exportJSON(expected));
  await upload(corrected); await until(() => evaluate('!document.querySelector("#preview").hidden'), 'corrected JSON preview'); await click('#confirm-import');
  assert.deepEqual(await exportFile('csv'), expected);
  await click('[data-id="v-mara"]'); await value('#edit-name', 'Not saved'); await key('Escape', 'Escape', 27);
  assert.equal(await evaluate('document.querySelector("#editor").open'), false); assert.deepEqual(await exportFile('json'), expected);
  // Inspecting a record and saving unchanged fields must not erase the last real undo.
  await activate('[data-id="v-mara"]'); await activate('#edit-form button[type=submit]');
  await activate('[data-id="s-welcome"]'); await activate('#edit-form button[type=submit]');
  await upload(corrected); await until(() => evaluate('!document.querySelector("#preview").hidden'), 'unchanged import preview'); await activate('#confirm-import');
  assert.equal(await evaluate('document.querySelector("#preview").hidden'), true);
  await activate('#undo'); assert.deepEqual(await exportFile('json'), beforeShiftEdit, 'No-op save preserves the previous real undo checkpoint');
  await upload(corrected); await until(() => evaluate('!document.querySelector("#preview").hidden'), 'restore after no-op check'); await activate('#confirm-import');
  console.log('PASS unchanged saves preserve the last meaningful undo');
  await value('#search', '青井'); assert.match(await evaluate('document.querySelector("#results-summary").textContent'), /Showing 2 of 4 volunteers/);
  await value('#search', 'no-match-xyz'); assert.match(await evaluate('document.querySelector("#volunteers").textContent'), /No volunteers match/); await value('#search', '');
  await click('[data-id="v-mara"]'); await click('#remove-record');
  assert.equal(await evaluate('document.querySelector("#delete-confirmation").hidden'), false);
  await click('#confirm-delete');
  const removed = await exportFile('json'); assert.equal(removed.volunteers.length, 3); assert.ok(removed.shifts.every(s => !s.volunteerIds.includes('v-mara')));
  await click('#undo'); assert.deepEqual(await exportFile('json'), expected);
  console.log('PASS JSON reimport, Escape cancellation, search, confirmed deletion and undo');
  // Activate controls with real keyboard events, including the safe removal default.
  await activate('[data-id="s-welcome"]');
  assert.equal(await evaluate('document.activeElement.id'), 'edit-role');
  await evaluate('document.querySelector("#close-editor").focus()'); await key('Tab', 'Tab', 9, 8);
  assert.equal(await evaluate('document.activeElement.id'), 'remove-record', 'Shift+Tab wraps to the last visible control');
  await key('Enter', 'Enter', 13);
  assert.equal(await evaluate('document.activeElement.id'), 'keep-record', 'Removal initially focuses the safe action');
  await key('Enter', 'Enter', 13);
  assert.equal(await evaluate('document.querySelector("#delete-confirmation").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#editor").open'), true);
  await key('Enter', 'Enter', 13); // Reopen the confirmation from Remove record.
  await key('Tab', 'Tab', 9, 8); assert.equal(await evaluate('document.activeElement.id'), 'confirm-delete');
  await key('Enter', 'Enter', 13);
  assert.equal(await evaluate('document.activeElement.id'), 'add-shift', 'Removal returns focus to a usable shift control');
  const removedShift = await exportFile('json');
  assert.equal(removedShift.shifts.length, 2); assert.deepEqual(removedShift.volunteers, expected.volunteers);
  await activate('#undo'); assert.deepEqual(await exportFile('csv'), expected);
  console.log('PASS keyboard removal/keep/confirmation, reverse Tab, and keyboard undo');
  await click('#add-volunteer'); await value('#edit-name', 'New volunteer — Léa'); await click('#edit-form button[type=submit]');
  const withVolunteer = await exportFile('json'); const added = withVolunteer.volunteers.at(-1);
  assert.equal(added.name, 'New volunteer — Léa'); assert.match(added.id, /^v-/);
  await click('#add-shift'); await value('#edit-role', 'Evening dock check'); await value('#edit-date', '2026-11-09'); await value('#edit-start', '17:00'); await value('#edit-end', '18:30');
  await evaluate('document.querySelectorAll("input[name=volunteerIds]")[4].checked = true'); await click('#edit-form button[type=submit]');
  const withShift = await exportFile('csv'); assert.equal(withShift.shifts.length, 4); assert.deepEqual(withShift.shifts.at(-1).volunteerIds, [added.id]);
  // Reimport imported CRLF text, then edit a different field without changing its text or assignment order.
  const edge = structuredClone(expected); edge.shifts[0].role = 'Dock\r\nwelcome'; edge.shifts[0].volunteerIds = ['v-aoi', 'v-mara'];
  const edgeFile = path.join(temp, 'edge.json'); await writeFile(edgeFile, exportJSON(edge));
  await upload(edgeFile); await until(() => evaluate('!document.querySelector("#preview").hidden'), 'edge preview'); await click('#confirm-import');
  await click('[data-id="s-welcome"]'); await value('#edit-start', '09:30'); await click('#edit-form button[type=submit]'); edge.shifts[0].start = '09:30';
  assert.deepEqual(await exportFile('csv'), edge);
  // Restore the readable sample for the layout screenshots.
  await upload(corrected); await until(() => evaluate('!document.querySelector("#preview").hidden'), 'restore preview'); await click('#confirm-import');
  console.log('PASS adding volunteers/shifts, assignment linkage, untouched CRLF text and assignment-order preservation');
  await evaluate('window.scrollTo(0, 0)'); await screenshot('desktop');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'No horizontal page overflow at 360px');
  await screenshot('mobile'); await click('[data-id="s-welcome"]');
  assert.ok(await evaluate('(() => { const r = document.querySelector("#editor").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()'), 'Dialog fits mobile viewport');
  const tree = await cdp('Accessibility.getFullAXTree');
  for (const n of tree.nodes.filter(n => !n.ignored && ['button', 'textbox', 'checkbox', 'Date', 'InputTime'].includes(n.role?.value))) assert.ok(n.name?.value, `Unnamed accessible ${n.role.value}`);
  for (let i = 0; i < 20; i++) { await key('Tab', 'Tab', 9); assert.equal(await evaluate('document.querySelector("#editor").contains(document.activeElement)'), true, 'Focus remains inside the modal'); }
  await screenshot('mobile-editor'); await key('Escape', 'Escape', 27);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'No horizontal page overflow at 320px');
  // Reproduce the independent review's CSV -> oversized JSON archive case in the browser.
  const large = { version: 1, volunteers: [{ id: 'v-size', name: 'Name' + '\t'.repeat(1_100_000) }], shifts: [] };
  const largeFile = path.join(temp, 'large.csv'); await writeFile(largeFile, exportCSV(large));
  await upload(largeFile); await until(() => evaluate('!document.querySelector("#preview").hidden'), 'large CSV preview'); await activate('#confirm-import');
  await rm(path.join(downloads, 'harbor-rota.json'), { force: true });
  await activate('#export-json');
  await until(() => evaluate('!document.querySelector("#error").hidden'), 'oversized JSON export error');
  assert.match(await evaluate('document.querySelector("#error").textContent'), /Choose Export CSV instead.*No file was downloaded/);
  assert.equal(await evaluate('document.querySelector("#notice").hidden'), true, 'Do not claim JSON download success');
  assert.equal(await evaluate('document.activeElement.id'), 'error');
  await sleep(250); assert.ok(!(await readdir(downloads)).includes('harbor-rota.json'), 'No unusable JSON archive created');
  assert.deepEqual(await exportFile('csv'), large);
  await upload(path.join(downloads, 'harbor-rota.csv'));
  await until(() => evaluate('!document.querySelector("#preview").hidden'), 'safe CSV archive reimport'); await activate('#confirm-import');
  await activate('#undo'); assert.deepEqual(await exportFile('json'), expected, 'Alternative export and identical reimport preserve undo');
  console.log('PASS oversized JSON is blocked with a viable CSV archive; actual CSV download/reimport and undo succeed');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS 320/360px layouts, mobile editor, accessible control names, keyboard focus, zero runtime errors');
  console.log('Browser validation passed using ' + executable);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { const stopped = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await Promise.race([stopped, sleep(2000)]); if (browser.exitCode === null) { browser.kill('SIGKILL'); await stopped; } }
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
