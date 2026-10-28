"use strict";

// Optional real-browser smoke check. Node built-ins only; bring your own Chromium.
// Usage: node scripts/check-html-browser.js /path/to/chromium [screenshot-directory]
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { validateBatch } = require("../packing.js");
const { formatHtmlReport } = require("../packing-report.js");

async function main() {
  const executable = process.argv[2];
  if (!executable) throw new Error("Usage: node scripts/check-html-browser.js /path/to/chromium [screenshot-directory]");
  const temporary = mkdtempSync(join(tmpdir(), "packing-browser-"));
  const output = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(tmpdir(), "packing-preview-"));
  mkdirSync(output, { recursive: true });
  const browser = spawn(executable, [
    "--headless", ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    "--disable-dev-shm-usage", "--disable-background-networking",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-pipe",
    "--user-data-dir=" + join(temporary, "profile"), "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_CACHE_HOME: join(temporary, "cache") },
  });
  const exited = new Promise((resolve) => { browser.once("exit", resolve); browser.once("error", resolve); });
  let fail;
  const failed = new Promise((resolve, reject) => { fail = reject; });
  browser.once("error", fail);
  browser.once("exit", (code, signal) => fail(new Error(`Browser exited (${code ?? signal}): ${errors}`)));
  browser.stdio[3].on("error", fail);
  let nextId = 0;
  let buffered = "";
  let errors = "";
  const pending = new Map();
  const listeners = new Map();
  browser.stderr.on("data", (data) => { errors = (errors + data).slice(-4000); });
  browser.stdio[4].setEncoding("utf8");
  browser.stdio[4].on("data", (data) => {
    buffered += data;
    let end;
    while ((end = buffered.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (message.id) {
        const task = pending.get(message.id);
        if (task) {
          pending.delete(message.id);
          message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
        }
      } else {
        for (const callback of listeners.get(message.method) || []) callback(message.params);
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
  const on = (method, callback) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(callback);
  };
  const timer = setTimeout(() => {
    fail(new Error("Browser check timed out: " + errors));
  }, 20000);
  const verify = async () => {
    const version = await send("Browser.getVersion");
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await page("Page.enable");
    await page("Network.enable");
    const network = [];
    on("Network.requestWillBeSent", ({ request }) => network.push(request.url));
    const navigate = async (file) => {
      const loaded = new Promise((resolve) => {
        const callback = () => { listeners.set("Page.loadEventFired", listeners.get("Page.loadEventFired").filter((item) => item !== callback)); resolve(); };
        on("Page.loadEventFired", callback);
      });
      const result = await page("Page.navigate", { url: pathToFileURL(file).href });
      assert.equal(result.errorText, undefined);
      await loaded;
    };
    const viewport = (width, height) => page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const press = async (key, code, keyCode) => {
      for (const type of ["keyDown", "keyUp"]) {
        const text = type === "keyDown" ? (key === "Enter" ? "\r" : key === " " ? " " : undefined) : undefined;
        await page("Input.dispatchKeyEvent", { type, key, code, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      }
    };
    const screenshot = async (name) => {
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const { cssContentSize } = await page("Page.getLayoutMetrics");
      const width = Math.max(cssContentSize.width, await evaluate("innerWidth"));
      const { data } = await page("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: cssContentSize.height, scale: 1 } });
      writeFileSync(join(output, name), Buffer.from(data, "base64"));
    };
    await viewport(1100, 1200);
    await navigate(resolve(__dirname, "../examples/shipments.report.html"));
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('details'), el => [el.id, el.open])"), [["shipment-1", true], ["shipment-0", false]]);
    for (let i = 0; i < 4; i++) await press("Tab", "Tab", 9);
    assert.equal(await evaluate("document.activeElement.parentElement.id"), "shipment-1");
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "solid");
    await screenshot("packing-keyboard-focus.png");
    await press("Enter", "Enter", 13);
    assert.equal(await evaluate("document.querySelector('#shipment-1').open"), false);
    await press(" ", "Space", 32);
    assert.equal(await evaluate("document.querySelector('#shipment-1').open"), true);
    await press("Tab", "Tab", 9);
    assert.equal(await evaluate("document.activeElement.parentElement.id"), "shipment-0");
    await press(" ", "Space", 32);
    assert.equal(await evaluate("document.querySelector('#shipment-0').open"), true);
    await press("Enter", "Enter", 13);
    assert.equal(await evaluate("document.querySelector('#shipment-0').open"), false);
    const { nodes } = await page("Accessibility.getFullAXTree");
    const controls = nodes.filter((node) => node.role?.value === "DisclosureTriangle");
    assert.equal(controls.length, 2);
    assert.match(controls[0].name.value, /BLOCKED.*SHIP-1002.*Toggle details.*2 issues/);
    assert.match(controls[1].name.value, /READY.*SHIP-1001.*Toggle details.*0 issues/);
    assert.deepEqual(controls.map((node) => node.properties.find(({ name }) => name === "expanded").value.value), [true, false]);
    await evaluate("document.activeElement.blur(); window.scrollTo(0,0)");
    await screenshot("packing-desktop.png");
    await viewport(390, 844);
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    assert.equal(await evaluate("document.querySelector('details').getBoundingClientRect().right < document.documentElement.clientWidth"), true);
    await screenshot("packing-mobile.png");
    const hostile = '<img src=x onerror="globalThis.injected=1"> & </summary><script>globalThis.injected=1</script>';
    const batch = validateBatch([{ id: hostile, order: [{ sku: hostile, quantity: 2 }], parcels: [] }]);
    const hostileFile = join(temporary, "hostile.html");
    writeFileSync(hostileFile, formatHtmlReport(batch));
    await navigate(hostileFile);
    assert.equal(await evaluate("document.querySelectorAll('script,img,iframe,svg,object').length"), 0);
    assert.equal(await evaluate("document.querySelector('.shipment-id').textContent"), hostile);
    assert.equal(await evaluate("document.querySelector('.issue-message').textContent"), batch.shipments[0].errors[0].message);
    assert.equal(await evaluate("globalThis.injected === undefined"), true);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    assert.ok(network.every((url) => url.startsWith("file:")), "No external report requests: " + JSON.stringify(network));
    console.log(JSON.stringify({ browser: version.product, keyboard: "Tab, Enter, Space passed", accessibleControls: controls.map(({ name }) => name.value), responsive: "390px and 1100px passed", hostileText: "literal text, no injected elements or execution", externalRequests: 0, screenshots: output }, null, 2));
  };
  try {
    await Promise.race([verify(), failed]);
  } finally {
    clearTimeout(timer);
    browser.kill();
    await exited;
    rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
