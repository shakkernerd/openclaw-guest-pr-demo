'use strict';
// Additional real-page scenarios, run by browser-check.cjs using its Chromium pipe.
const assert = require('node:assert/strict');
const C = require('../core.js');
module.exports = async function copyScenarios(h) {
  const { send, evaluate, click, set, submit, saved, key, close, settle, ready, check, screenshot, noOverflow, q } = h;
  const original = await saved();
  const raw = () => evaluate('localStorage.getItem(HarborStorage.KEY)');
  const schedule = () => evaluate('document.getElementById("schedule").innerHTML');
  const load = async state => { await evaluate('localStorage.setItem(HarborStorage.KEY, ' + q(JSON.stringify(state)) + ')'); await send('Page.reload'); await ready(); };
  const goWeek = async date => { await set('#week-date', date); await evaluate('document.getElementById("week-date").dispatchEvent(new Event("change"))'); await settle(); };
  const viewport = async width => send('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 600 : 900, deviceScaleFactor: 1, mobile: width < 500 });
  function destination(start = '12:00', end = '13:00') {
    let s = C.demo();
    s = C.saveShift(s, { id: 'existing', title: 'Quay handover', date: '2026-11-02', start, end, role: 'Shore support', required: 1, notes: 'Already planned; retain me.' });
    return C.saveAssignment(s, { id: 'existing-a', shiftId: 'existing', volunteerId: 'v-maya' });
  }
  await check('copy dialog is explicit, whole-week, keyboard-safe and narrow-screen usable without saving on open/cancel', async () => {
    await load(C.demo());
    for (const width of [1280, 360, 320]) {
      await viewport(width);
      await set('#role-filter', 'Dock lead'); await evaluate('document.getElementById("role-filter").dispatchEvent(new Event("change"))');
      const before = await raw(); const beforeView = await schedule();
      await evaluate('document.getElementById("copy-week").focus()'); await key('Enter'); await settle();
      assert.equal(await evaluate('document.activeElement.id'), 'dialog-title');
      assert.equal(await evaluate('document.getElementById("copy-none").checked'), true);
      assert.match(await evaluate('document.getElementById("copy-summary").textContent'), /10 shifts.*2026-10-26.*2026-11-02/);
      await key('Enter');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat: true });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      assert.equal(await raw(), before);
      for (const modifiers of [0, 8]) for (let i = 0; i < 16; i++) {
        await key('Tab', modifiers);
        assert.equal(await evaluate('document.getElementById("editor").contains(document.activeElement)'), true);
      }
      await noOverflow();
      await evaluate('document.getElementById("dialog-title").focus()'); await settle();
      if (width !== 360) await screenshot('copy-week-' + width);
      await close(); assert.equal(await evaluate('document.activeElement.id'), 'copy-week');
      assert.equal(await raw(), before); assert.equal(await schedule(), beforeView);
    }
  });
  await check('keyboard carries crew into a populated week with exact back-to-back duties and reload preserves both weeks', async () => {
    await viewport(1280); const base = destination(); await load(base);
    await evaluate('document.getElementById("copy-week").focus()'); await key('Enter'); await settle();
    await key('Tab'); await key('Tab');
    assert.equal(await evaluate('document.activeElement.id'), 'copy-none');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    assert.equal(await evaluate('document.getElementById("copy-carry").checked'), true);
    await key('Tab'); await key('Tab'); assert.equal(await evaluate('document.activeElement.id'), 'copy-confirm');
    await key('Enter'); await settle();
    assert.equal(await evaluate('document.getElementById("editor").open'), false);
    assert.equal(await evaluate('document.activeElement.id'), 'copy-week');
    const next = await saved(); assert.equal(next.shifts.length, 21); assert.equal(next.assignments.length, 23);
    assert.deepEqual(next.shifts.slice(0, base.shifts.length), base.shifts); assert.deepEqual(next.assignments.slice(0, base.assignments.length), base.assignments);
    assert.deepEqual(next.volunteers, base.volunteers);
    next.shifts.slice(11).forEach((s, i) => assert.deepEqual({ ...s, id: base.shifts[i].id, date: base.shifts[i].date }, base.shifts[i]));
    assert.equal(await evaluate('document.getElementById("week-date").value'), '2026-11-02');
    assert.match(await evaluate('document.getElementById("status").textContent'), /Copied 10 shifts.*11 assignments.*Original week unchanged.*Saved/);
    const rendered = await schedule(); await screenshot('copy-week-success');
    await send('Page.reload'); await ready(); assert.deepEqual(await saved(), next);
    await goWeek('2026-11-02'); assert.equal(await schedule(), rendered);
    await goWeek('2026-10-26'); assert.equal(await evaluate('document.querySelectorAll(".shift-card").length'), 10);
  });
  await check('matching destination work rejects the complete copy even with different capacity/notes', async () => {
    const base = C.demo(); const last = base.shifts.at(-1);
    base.shifts.push({ ...last, id: 'existing', date: C.addDays(last.date, 7), title: last.title.toUpperCase(), required: 20, notes: 'Changed capacity' });
    await load(base); await viewport(320); const before = await raw(); const beforeView = await schedule();
    await click('#copy-week'); await submit('copy-form');
    assert.equal(await raw(), before); assert.equal(await schedule(), beforeView);
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /No changes applied.*Destination already contains.*Use the existing shift/);
    assert.equal(await evaluate('document.activeElement.id'), 'dialog-error'); await noOverflow(); await screenshot('copy-week-duplicate');
    await close(); await send('Page.reload'); await ready(); assert.equal(await raw(), before);
  });
  await check('conflicting carried crew reject atomically; shifts-only retry works and unavailable crew remain blocked', async () => {
    await viewport(1280); const base = destination('09:30', '10:30'); await load(base);
    const before = await raw(); const beforeView = await schedule(); await click('#copy-week'); await click('#copy-carry'); await submit('copy-form');
    assert.equal(await raw(), before); assert.equal(await schedule(), beforeView);
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Overlaps.*Copy shifts only/);
    await screenshot('copy-week-overlap'); await click('#copy-none'); await submit('copy-form');
    const next = await saved(); assert.equal(next.shifts.length, 21); assert.deepEqual(next.assignments, base.assignments);
    const target = next.shifts.find(s => s.date === '2026-11-02' && s.title === 'Open the harbor');
    await click('[data-action="assign"][data-id="' + target.id + '"]');
    assert.equal(await evaluate('document.querySelector("#candidate option[value=v-nia]").disabled'), true);
    await evaluate('document.querySelector("#candidate option[value=v-nia]").disabled=false; document.getElementById("candidate").value="v-nia"');
    await submit('assignment-form'); assert.deepEqual(await saved(), next);
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Unavailable.*Monday/);
    await screenshot('copy-week-unavailable'); await close();
  });
  await check('empty and partly out-of-range source weeks cannot partially copy', async () => {
    const base = C.demo(); base.assignments = [];
    base.shifts = [{ ...base.shifts[0], date: '9999-12-13' }, { ...base.shifts[1], date: '9999-12-14' }];
    await load(base); const before = await raw(); const beforeView = await schedule(); await click('#copy-week'); await submit('copy-form');
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Cannot copy.*9999-12-21.*earlier source week/);
    assert.equal(await raw(), before); assert.equal(await schedule(), beforeView); await close();
    await load(C.demo()); await goWeek('2026-11-09'); const emptyBefore = await raw();
    await click('#copy-week'); assert.equal(await evaluate('document.getElementById("copy-confirm").disabled'), true);
    await evaluate('document.getElementById("copy-confirm").disabled=false'); await submit('copy-form');
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /no shifts to copy/);
    assert.equal(await raw(), emptyBefore); await close();
    base.shifts = [{ ...base.shifts[0], date: '9999-12-20' }]; await load(base);
    const boundaryRaw = await raw(); const boundaryView = await schedule();
    await evaluate('document.getElementById("copy-week").focus()'); await key('Enter'); await settle();
    assert.equal(await evaluate('document.getElementById("editor").open'), false);
    assert.match(await evaluate('document.getElementById("status").textContent'), /Cannot copy.*earlier source week.*No changes applied/);
    assert.equal(await raw(), boundaryRaw); assert.equal(await schedule(), boundaryView);
    assert.equal(await evaluate('document.activeElement.id'), 'copy-week');
  });
  await check('quota failure leaves copy unapplied in both memory and storage, and can be retried', async () => {
    await load(C.demo()); const before = await raw(); const beforeView = await schedule();
    await evaluate('window.originalSetItem=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw new DOMException("full","QuotaExceededError")}');
    await click('#copy-week'); await submit('copy-form');
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Copy not applied.*Could not save/);
    assert.equal(await raw(), before); assert.equal(await schedule(), beforeView);
    assert.equal(await evaluate('document.getElementById("week-date").value'), '2026-10-26');
    await evaluate('Storage.prototype.setItem=window.originalSetItem'); await submit('copy-form');
    assert.equal((await saved()).shifts.length, 20); assert.equal((await saved()).assignments.length, 11);
  });
  await check('newer-tab and protected saved data cannot be overwritten by copying', async () => {
    await load(C.demo()); const beforeView = await schedule(); await click('#copy-week');
    const newer = C.demo(); newer.shifts[0].notes = 'Newer tab edit';
    await evaluate('localStorage.setItem(HarborStorage.KEY, ' + q(JSON.stringify(newer)) + ')');
    await submit('copy-form'); assert.deepEqual(await saved(), newer); assert.equal(await schedule(), beforeView);
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Copy not applied.*Another tab/); await close();
    await evaluate('localStorage.setItem(HarborStorage.KEY,"{broken")'); await send('Page.reload'); await ready();
    const demoView = await schedule(); await click('#copy-week'); await submit('copy-form');
    assert.equal(await raw(), '{broken'); assert.equal(await schedule(), demoView);
    assert.match(await evaluate('document.getElementById("dialog-error").textContent'), /Copy not applied.*protected/); await close();
  });
  await check('duplicate source work names the source conflict, not nonexistent destination work', async () => {
    const base = C.demo(); base.shifts.push({ ...base.shifts[0], id: 'source-duplicate', title: '  OPEN THE HARBOR  ', required: 2 });
    await load(base); await viewport(320);
    const before = await raw(); const beforeView = await schedule();
    await click('#copy-week'); await submit('copy-form');
    const message = await evaluate('document.getElementById("dialog-error").textContent');
    assert.match(message, /No changes applied.*Source week contains duplicate work.*Open the harbor.*2026-10-26.*distinct titles/);
    assert.doesNotMatch(message, /Destination already contains|Use the existing shift/);
    assert.match(await evaluate('document.querySelector("#dialog-content .dialog-note").textContent'), /^0 shifts already/);
    assert.equal(await raw(), before); assert.equal(await schedule(), beforeView);
    await noOverflow(); await screenshot('copy-week-source-duplicate'); await close();
  });
  await load(original);
};
