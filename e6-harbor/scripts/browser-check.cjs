'use strict';
// Real Chromium, driven over an OS pipe. No WebDriver, packages, server, or sockets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const appRoot = process.env.HARBOR_APP_DIR ? path.resolve(process.env.HARBOR_APP_DIR) : root;
const candidates = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
if (fs.existsSync('/opt/ms-playwright')) {
  for (const entry of fs.readdirSync('/opt/ms-playwright')) {
    candidates.push(path.join('/opt/ms-playwright', entry, 'chrome-linux-arm64/chrome'));
    candidates.push(path.join('/opt/ms-playwright', entry, 'chrome-linux64/chrome'));
  }
}
const executable = candidates.find(p => p && fs.existsSync(p));
if (!executable) { console.error('Chromium not found. Set CHROMIUM_PATH to an existing Chrome/Chromium executable. Nothing is downloaded.'); process.exit(1); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e6-harbor-browser-'));
const browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-pipe', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, XDG_CACHE_HOME: path.join(profile, 'cache') } });
let buffer = ''; let sequence = 0; let session; let stderr = ''; let passed = 0;
const pending = new Map(); const requests = []; const errors = []; const confirmations = [];
browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
browser.on('error', error => { console.error(error); process.exitCode = 1; });
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.id) {
      const task = pending.get(message.id);
      if (task) { clearTimeout(task.timer); pending.delete(message.id); message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result); }
    } else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    else if (message.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(message.params.exceptionDetails));
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
    else if (message.method === 'Page.javascriptDialogOpening') {
      confirmations.push(message.params.message);
      send('Page.handleJavaScriptDialog', { accept: true }, message.sessionId).catch(error => errors.push(error.message));
    }
  }
});
function send(method, params = {}, sessionId = session) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method + '\n' + stderr)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const q = value => JSON.stringify(value);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
const click = async selector => { await evaluate('document.querySelector(' + q(selector) + ').click()'); await settle(); };
const set = (selector, value) => evaluate('document.querySelector(' + q(selector) + ').value = ' + q(value));
const submit = async id => { await evaluate('document.getElementById(' + q(id) + ').requestSubmit()'); await settle(); };
const saved = () => evaluate('JSON.parse(localStorage.getItem(HarborStorage.KEY))');
async function key(key, modifiers = 0) {
  const code = { Tab: 9, Enter: 13, Escape: 27 }[key];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers });
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (await evaluate('document.readyState === "complete" && !!document.querySelector(".shift-card")')) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('App failed to render: ' + await evaluate('document.body.innerText'));
}
async function close() { await key('Escape'); await settle(); }
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + passed + ': ' + name); }
async function screenshot(name) {
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  const image = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'artifacts', name + '.png'), Buffer.from(image.data, 'base64'));
}
async function noOverflow() {
  const dimensions = await evaluate('({width: innerWidth, page: document.documentElement.scrollWidth, dialog: document.getElementById("editor").open ? [document.getElementById("editor").scrollWidth, document.getElementById("editor").clientWidth] : null})');
  assert.ok(dimensions.page <= dimensions.width, JSON.stringify(dimensions));
  if (dimensions.dialog) assert.ok(dimensions.dialog[0] <= dimensions.dialog[1] + 1, JSON.stringify(dimensions));
}
async function run() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  session = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable'); await send('Page.bringToFront');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(path.join(appRoot, 'index.html')).href });
  await ready();
  await check('demo renders seven days, ten shifts and correct coverage', async () => {
    assert.equal(await evaluate('document.querySelectorAll(".day").length'), 7);
    assert.equal(await evaluate('document.querySelectorAll(".shift-card").length'), 10);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".metric>strong")].map(x=>x.textContent)'), ['10', '11 / 16', '5', '5 / 10']);
    await noOverflow(); await screenshot('desktop');
  });
  await check('keyboard opens editor, Tab stays in dialog, Escape restores focus', async () => {
    await evaluate('document.getElementById("add-shift").focus()'); await key('Enter');
    assert.equal(await evaluate('document.activeElement.id'), 'shift-title');
    for (let i = 0; i < 20; i++) { await key('Tab'); assert.equal(await evaluate('document.getElementById("editor").contains(document.activeElement)'), true, 'Tab ' + i + ': ' + await evaluate('document.activeElement.outerHTML.slice(0, 200)')); }
    for (let i = 0; i < 20; i++) { await key('Tab', 8); assert.equal(await evaluate('document.getElementById("editor").contains(document.activeElement)'), true); }
    await close();
    assert.equal(await evaluate('document.getElementById("editor").open'), false);
    assert.equal(await evaluate('document.activeElement.id'), 'add-shift');
  });
  await check('overlap reasons are visible and forced invalid assignments are blocked', async () => {
    await click('[data-action="assign"][data-id="s-mon-launch"]');
    assert.equal(await evaluate('document.querySelector("#candidate option[value=v-maya]").disabled'), true);
    assert.match(await evaluate('document.querySelector(".candidate-list").textContent'), /Maya Ellis.*Overlaps Open the harbor/);
    await evaluate('document.querySelector("#candidate option[value=v-maya]").disabled = false; document.getElementById("candidate").value="v-maya"');
    await submit('assignment-form');
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Overlaps/);
    assert.equal(await evaluate('document.activeElement.id'), 'dialog-error');
    assert.equal(await saved(), null);
    await close();
  });
  await check('eligible assignment updates coverage and persists', async () => {
    await click('[data-action="assign"][data-id="s-mon-launch"]');
    await set('#candidate', 'v-ian'); await submit('assignment-form');
    assert.equal((await saved()).assignments.length, 12);
    assert.match(await evaluate('document.querySelector(".assignment-context").textContent'), /2\/2 places filled/);
    await close();
  });
  await check('shift edits reject newly introduced overlaps without corrupting data', async () => {
    await click('[data-action="edit-shift"][data-id="s-mon-dock"]');
    await set('#shift-end', '10:01'); await submit('shift-form');
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Overlaps/);
    assert.equal((await saved()).shifts.find(s => s.id === 's-mon-dock').end, '10:00');
    await set('#shift-end', '10:00'); await set('#shift-title', 'Harbor opening'); await submit('shift-form');
    assert.equal((await saved()).shifts.find(s => s.id === 's-mon-dock').title, 'Harbor opening');
  });
  await check('remove/reassign accepts exact back-to-back boundary', async () => {
    await click('[data-action="assign"][data-id="s-mon-shore"]');
    await click('[data-action="unassign"][data-id="a-3"]');
    assert.equal(await evaluate('document.querySelector("#candidate option[value=v-maya]").disabled'), false);
    await set('#candidate', 'v-maya'); await submit('assignment-form');
    assert.equal((await saved()).assignments.length, 12); await close();
  });
  let newVolunteer; let newShift;
  await check('create/edit volunteer with availability; user text is escaped', async () => {
    await click('#nav-volunteers'); await click('#add-volunteer');
    await set('#volunteer-name', 'Alex <crew>'); await set('#notes', '<img src=x onerror="window.bad=1">');
    await click('#day-0'); await set('#start-0', '08:00'); await set('#end-0', '18:00');
    await submit('volunteer-form');
    newVolunteer = (await saved()).volunteers.find(v => v.name === 'Alex <crew>').id;
    assert.equal(await evaluate('document.querySelectorAll(".crew-card").length'), 7);
    assert.equal(await evaluate('document.querySelectorAll(".crew-card img").length'), 0);
    await click('[data-action="edit-volunteer"][data-id="' + newVolunteer + '"]');
    await set('#volunteer-name', 'Alex Reed'); await submit('volunteer-form');
    assert.equal((await saved()).volunteers.find(v => v.id === newVolunteer).name, 'Alex Reed');
  });
  await check('create shift and assign a third consecutive non-overlapping duty', async () => {
    await click('#nav-schedule'); await click('#add-shift');
    await set('#shift-title', 'Quay <handover>'); await set('#shift-start', '12:00'); await set('#shift-end', '13:00');
    await set('#shift-role', 'Shore support'); await submit('shift-form');
    newShift = (await saved()).shifts.find(s => s.title === 'Quay <handover>').id;
    await click('[data-action="assign"][data-id="' + newShift + '"]');
    await set('#candidate', 'v-maya'); await submit('assignment-form');
    assert.equal((await saved()).assignments.length, 13); await close();
  });
  await check('volunteer role and availability edits cannot invalidate assigned duties', async () => {
    await click('#nav-volunteers'); await click('[data-action="edit-volunteer"][data-id="v-maya"]');
    await click('#role-2'); await submit('volunteer-form');
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Not eligible/);
    await click('#role-2'); await set('#end-0', '11:00'); await submit('volunteer-form');
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Unavailable/);
    assert.equal((await saved()).volunteers.find(v => v.id === 'v-maya').availability[0].end, '19:00');
    await close();
  });
  await check('role/open filters, empty week and crew search work', async () => {
    await set('#crew-search', 'Alex'); await evaluate('document.getElementById("crew-search").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.querySelectorAll(".crew-card").length'), 1);
    await click('#nav-schedule'); await set('#role-filter', 'Launch crew');
    await evaluate('document.getElementById("role-filter").dispatchEvent(new Event("change"))'); await click('#open-filter');
    assert.equal(await evaluate('document.querySelectorAll(".shift-card").length'), 2);
    await click('[data-action="next-week"]');
    assert.match(await evaluate('document.getElementById("schedule").textContent'), /fresh week/);
    await click('[data-action="demo-week"]'); await set('#role-filter', '');
    await evaluate('document.getElementById("role-filter").dispatchEvent(new Event("change"))'); await click('#open-filter');
  });
  await check('confirmed deletes remove related assignments, not other records', async () => {
    await click('[data-action="edit-shift"][data-id="' + newShift + '"]');
    await click('[data-action="delete-shift"]');
    assert.equal((await saved()).shifts.length, 10); assert.equal((await saved()).assignments.length, 12);
    await click('#nav-volunteers'); await click('[data-action="edit-volunteer"][data-id="' + newVolunteer + '"]');
    await click('[data-action="delete-volunteer"]');
    assert.equal((await saved()).volunteers.length, 6);
    assert.equal(confirmations.length, 2); assert.match(confirmations[0], /also removes 1 assignment/);
  });
  await check('real browser reload preserves edits and assignments', async () => {
    await send('Page.reload'); await ready();
    assert.match(await evaluate('document.getElementById("schedule").textContent'), /Harbor opening/);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".metric>strong")].map(x=>x.textContent)'), ['10', '12 / 16', '4', '6 / 10']);
  });
  await check('coordinator move into overlap preserves the entire prior rota and explains remedies', async () => {
    const rawBefore = await evaluate('localStorage.getItem(HarborStorage.KEY)');
    const cardsBefore = await evaluate('document.getElementById("schedule").innerHTML');
    await click('[data-action="edit-shift"][data-id="s-mon-dock"]');
    await set('#shift-start', '09:30'); await set('#shift-end', '10:30'); await submit('shift-form');
    const message = await evaluate('document.getElementById("dialog-error").textContent');
    await screenshot('coordinator-overlap');
    assert.match(message, /Overlaps Welcome desk/);
    assert.equal(await evaluate('localStorage.getItem(HarborStorage.KEY)'), rawBefore);
    assert.equal(await evaluate('document.getElementById("schedule").innerHTML'), cardsBefore);
    assert.match(message, /[Cc]hange the shift time|[Rr]eassign|[Rr]emove.*assignment/);
    await close(); await send('Page.reload'); await ready();
    assert.equal(await evaluate('localStorage.getItem(HarborStorage.KEY)'), rawBefore);
    assert.deepEqual(await saved(), JSON.parse(rawBefore));
  });
  await check('coordinator reschedules a duty and makes a back-to-back reassignment', async () => {
    await click('[data-action="edit-shift"][data-id="s-mon-shore"]');
    await set('#shift-start', '12:00'); await set('#shift-end', '14:00'); await submit('shift-form');
    const mayaAssignment = (await saved()).assignments.find(a => a.shiftId === 's-mon-shore' && a.volunteerId === 'v-maya').id;
    await click('[data-action="assign"][data-id="s-mon-shore"]');
    await click('[data-action="unassign"][data-id="' + mayaAssignment + '"]');
    assert.equal(await evaluate('document.querySelector("#candidate option[value=v-theo]").disabled'), false);
    await set('#candidate', 'v-theo'); await submit('assignment-form');
    const next = await saved();
    assert.ok(next.assignments.some(a => a.shiftId === 's-mon-launch' && a.volunteerId === 'v-theo'));
    assert.ok(next.assignments.some(a => a.shiftId === 's-mon-shore' && a.volunteerId === 'v-theo'));
    assert.match(await evaluate('document.querySelector(".assignment-context").textContent'), /2\/2 places filled/);
    await screenshot('coordinator-back-to-back'); await close();
  });
  await check('availability and role changes are atomic when invalid and persist when valid', async () => {
    await click('#nav-volunteers');
    await click('[data-action="edit-volunteer"][data-id="v-ben"]');
    const rawBefore = await evaluate('localStorage.getItem(HarborStorage.KEY)');
    await click('#role-0'); await click('#role-2'); await submit('volunteer-form');
    assert.equal(await evaluate('localStorage.getItem(HarborStorage.KEY)'), rawBefore);
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Not eligible.*[Cc]hoose|Not eligible.*[Uu]pdate/);
    await click('#role-2'); await set('#end-0', '13:00'); await submit('volunteer-form');
    assert.equal(await evaluate('localStorage.getItem(HarborStorage.KEY)'), rawBefore);
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Unavailable.*[Cc]hange|Unavailable.*[Rr]emove|Unavailable.*[Uu]pdate/);
    await screenshot('coordinator-availability');
    await set('#end-0', '15:00'); await submit('volunteer-form');
    const ben = (await saved()).volunteers.find(v => v.id === 'v-ben');
    assert.deepEqual(ben.roles, ['Dock lead', 'Shore support']);
    assert.equal(ben.availability.find(a => a.day === 0).end, '15:00');
    assert.equal(await evaluate('document.activeElement.dataset.id'), 'v-ben');
    await click('#nav-schedule');
  });
  await check('fill then unfill a shift updates coverage, and reload restores the exact full snapshot', async () => {
    const before = await saved();
    await click('[data-action="assign"][data-id="s-wed"]');
    await set('#candidate', 'v-maya'); await submit('assignment-form');
    assert.match(await evaluate('document.querySelector(".assignment-context").textContent'), /2\/2 places filled/);
    assert.equal((await saved()).assignments.length, before.assignments.length + 1);
    const assignment = (await saved()).assignments.find(a => a.shiftId === 's-wed' && a.volunteerId === 'v-maya');
    await click('[data-action="unassign"][data-id="' + assignment.id + '"]');
    assert.match(await evaluate('document.querySelector(".assignment-context").textContent'), /1\/2 places filled/);
    assert.deepEqual(await saved(), before);
    await screenshot('coordinator-unfilled'); await close();
    const rendered = await evaluate('document.getElementById("schedule").innerHTML');
    const rawBefore = await evaluate('localStorage.getItem(HarborStorage.KEY)');
    await send('Page.reload'); await ready();
    assert.equal(await evaluate('localStorage.getItem(HarborStorage.KEY)'), rawBefore);
    assert.deepEqual(await saved(), before);
    assert.equal(await evaluate('document.getElementById("schedule").innerHTML'), rendered);
    await screenshot('coordinator-reloaded');
  });
  await check('crew updates keep keyboard focus off destructive controls and announce inside the modal', async () => {
    const beforeOpen = await saved();
    await evaluate('document.querySelector("[data-action=assign][data-id=s-mon-launch]").focus()');
    await key('Enter'); await settle();
    assert.equal(await evaluate('document.activeElement.dataset.action'), 'close-dialog');
    assert.equal(await evaluate('(() => {const a=document.activeElement.getBoundingClientRect(), d=document.getElementById("editor").getBoundingClientRect();return a.top>=d.top && a.bottom<=Math.min(d.bottom,innerHeight)})()'), true, 'Safe focus must also be visible');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat: true });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await settle();
    assert.deepEqual(await saved(), beforeOpen);
    assert.equal(await evaluate('document.getElementById("editor").open'), false);
    await click('[data-action="assign"][data-id="s-mon-launch"]');
    assert.equal(await evaluate('document.activeElement.dataset.action'), 'close-dialog');
    assert.equal(await evaluate('(() => {const a=document.activeElement.getBoundingClientRect(), d=document.getElementById("editor").getBoundingClientRect();return a.top>=d.top && a.bottom<=Math.min(d.bottom,innerHeight)})()'), true, 'Safe focus must also be visible');
    assert.match(await evaluate('document.getElementById("candidate").selectedOptions[0].textContent'), /Shift full/);
    const item = (await saved()).assignments.find(a => a.shiftId === 's-mon-launch' && a.volunteerId === 'v-ian');
    await click('[data-action="unassign"][data-id="' + item.id + '"]');
    assert.equal(await evaluate('document.activeElement.id'), 'candidate');
    assert.match(await evaluate('document.getElementById("dialog-status").textContent'), /removed.*Saved in this browser/);
    await set('#candidate', 'v-ian'); await submit('assignment-form');
    assert.equal(await evaluate('document.activeElement.dataset.action'), 'close-dialog');
    assert.equal(await evaluate('(() => {const a=document.activeElement.getBoundingClientRect(), d=document.getElementById("editor").getBoundingClientRect();return a.top>=d.top && a.bottom<=Math.min(d.bottom,innerHeight)})()'), true, 'Safe focus must also be visible');
    assert.match(await evaluate('document.getElementById("dialog-status").textContent'), /assigned.*Saved in this browser/);
    const before = await saved();
    // A second Enter after assigning safely closes the editor, never removes crew.
    await key('Enter');
    assert.equal(await evaluate('document.getElementById("editor").open'), false);
    assert.deepEqual(await saved(), before);
  });
  await check('360px and 320px layouts and all editors fit without horizontal scrolling', async () => {
    for (const width of [360, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
      await noOverflow();
      if (width === 360) await screenshot('mobile');
      await click('#add-shift'); await noOverflow(); await close();
      await click('[data-action="assign"][data-id="s-mon-launch"]'); await noOverflow(); await close();
      await click('#nav-volunteers'); await noOverflow(); await click('#add-volunteer'); await noOverflow();
      if (width === 360) await screenshot('mobile-volunteer-editor');
      const labels = await evaluate('[...document.querySelectorAll("#editor input,#editor select,#editor textarea")].every(x=>x.labels && x.labels.length>0)');
      assert.equal(labels, true); await close(); await click('#nav-schedule');
    }
  });
  await check('saved boundary-date snapshots recover explicitly and supported boundary weeks render', async () => {
    const original = await saved();
    for (const date of ['9999-12-27', '9999-12-28', '9999-12-29', '9999-12-30', '9999-12-31']) {
      const snapshot = { ...original, assignments: [], shifts: [{ ...original.shifts[0], date }] };
      const raw = JSON.stringify(snapshot);
      await evaluate('localStorage.setItem(HarborStorage.KEY, ' + q(raw) + ')');
      await send('Page.reload'); await ready();
      assert.match(await evaluate('document.getElementById("storage-warning").textContent'), /NOT been overwritten/);
      assert.equal(await evaluate('localStorage.getItem(HarborStorage.KEY)'), raw);
      assert.equal(await evaluate('document.querySelectorAll(".shift-card").length'), 10);
      assert.match(await evaluate('document.getElementById("status").textContent'), /Temporary rota/);
    }
    await screenshot('coordinator-boundary-recovery');
    for (const date of ['1900-01-08', '9999-12-20']) {
      const snapshot = { ...original, assignments: [], shifts: [{ ...original.shifts[0], date }] };
      await evaluate('localStorage.setItem(HarborStorage.KEY, ' + q(JSON.stringify(snapshot)) + ')');
      await send('Page.reload'); await ready();
      assert.equal(await evaluate('document.querySelectorAll(".shift-card").length'), 1);
      assert.equal(await evaluate('document.querySelectorAll(".day").length'), 7);
      assert.equal(await evaluate('document.getElementById("storage-warning").hidden'), true);
      assert.deepEqual(await evaluate('[document.getElementById("week-date").min, document.getElementById("week-date").max]'), ['1900-01-08', '9999-12-20']);
    }
    await evaluate('localStorage.setItem(HarborStorage.KEY, ' + q(JSON.stringify(original)) + ')');
    await send('Page.reload'); await ready();
  });
  await require('./copy-week-scenarios.cjs')({ send, evaluate, click, set, submit, saved, key, close, settle, ready, check, screenshot, noOverflow, q });
  await check('corrupt browser data is visibly protected from overwrites', async () => {
    await evaluate('localStorage.setItem(HarborStorage.KEY, "{broken")'); await send('Page.reload'); await ready();
    assert.match(await evaluate('document.getElementById("storage-warning").textContent'), /NOT been overwritten/);
    await click('[data-action="edit-shift"][data-id="s-mon-dock"]'); await set('#shift-title', 'Temporary title'); await submit('shift-form');
    assert.equal(await evaluate('localStorage.getItem(HarborStorage.KEY)'), '{broken');
    assert.match(await evaluate('document.getElementById("status").textContent'), /this tab only/);
  });
  await check('blocked browser storage stays usable with an explicit warning', async () => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(window, "localStorage", {get(){throw new DOMException("blocked", "SecurityError")}})' });
    await send('Page.reload'); await ready();
    assert.match(await evaluate('document.getElementById("storage-warning").textContent'), /unavailable/);
    await click('[data-action="edit-shift"][data-id="s-mon-dock"]'); await set('#shift-title', 'Memory-only title'); await submit('shift-form');
    assert.match(await evaluate('document.getElementById("schedule").textContent'), /Memory-only title/);
    assert.match(await evaluate('document.getElementById("storage-warning").textContent'), /temporary/);
  });
  await check('no page exceptions, console errors, or network requests', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.filter(url => !url.startsWith('file:') && !url.startsWith('data:') && url !== 'about:blank'), []);
    assert.ok(requests.some(url => url.endsWith('/app.js')), 'Real app assets must have loaded');
  });
  console.log('\n' + passed + '/' + passed + ' browser checks passed. Screenshots: e6-harbor/artifacts/. App: ' + appRoot);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const task of pending.values()) clearTimeout(task.timer);
  browser.kill('SIGTERM');
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(); else { browser.once('exit', resolve); setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 2000).unref(); } });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
