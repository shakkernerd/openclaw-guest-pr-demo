"use strict";

// Optional real-browser checks using an already-installed Chromium. No packages,
// server, or browser download. Default node --test clearly skips these if absent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const browser = process.env.RECORD_REVIEW_BROWSER;

// Drive the existing browser over a local pipe, waiting for the actual result.
// No HTTP server, debug port, dependencies, or virtual-time iframe races.
async function runBrowser(args, directory, url, drive) {
  const child = spawn(browser, [...args, "--remote-debugging-pipe", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory },
  });
  let buffer = "";
  let diagnostic = "";
  let nextId = 0;
  const pending = new Map();
  let report;
  let fail;
  const completed = new Promise((resolve, reject) => { report = resolve; fail = reject; });
  // Attach immediately so early browser errors cannot become unhandled rejections.
  completed.catch(() => {});
  const timer = setTimeout(() => fail(new Error("Browser timed out: " + diagnostic.slice(-3000))), 20000);
  child.stderr.on("data", chunk => { diagnostic += chunk; });
  child.on("error", fail);
  child.on("exit", code => {
    const error = new Error("Browser exited " + code + ": " + diagnostic.slice(-3000));
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    fail(error);
  });
  child.stdio[4].setEncoding("utf8");
  child.stdio[4].on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
          else entry.resolve(message.result);
        }
      } else if (message.method === "Runtime.bindingCalled" && message.params.name === "reportReviewTest") {
        report(message.params.payload);
      } else if (message.method === "Runtime.exceptionThrown") {
        diagnostic += JSON.stringify(message.params);
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await send("Runtime.addBinding", { name: "reportReviewTest" }, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Page.bringToFront", {}, sessionId);
    await send("Page.navigate", { url }, sessionId);
    const result = await completed;
    return drive ? await drive((method, params) => send(method, params, sessionId), result) : result;
  } finally {
    clearTimeout(timer);
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await exited;
  }
}

// This function runs inside the shipped page, not a mock DOM.
async function exercise(mode) {
  const $ = id => document.getElementById(id);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const fire = (id, value, event = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new Event(event, { bubbles: true }));
  };
  const click = id => $(id).click();
  const decision = value => document.querySelector('[data-decision="' + value + '"]').click();
  const paste = value => { $("paste-json").value = value; click("import-paste"); };
  const snapshot = () => { click("export-open"); return $("export-json").value; };
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));
  const checkNoteFinish = () => {
    const original = snapshot();
    const fixture = JSON.parse(original);
    fixture.reviews["R-101"] = { decision: "approved", notes: "Inventory matches the signed count." };
    fixture.reviews["R-102"] = { decision: "approved", notes: "Keep this other review." };
    fixture.reviews["R-103"] = { decision: "rejected", notes: "Also mentions signed count." };
    const start = () => {
      paste(JSON.stringify(fixture));
      fire("search", "signed count");
      fire("filter", "approved", "change");
    };
    const typeNote = value => {
      const notes = $("notes");
      notes.focus();
      if (mode !== "sandbox") check(document.hasFocus() && document.activeElement === notes, "standalone notes did not receive real focus");
      const focus = document.activeElement;
      notes.value = value;
      notes.setSelectionRange(5, 5);
      notes.dispatchEvent(new Event("input", { bubbles: true }));
      check(document.activeElement === focus && notes.selectionStart === 5 && notes.selectionEnd === 5, "typing refreshed the editor or moved the caret");
      check($("record-id").textContent === "R-101" && !$("record-editor").hidden, "typing switched the edited record");
      if (mode !== "sandbox") check(JSON.parse(localStorage.getItem("record-review:v1")).reviews["R-101"].notes === value, "typed note was not persisted");
    };
    const leaveNotes = target => {
      const hadFocus = document.activeElement === $("notes");
      target.focus(); // Real focus/blur in the downloaded standalone page.
      // Opaque iframe focus may be denied; still exercise its blur listener.
      if (!hadFocus) $("notes").dispatchEvent(new FocusEvent("blur"));
      if (mode !== "sandbox") check(document.activeElement === target, "leaving notes stole focus from its destination");
    };
    start();
    check($("list-count").textContent === "1 of 4 records", "note-finish fixture did not isolate one match");
    typeNote("Inventory confirmed.");
    check($("list-count").textContent === "1 of 4 records", "results changed during typing");
    leaveNotes($("filter"));
    check($("search").value === "signed count" && $("list-count").textContent === "0 of 4 records" && document.querySelectorAll(".record").length === 0, "leaving notes did not refresh the matching list/count");
    check(!$("record-editor").hidden && $("record-id").textContent === "R-101" && $("notes").value === "Inventory confirmed.", "leaving notes lost or switched the editor");
    check(!$("selection-status").hidden && $("selection-status").textContent.includes("R-101"), "nonmatching editor is not clearly identified");
    const expected = JSON.parse(JSON.stringify(fixture));
    expected.reviews["R-101"].notes = "Inventory confirmed.";
    check(snapshot() === JSON.stringify(expected, null, 2), "note completion changed other reviews or lost full export data");
    typeNote("Inventory confirmed. Final.");
    leaveNotes($("filter"));
    check(JSON.parse(snapshot()).reviews["R-101"].notes === "Inventory confirmed. Final.", "subsequent edits did not stay on the original record");
    typeNote("Inventory matches the signed count again.");
    leaveNotes($("filter"));
    check($("list-count").textContent === "1 of 4 records" && $("selection-status").hidden, "re-entering the search match did not refresh the list/status");

    // With another match available, programmatic focus must not auto-select it
    // or replace its button. Physical hit testing is covered separately below.
    fixture.reviews["R-102"].notes = "Another signed count.";
    start();
    const nextButton = document.querySelectorAll(".record")[1];
    typeNote("Inventory confirmed.");
    leaveNotes(nextButton);
    check($("list-count").textContent === "1 of 4 records" && document.querySelector(".record") === nextButton, "note completion replaced the pending selection target");
    check($("record-id").textContent === "R-101" && !$("record-editor").hidden, "blur silently selected a different matching record");
    typeNote("Inventory confirmed. Still this record.");
    leaveNotes(nextButton);
    nextButton.click();
    check($("record-id").textContent === "R-102" && $("notes").value === "Another signed count.", "explicit selection failed or subsequent edits leaked to another record");
    expected.reviews["R-101"].notes = "Inventory confirmed. Still this record.";
    expected.reviews["R-102"].notes = "Another signed count.";
    check(snapshot() === JSON.stringify(expected, null, 2), "finishing filtered notes altered unrelated record data");
    start();
    typeNote("Inventory confirmed.");
    const rejectButton = document.querySelector('[data-decision="rejected"]');
    leaveNotes(rejectButton);
    rejectButton.click();
    const decided = JSON.parse(snapshot());
    check(decided.reviews["R-101"].decision === "rejected" && decided.reviews["R-101"].notes === "Inventory confirmed." && decided.reviews["R-102"].decision === "approved", "decision after note blur targeted another record");
    paste(original);
    check(snapshot() === original, "note-finish regression did not restore its starting snapshot");
  };
  const finish = result => {
    if (mode === "sandbox") parent.postMessage({ recordReviewTest: result }, "*");
    else {
      const output = document.createElement("pre");
      output.id = "result";
      output.textContent = result;
      document.body.append(output);
      window.reportReviewTest(result);
    }
  };
  try {
    // Navigation can run this inline script before Chromium restores page focus.
    // Wait for the actual focus event, not a delay or synthetic blur fallback.
    if (mode === "reload" && !document.hasFocus()) {
      await new Promise(resolve => window.addEventListener("focus", resolve, { once: true }));
    }
    if (mode === "reload" && sessionStorage.getItem("review-test-phase") === "reload") {
      check($("storage-status").textContent.startsWith("Restored"), "reload did not announce restoration");
      const restored = JSON.parse(snapshot());
      check(restored.reviews["R-101"].decision === "approved", "decision lost across reload");
      check(restored.reviews["R-101"].notes === "Survives a real reload ✓", "notes lost across reload");
      check(restored.records.length === 4, "records lost across reload");
      fire("search", "real reload");
      fire("filter", "approved", "change");
      check(document.querySelectorAll(".record").length === 1 && $("record-id").textContent === "R-101", "restored notes are not searchable with the decision filter");
      checkNoteFinish();
      finish("PASS reload");
      return;
    }
    if (mode === "corrupt") {
      check($("storage-status").textContent.includes("has not been overwritten"), "corrupt storage warning missing");
      check(localStorage.getItem("record-review:v1") === "{corrupt", "startup overwrote corrupt storage");
      paste("not JSON");
      check(localStorage.getItem("record-review:v1") === "{corrupt", "invalid import overwrote corrupt storage");
      click("sample");
      check(JSON.parse(localStorage.getItem("record-review:v1")).records.length === 4, "valid import did not replace corrupt save");
      finish("PASS corrupt");
      return;
    }
    if (mode === "quota") {
      check($("storage-status").textContent.startsWith("Restored"), "readable storage not restored");
      decision("approved");
      fire("notes", "Still in memory");
      check($("storage-status").textContent.startsWith("Memory only"), "quota failure incorrectly announced saved");
      const exported = JSON.parse(snapshot());
      check(exported.reviews.a.notes === "Still in memory", "quota failure lost notes");
      check(exported.reviews.a.decision === "approved", "quota failure lost decision");
      check(JSON.parse(localStorage.getItem("record-review:v1")).reviews.a.decision === "unreviewed", "quota test unexpectedly saved");
      finish("PASS quota");
      return;
    }
    if (mode === "sandbox") {
      let denied = false;
      try { window.localStorage.getItem("test"); } catch { denied = true; }
      check(denied, "fixture must deny storage with an opaque origin");
      check($("storage-status").textContent.startsWith("Memory only"), "missing sandbox storage warning");
    }
    click("sample");
    check(document.querySelectorAll(".record").length === 4, "sample list missing");
    check($("record-id").textContent === "R-101", "first record not selected");
    decision("approved");
    fire("notes", "Survives a real reload ✓");
    if (mode === "reload") {
      check($("storage-status").textContent.startsWith("Saved"), "browser did not save");
      const saved = localStorage.getItem("record-review:v1");
      paste("[{bad JSON]");
      check(localStorage.getItem("record-review:v1") === saved, "invalid import modified saved storage");
      check(snapshot() === saved, "invalid import modified live review");
      sessionStorage.setItem("review-test-phase", "reload");
      location.reload();
      return;
    }
    check($("count-progress").textContent === "1 / 4", "decision totals wrong");
    const before = snapshot();
    paste('[{"id":"ok","title":"First valid"},{"id":"bad"}]');
    check($("import-error").textContent.includes("unchanged"), "validation message missing");
    check(snapshot() === before, "late invalid record replaced accepted data");
    paste('{"format":"record-review","version":2}');
    check(snapshot() === before, "invalid snapshot replaced accepted data");
    paste('[{"id":"x","title":"One"},{"id":"x","title":"Duplicate"}]');
    check(snapshot() === before, "duplicate ID replaced accepted data");
    fire("search", "PARCEL");
    check(document.querySelectorAll(".record").length === 1, "search not case insensitive");
    check($("record-id").textContent === "R-102", "search selected wrong record");
    fire("filter", "approved", "change");
    check(!$("empty").hidden && $("record-editor").hidden, "empty filter has stale editor");
    check(snapshot() === before, "filter changed exported data");
    fire("search", "");
    check($("record-id").textContent === "R-101", "filter selection not recovered");
    decision("rejected");
    check($("record-editor").hidden, "decision moving out of filter left stale editor");
    fire("filter", "all", "change");
    check($("notes").value === "Survives a real reload ✓", "notes lost across filtering");
    paste(before); // exact snapshot restore
    check(snapshot() === before, "snapshot import did not round-trip");

    // Notes-only matches use the latest review text and intersect the filter.
    check(document.querySelector('label[for="search"]').textContent.includes("notes"), "search label omits notes");
    fire("notes", "Inventory matches the signed count.");
    const noted = snapshot();
    fire("search", "  SIGNED count  ");
    fire("filter", "approved", "change");
    check(document.querySelectorAll(".record").length === 1 && $("record-id").textContent === "R-101", "notes-only search missed the reviewed record");
    fire("filter", "rejected", "change");
    check($("record-editor").hidden && !$("empty").hidden, "note match ignored the decision filter");
    check(snapshot() === noted, "notes search changed the full export");
    fire("filter", "approved", "change");
    $("notes").focus();
    $("notes").value = "Inventory differs.";
    $("notes").setSelectionRange(5, 5);
    // The opaque iframe may deny programmatic focus without user activation.
    const focusBeforeTyping = document.activeElement;
    $("notes").dispatchEvent(new Event("input", { bubbles: true }));
    check(document.activeElement === focusBeforeTyping && $("notes").selectionStart === 5, "editing a searched note disrupted focus or caret");
    fire("search", "signed count");
    check($("record-editor").hidden, "search used stale notes after editing");
    fire("search", "differs");
    check($("record-id").textContent === "R-101" && $("notes").value === "Inventory differs.", "updated notes are not searchable");
    paste(before);
    check(snapshot() === before, "notes-search workflow changed snapshot restoration");
    checkNoteFinish();
    click("select-export");
    check($("export-json").selectionStart === 0 && $("export-json").selectionEnd === before.length, "manual copy fallback did not select export");
    click("download"); // blocked silently by the unchanged restrictive iframe
    check($("download-status").textContent.includes("not confirmed"), "download falsely claimed completion");
    const originalCreateURL = URL.createObjectURL;
    URL.createObjectURL = () => { throw new Error("Unavailable"); };
    click("download");
    check($("download-status").textContent.includes("unavailable"), "throwing download fallback failed");
    check(snapshot() === before, "download failure changed review");
    URL.createObjectURL = originalCreateURL;

    // Actual File input, including the async read and same-file retry reset.
    const fileInput = $("file-input");
    const transfer = new DataTransfer();
    transfer.items.add(new File(['[{"id":"file","title":"From file"}]'], "records.json", { type: "application/json" }));
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change"));
    for (let i = 0; i < 100 && $("record-id").textContent !== "file"; i++) await tick();
    check($("record-id").textContent === "file", "file import did not complete");
    check(fileInput.value === "", "file input did not reset for retry");

    // Controllable reads expose the race: latest *started* import must win.
    function deferredFile(name) {
      let resolve;
      let reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      Object.defineProperty(fileInput, "files", { configurable: true, value: [{ name, text: () => pending }] });
      fileInput.dispatchEvent(new Event("change"));
      return { resolve, reject };
    }
    const slow = deferredFile("slow.json");
    paste(before);
    slow.resolve('[{"id":"stale","title":"Must not win"}]');
    await tick();
    check(snapshot() === before, "slow file replaced newer paste");
    const old = deferredFile("old.json");
    const latest = deferredFile("new.json");
    latest.resolve('[{"id":"new","title":"Newest"}]');
    await tick();
    const newest = snapshot();
    old.resolve('[{"id":"old","title":"Older"}]');
    await tick();
    check(snapshot() === newest, "out-of-order files reverted newer import");
    const pending = deferredFile("pending.json");
    paste("invalid JSON");
    pending.resolve(before);
    await tick();
    check(snapshot() === newest, "rejected newer import allowed stale completion");
    const failed = deferredFile("failed.json");
    failed.reject(new Error("Unreadable"));
    await tick();
    check(snapshot() === newest && $("import-error").textContent.includes("Could not read"), "file read failure was not atomic");

    // Imported markup is text, not active HTML; prototype-like IDs are safe.
    const hostile = '<img src=x onerror="window.injected=true">';
    paste(JSON.stringify([{ id: "__proto__", title: hostile, extra: "</textarea>" }]));
    check($("record-title").textContent === hostile && !$("record-title").querySelector("img"), "title rendered as HTML");
    check(!window.injected, "imported markup executed");
    decision("follow-up");
    fire("notes", "Safe notes ✓");
    check(JSON.parse(snapshot()).reviews.__proto__.notes === "Safe notes ✓", "special ID failed in browser");
    paste("[]");
    check($("record-editor").hidden && $("count-progress").textContent === "0 / 0", "valid empty import left stale data");
    check(JSON.parse(snapshot()).records.length === 0, "empty export invalid");
    check(performance.getEntriesByType("resource").length === 0, "app made resource requests");
    finish("PASS sandbox");
  } catch (error) { finish("FAIL " + error.message + "\n" + error.stack); }
}

// Drive actual hit-tested pointer down/up at fixed coordinates. A focus()+click()
// pair cannot detect a button moving away between mouse-down and mouse-up.
async function exercisePointer(send, mode, ready) {
  assert.equal(ready, "READY " + mode);
  const evaluate = async (fn, ...args) => {
    const result = await send("Runtime.evaluate", {
      expression: "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
      returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  let buttons = 0;
  const mouse = (type, point) => {
    if (type === "mousePressed") buttons = 1;
    if (type === "mouseReleased") buttons = 0;
    return send("Input.dispatchMouseEvent", {
      type, ...point, button: type === "mouseMoved" ? "none" : "left",
      buttons, clickCount: type === "mouseMoved" ? 0 : 1,
    });
  };
  const center = selector => evaluate(selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  const inspect = () => evaluate(() => {
    const $ = id => document.getElementById(id);
    return {
      id: $("record-id").textContent, count: $("list-count").textContent,
      notes: $("notes").value, focused: document.activeElement.id,
      caret: $("notes").selectionStart, notice: !$("selection-status").hidden,
      saved: JSON.parse(localStorage.getItem("record-review:v1")), events: window.pointerEvents,
      exported: $("export-json").value, selection: [$("export-json").selectionStart, $("export-json").selectionEnd],
      exportOpen: $("export-panel").open, detailsOpen: $("record-details").open,
      detail: JSON.parse($("record-json").textContent), downloads: window.pointerDownloads,
      downloadStatus: $("download-status").textContent,
    };
  });
  const selector = {
    "pointer-record": "#record-list li:nth-child(2) button",
    "pointer-decision": '[data-decision="rejected"]',
    "pointer-export-select": "#select-export",
    "pointer-download": "#download",
    "pointer-details": "#record-details > summary",
    "pointer-export-toggle": "#export-panel > summary",
  }[mode];
  const openExport = mode === "pointer-export-select" || mode === "pointer-download";
  const note = "Changed A note.";
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false });
  // Observe the app's generated download request/blob, without claiming a disk
  // save or changing the production download/sandbox policy.
  await evaluate(() => {
    const createURL = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      window.pointerBlob = blob;
      return createURL.call(this, blob);
    };
    document.addEventListener("click", event => {
      const link = event.target.closest("a[download]");
      if (link) { event.preventDefault(); window.pointerDownloads++; }
    });
  });
  const setup = async () => {
    await evaluate((selector, openExport) => {
      const $ = id => document.getElementById(id);
      $("paste-json").value = JSON.stringify({
        format: "record-review", version: 1,
        records: [{ id: "A", title: "Alpha", extra: 1 }, { id: "B", title: "Beta", extra: 2 }],
        reviews: { A: { decision: "unreviewed", notes: "shared query A" }, B: { decision: "unreviewed", notes: "shared query B" } },
      });
      $("import-paste").click();
      $("search").value = "shared query";
      $("search").dispatchEvent(new Event("input", { bubbles: true }));
      $("export-panel").open = openExport;
      $("record-details").open = false;
      window.pointerDownloads = 0;
      window.pointerBlob = null;
      window.pointerEvents = [];
      const target = window.pointerTarget = document.querySelector(selector);
      for (const type of ["pointerdown", "pointerup", "click"]) {
        target.addEventListener(type, event => window.pointerEvents.push({ type, trusted: event.isTrusted }), { once: true });
      }
    }, selector, openExport);
    const notes = await center("#notes");
    await mouse("mouseMoved", notes);
    await mouse("mousePressed", notes);
    await mouse("mouseReleased", notes);
    await evaluate(() => document.getElementById("notes").select());
    await send("Input.insertText", { text: note });
    const editing = await inspect();
    assert.equal(editing.focused, "notes");
    assert.equal(editing.caret, note.length);
    assert.equal(editing.id, "A");
    assert.equal(editing.count, "2 of 2 records");
    assert.equal(editing.saved.reviews.A.notes, note);
    return center(selector);
  };
  const point = await setup();
  if (mode === "pointer-export-toggle") await evaluate(() => {
    window.pointerToggle = new Promise(resolve => document.getElementById("export-panel").addEventListener("toggle", resolve, { once: true }));
  });
  await mouse("mouseMoved", point);
  await mouse("mousePressed", point);
  const during = await inspect();
  const afterDown = await evaluate(() => {
    const r = window.pointerTarget.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await mouse("mouseReleased", point); // Do NOT recompute the release position.
  if (mode === "pointer-export-toggle") {
    assert.equal(await evaluate(() => document.getElementById("export-panel").open), true, "first physical Portable review JSON click did not open the panel");
    await evaluate(() => window.pointerToggle.then(() => true));
  }
  const result = await inspect();
  assert.equal(result.saved.reviews.A.notes, note);
  assert.equal(result.saved.reviews.B.notes, "shared query B");
  if (mode === "pointer-record") {
    assert.equal(result.id, "B", "first physical click did not select B");
    assert.equal(result.notes, "shared query B");
  } else if (mode === "pointer-decision") {
    assert.equal(result.saved.reviews.A.decision, "rejected", "first physical Reject click did not apply to A");
  } else {
    assert.equal(result.id, "A", "leaving notes for another control switched the record");
    assert.equal(result.notice, true, "missing outside-results notice");
    if (mode === "pointer-export-select") {
      assert.equal(result.focused, "export-json", "first physical Select JSON click did not focus export");
      assert.deepEqual(result.selection, [0, result.exported.length], "first physical Select JSON click did not select all JSON");
      assert.deepEqual(JSON.parse(result.exported), result.saved, "selection omitted or changed review data");
    } else if (mode === "pointer-download") {
      assert.equal(result.downloads, 1, "first physical download click did not request exactly one download");
      assert.match(result.downloadStatus, /requested, not confirmed/);
      const downloaded = await evaluate(() => window.pointerBlob.text());
      assert.deepEqual(JSON.parse(downloaded), result.saved, "download omitted or changed review data");
    } else if (mode === "pointer-details") {
      assert.equal(result.detailsOpen, true, "first physical details click did not open the record");
      assert.deepEqual(result.detail, result.saved.records[0]);
    } else {
      assert.equal(result.exportOpen, true, "first physical Portable review JSON click did not open the panel");
      assert.deepEqual(JSON.parse(result.exported), result.saved);
    }
  }
  assert.equal(result.saved.reviews.A.decision, mode === "pointer-decision" ? "rejected" : "unreviewed");
  assert.equal(result.saved.reviews.B.decision, "unreviewed", "action changed B's review");
  assert.equal(result.count, "1 of 2 records");
  assert.equal(during.id, "A", "selection happened on press rather than completed click");
  assert.equal(during.saved.reviews.A.decision, "unreviewed", "decision happened on press rather than completed click");
  assert.equal(during.downloads, 0);
  assert.equal(during.detailsOpen, false);
  assert.equal(during.exportOpen, openExport);
  assert.deepEqual(afterDown, point, "blur moved the intended pointer target before release");
  assert.deepEqual(result.events, ["pointerdown", "pointerup", "click"].map(type => ({ type, trusted: true })));

  // A press dragged off the control must not activate it, and keyboard blur
  // afterward must still refresh immediately (no timer or stuck gesture state).
  const cancelledPoint = await setup();
  await mouse("mouseMoved", cancelledPoint);
  await mouse("mousePressed", cancelledPoint);
  await mouse("mouseMoved", { x: 1250, y: 1550 });
  await mouse("mouseReleased", { x: 1250, y: 1550 });
  const cancelled = await inspect();
  assert.equal(cancelled.id, "A");
  assert.equal(cancelled.saved.reviews.A.decision, "unreviewed");
  assert.equal(cancelled.saved.reviews.B.decision, "unreviewed");
  assert.equal(cancelled.saved.reviews.A.notes, note);
  assert.equal(cancelled.focused, "notes");
  assert.equal(cancelled.downloads, 0);
  assert.equal(cancelled.detailsOpen, false);
  assert.equal(cancelled.exportOpen, openExport);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  const finished = await inspect();
  assert.notEqual(finished.focused, "notes");
  assert.equal(finished.id, "A");
  assert.equal(finished.count, "1 of 2 records");
  assert.equal(finished.notice, true);
  if (mode === "pointer-record") {
    // The shared activation path must not turn a click on the current row into
    // selection of B when A disappears during click-capture note completion.
    await setup();
    const current = await center("#record-list li:first-child button");
    await mouse("mouseMoved", current);
    await mouse("mousePressed", current);
    await mouse("mouseReleased", current);
    const sameRecord = await inspect();
    assert.equal(sameRecord.id, "A");
    assert.equal(sameRecord.count, "1 of 2 records");
    assert.equal(sameRecord.notice, true);
    assert.equal(sameRecord.saved.reviews.A.notes, note);
    assert.equal(sameRecord.saved.reviews.B.notes, "shared query B");
  }
  return "PASS " + mode;
}

// Optional physical-keyboard and narrow-layout acceptance for comparison. The
// Node adapter tests cover deterministic read races without launching a browser.
async function exerciseComparison(send, ready) {
  assert.equal(ready, "READY comparison");
  const evaluate = async (fn, ...args) => {
    const result = await send("Runtime.evaluate", {
      expression: "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
      returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const key = async (key, code, number) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: number });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: number });
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate(() => {
    const $ = id => document.getElementById(id);
    window.comparisonFixture = {
      format: "record-review", version: 1,
      records: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }],
      reviews: { a: { decision: "approved", notes: "keep A" }, b: { decision: "approved", notes: "keep B" } },
    };
    $("paste-json").value = JSON.stringify(window.comparisonFixture);
    $("import-paste").click();
    $("search").value = "keep";
    $("search").dispatchEvent(new Event("input"));
    $("filter").value = "approved";
    $("filter").dispatchEvent(new Event("change"));
    document.querySelectorAll(".record")[1].click();
    $("notes").focus(); $("notes").select();
  });
  await send("Input.insertText", { text: "Changed ✓" }); // creates a native Undo entry
  await evaluate(() => document.getElementById("compare-open").focus());
  await key("Enter", "Enter", 13);
  assert.equal(await evaluate(() => document.activeElement.id), "compare-json");
  const working = () => evaluate(() => {
    const $ = id => document.getElementById(id);
    return { saved: localStorage.getItem("record-review:v1"), id: $("record-id").textContent,
      notes: $("notes").value, search: $("search").value, filter: $("filter").value,
      count: $("list-count").textContent, notice: !$("selection-status").hidden };
  });
  const before = await working();
  assert.equal(before.id, "b");
  assert.equal(before.count, "1 of 2 records");
  assert.equal(before.notice, true);
  await evaluate(() => {
    const incoming = JSON.parse(JSON.stringify(window.comparisonFixture));
    incoming.records[1].title = '<img src=x onerror="window.comparisonInjected=true"> 雪';
    incoming.records[1].empty = "";
    incoming.records[1].payload = [null, false, "雪" + "long".repeat(100)];
    incoming.reviews.b = { decision: "rejected", notes: "</textarea>\n雪" };
    document.getElementById("compare-json").value = JSON.stringify(incoming);
  });
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate(() => document.activeElement.id), "compare-paste");
  await key("Enter", "Enter", 13);
  assert.deepEqual(await working(), before);
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate(() => document.activeElement.id), "compare-close");
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate(() => document.activeElement.tagName), "SUMMARY");
  await key(" ", "Space", 32);
  const rendered = await evaluate(() => {
    const list = document.getElementById("compare-list");
    const details = list.querySelector("details");
    const sides = [...details.querySelectorAll(".comparison-sides section")].map(node => {
      const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom };
    });
    return { open: details.open, text: list.textContent, values: [...details.querySelectorAll("pre")].map(node => JSON.parse(node.textContent)),
      unsafe: Boolean(list.querySelector("img, script") || window.comparisonInjected), sides,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(rendered.open, true);
  assert.equal(rendered.unsafe, false);
  assert.equal(rendered.overflow, false);
  assert.equal(rendered.sides[0].x, rendered.sides[1].x);
  assert.ok(rendered.sides[1].y >= rendered.sides[0].bottom);
  assert.match(rendered.text, /Current working review \(before\)/);
  assert.match(rendered.text, /Compared snapshot \(after\)/);
  assert.equal(rendered.values[1].notes, "Changed ✓");
  assert.equal(rendered.values[2].empty, "");
  assert.equal(rendered.values[3].notes, "</textarea>\n雪");
  await evaluate(() => document.getElementById("compare-close").focus());
  await key("Enter", "Enter", 13);
  assert.equal(await evaluate(() => document.activeElement.id), "compare-open");
  assert.deepEqual(await working(), before);
  // Comparison must not replace the notes DOM value and discard native Undo.
  await evaluate(() => document.getElementById("notes").focus());
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", commands: ["undo"] });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ" });
  assert.equal(await evaluate(() => document.getElementById("notes").value), "keep B");
  // Use an actual File and DataTransfer, not just the paste path.
  await evaluate(async () => {
    const $ = id => document.getElementById(id);
    $("compare-open").click();
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(window.comparisonFixture)], "saved-review.json", { type: "application/json" }));
    $("compare-file").files = transfer.files;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error("Comparison file did not finish")); }, 3000);
      const observer = new MutationObserver(() => {
        if (!$("compare-results").hidden) { clearTimeout(timer); observer.disconnect(); resolve(); }
      });
      observer.observe($("compare-results"), { attributes: true });
    });
    $("compare-file").dispatchEvent(new Event("change"));
    await completed;
  });
  assert.equal(await evaluate(() => document.getElementById("compare-file").value), "");
  assert.match(await evaluate(() => document.getElementById("compare-source").textContent), /saved-review.json/);
  assert.equal(await evaluate(() => performance.getEntriesByType("resource").length), 0);
  return "PASS comparison";
}

for (const mode of ["sandbox", "reload", "corrupt", "quota", "pointer-record", "pointer-decision",
  "pointer-export-select", "pointer-download", "pointer-details", "pointer-export-toggle", "comparison"]) {
  test("browser: " + mode, { skip: !browser && "Set RECORD_REVIEW_BROWSER to an existing Chromium executable", timeout: 30000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "record-review-browser-"));
    try {
      let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      let setup = "";
      if (mode === "corrupt") setup = 'localStorage.setItem("record-review:v1", "{corrupt");';
      if (mode === "quota") setup = 'localStorage.setItem("record-review:v1", JSON.stringify({format:"record-review",version:1,records:[{id:"a",title:"Stored"}],reviews:{a:{decision:"unreviewed",notes:""}}})); Storage.prototype.setItem = function () { throw new DOMException("Full", "QuotaExceededError"); };';
      html = html.replace("<script>", "<script>" + setup + "</script><script>");
      const pointer = mode.startsWith("pointer-");
      html = html.replace("</body>", pointer || mode === "comparison"
        ? "<script>window.reportReviewTest(" + JSON.stringify("READY " + mode) + ");</script></body>"
        : "<script>(" + exercise.toString() + ")(" + JSON.stringify(mode) + ");</script></body>");
      if (mode === "sandbox") {
        const escaped = html.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        html = '<!doctype html><html><body><pre id="result">WAITING</pre><script>addEventListener("message", event => { if (event.source === document.querySelector("iframe").contentWindow && event.data.recordReviewTest) window.reportReviewTest(event.data.recordReviewTest); });</script><iframe sandbox="allow-scripts" srcdoc="' + escaped + '"></iframe></body></html>';
      }
      const file = path.join(directory, "test.html");
      fs.writeFileSync(file, html);
      const args = ["--headless", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--user-data-dir=" + path.join(directory, "profile"), "--disable-component-update"];
      // Opt in only for an already-isolated container without Chromium OS sandbox
      // support. This never changes the Files preview or iframe permissions.
      if (process.env.RECORD_REVIEW_BROWSER_NO_SANDBOX === "1") args.unshift("--no-sandbox");
      const result = await runBrowser(args, directory, pathToFileURL(file).href,
        pointer ? (send, ready) => exercisePointer(send, mode, ready) : mode === "comparison" ? exerciseComparison : undefined);
      assert.equal(result, "PASS " + mode, "Browser result: " + result);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
