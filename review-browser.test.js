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
async function runBrowser(args, directory, url) {
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
    await send("Page.navigate", { url }, sessionId);
    return await completed;
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
    if (mode === "reload" && sessionStorage.getItem("review-test-phase") === "reload") {
      check($("storage-status").textContent.startsWith("Restored"), "reload did not announce restoration");
      const restored = JSON.parse(snapshot());
      check(restored.reviews["R-101"].decision === "approved", "decision lost across reload");
      check(restored.reviews["R-101"].notes === "Survives a real reload ✓", "notes lost across reload");
      check(restored.records.length === 4, "records lost across reload");
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

for (const mode of ["sandbox", "reload", "corrupt", "quota"]) {
  test("browser: " + mode, { skip: !browser && "Set RECORD_REVIEW_BROWSER to an existing Chromium executable", timeout: 30000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "record-review-browser-"));
    try {
      let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      let setup = "";
      if (mode === "corrupt") setup = 'localStorage.setItem("record-review:v1", "{corrupt");';
      if (mode === "quota") setup = 'localStorage.setItem("record-review:v1", JSON.stringify({format:"record-review",version:1,records:[{id:"a",title:"Stored"}],reviews:{a:{decision:"unreviewed",notes:""}}})); Storage.prototype.setItem = function () { throw new DOMException("Full", "QuotaExceededError"); };';
      html = html.replace("<script>", "<script>" + setup + "</script><script>");
      html = html.replace("</body>", "<script>(" + exercise.toString() + ")(" + JSON.stringify(mode) + ");</script></body>");
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
      const result = await runBrowser(args, directory, pathToFileURL(file).href);
      assert.equal(result, "PASS " + mode, "Browser result: " + result);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
