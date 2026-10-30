"use strict";
// Optional real-Chromium verification. Playwright is test-only, not an app dependency.
// Usage: PLAYWRIGHT_MODULE=/path/to/playwright-core node saved-batch-comparison.browser-check.js
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.BROWSER_ARTIFACT_DIR || mkdtempSync(join(tmpdir(), "saved-comparison-"));
mkdirSync(artifacts, { recursive: true });
const fixture = (name) => join(__dirname, "saved-batch-report-fixtures", name);
const originalPath = fixture("comparison-original.json"), rerunPath = fixture("comparison-rerun.json");
const originalBytes = readFileSync(originalPath), rerunBytes = readFileSync(rerunPath);
const original = JSON.parse(originalBytes);
const report = (rows) => ({ total: rows.length, succeeded: rows.filter((row) => row.ok).length,
  failed: rows.filter((row) => !row.ok).length, results: rows.map((row, i) => ({ ...row, position: i + 1 })) });
const ok = (file, formatted = "") => ({ file, ok: true, formatted });
const bad = (file, message = "bad", stage = "format", name = "Error") => ({ file, ok: false, error: { stage, name, message } });
const upload = (name, value) => ({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
const zero = report([]);
const checks = [];
let browser;
(async () => {
  browser = await chromium.launch({ headless: true,
    env: { ...process.env, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || mkdtempSync(join(tmpdir(), "saved-report-browser-cache-")) },
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1100, height: 1000 } });
  const requests = [], errors = [];
  context.on("request", (request) => requests.push(request.url()));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // Native File reads normally; deterministic fault injection only for named
  // test files. These faults are not claims about native filesystem timing.
  await page.addInitScript(() => {
    const nativeRead = File.prototype.arrayBuffer;
    window.testReads = [];
    window.testPending = [];
    File.prototype.arrayBuffer = function () {
      window.testReads.push(this.name);
      if (this.name === "__read-error__.json") return Promise.reject(new Error("controlled read failure"));
      if (this.name === "__pending__.json") return new Promise((resolve, reject) => window.testPending.push({ resolve, reject }));
      return nativeRead.call(this);
    };
    window.testRevoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { window.testRevoked.push(url); revoke(url); };
  });
  const text = (id) => page.locator("#" + id).textContent();
  const count = () => page.locator("#comparison-rows > li").count();
  async function waitStatus(side, state) {
    await page.waitForFunction(({ side, state }) => document.getElementById(side + "-status").dataset.state === state, { side, state });
  }
  async function load(side, input) {
    await page.locator("#" + side + "-file").setInputFiles(input);
    await waitStatus(side, "accepted");
  }
  async function map(a, b) {
    await page.locator("#map-original").selectOption(String(a));
    await page.locator("#map-rerun").selectOption(String(b));
    await page.getByRole("button", { name: "Add explicit mapping", exact: true }).focus();
    await page.keyboard.press("Enter");
  }
  await page.goto(pathToFileURL(join(__dirname, "saved-batch-comparison.html")).href);
  await page.getByRole("heading", { name: "Compare two saved batch reports", exact: true }).waitFor();
  assert.match(await text("comparison-empty"), /Two accepted reports/);
  assert.equal(await page.locator("#mapping-controls").evaluate((el) => el.disabled), true);
  await load("original", originalPath);
  await load("rerun", rerunPath);
  assert.equal(await count(), 7);
  assert.match(await text("comparison-summary"), /Paired occurrences: 0; Original-only [(]not reverified[)]: 5; Rerun-only: 2/);
  await page.locator("#map-original").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#map-rerun").evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.getByRole("button", { name: "Add explicit mapping", exact: true }).evaluate((el) => el === document.activeElement), true);
  await map(2, 1); await map(4, 2);
  assert.equal(await count(), 5);
  assert.equal(await page.locator("#mapping-list > li").count(), 2);
  assert.match(await text("comparison-summary"), /Paired occurrences: 2; Original-only [(]not reverified[)]: 3; Rerun-only: 0/);
  assert.equal(await page.locator('[data-kind="failure-to-success"]').count(), 2);
  assert.equal(await page.locator('[data-kind="original-only"]').count(), 3);
  const outputs = await page.locator('[data-kind="original-only"] pre[aria-label="Formatted output (read-only)"]').allTextContents();
  assert.deepEqual(outputs, [original.results[0].formatted, original.results[2].formatted, original.results[4].formatted]);
  assert.equal(await page.locator("#comparison-rows").getByText("Correspondence: explicit user mapping.", { exact: true }).count(), 2);
  const suppliedSummary = await text("comparison-summary");
  await page.locator("#results-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "comparison-desktop.png") });
  checks.push("Supplied native file inputs: 0 inferred pairs, then explicit 2→1 and 4→2; two failure→success, three not reverified; duplicate outputs exact.");

  const readsBefore = await page.evaluate(() => window.testReads.length);
  await page.locator("#comparison-filter").selectOption("failure-to-success");
  assert.equal(await count(), 2); assert.equal(await text("comparison-summary"), suppliedSummary);
  await page.locator("#comparison-summary").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(artifacts, "comparison-paired.png") });
  await page.locator("#comparison-filter").selectOption("still-failed");
  assert.equal(await count(), 0); assert.match(await text("comparison-empty"), /No comparison rows match/);
  await page.locator("#comparison-filter").selectOption("all");
  assert.equal(await page.evaluate(() => window.testReads.length), readsBefore);
  await map(1, 1);
  assert.match(await text("mapping-status"), /only one explicit counterpart/);
  assert.equal(await page.locator("#mapping-list > li").count(), 2);
  checks.push("Filters preserve totals and do not reread; conflicting mappings refused atomically; mapping submission exercised with keyboard Enter.");

  for (const side of ["original", "rerun"]) {
    await page.evaluate(() => { window.keptRow = document.querySelector("#comparison-rows > li"); });
    await page.locator("#" + side + "-file").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("invalid") });
    await waitStatus(side, "invalid");
    await page.locator("#" + side + "-file").setInputFiles(upload("__read-error__.json", zero));
    await waitStatus(side, "read-error");
    await page.locator("#" + side + "-file").setInputFiles(upload("__pending__.json", zero));
    await waitStatus(side, "reading");
    assert.equal(await page.locator("#mapping-list > li").count(), 2);
    await page.locator("#" + side + "-file").dispatchEvent("cancel");
    await waitStatus(side, "empty");
    await page.evaluate(() => { window.testPending.shift().resolve(new TextEncoder().encode(JSON.stringify({ total: 0, succeeded: 0, failed: 0, results: [] })).buffer); });
    assert.equal(await text("comparison-summary"), suppliedSummary);
    assert.equal(await page.locator("#mapping-list > li").count(), 2);
    assert.equal(await page.evaluate(() => window.keptRow === document.querySelector("#comparison-rows > li")), true);
    assert.equal(await page.locator("#" + side + "-file").inputValue(), "");
  }
  // A fresh acceptance of the same native file clears mappings, not failures above.
  await load("rerun", rerunPath);
  assert.equal(await page.locator("#mapping-list > li").count(), 0);
  assert.equal(await count(), 7);
  await map(2, 1); await map(4, 2);
  await page.getByRole("button", { name: "Remove mapping original 2 to rerun 1", exact: true }).click();
  assert.equal(await page.locator("#mapping-list > li").count(), 1);
  assert.equal(await page.locator("#map-original").evaluate((el) => el === document.activeElement), true);
  await map(2, 1);
  await load("original", originalPath);
  assert.equal(await page.locator("#mapping-list > li").count(), 0);
  checks.push("Both sides: invalid/read-error/pending/cancel/stale completion retain mappings and row nodes; same-file acceptance on either side clears mappings; explicit removal works.");

  await load("original", upload("duplicates-original.json", report([ok("same", "1"), ok("same", "2")])));
  await load("rerun", upload("duplicates-rerun.json", report([ok("same", "1"), ok("same", "2")])));
  assert.equal(await count(), 4);
  await map(1, 1);
  assert.match(await text("comparison-summary"), /Paired occurrences: 1; Original-only [(]not reverified[)]: 1; Rerun-only: 1/);
  await page.locator("#comparison-filter").selectOption("ambiguous");
  assert.equal(await count(), 2);
  await page.locator("#comparison-filter").selectOption("all");
  const left = [ok("same", ""), ok("changed", "x\r\ny"), bad("still"), bad("error"), bad("fixed"), ok("regression"), ok("Case"), ok("./path")];
  const right = [ok("changed", "x\ny"), ok("same", ""), bad("still"), bad("error", "bad "), ok("fixed"), bad("regression"), ok("case"), ok("path")];
  await load("original", upload("outcomes-original.json", report(left)));
  await load("rerun", upload("outcomes-rerun.json", report(right)));
  assert.equal(await count(), 10);
  for (const kind of ["success-same", "success-changed", "failure-same", "failure-changed", "failure-to-success", "success-to-failure"]) {
    assert.equal(await page.locator('[data-kind="' + kind + '"]').count(), 1);
  }
  const changed = page.locator('[data-kind="success-changed"]');
  assert.deepEqual(await changed.locator('pre[aria-label="Formatted output (read-only)"]').allTextContents(), ["x\r\ny", "x\ny"]);
  assert.match(await changed.textContent(), /Path: same; position: changed/);
  assert.equal(await page.locator("#comparison-rows").getByText("Correspondence: unique exact-path convention, not proof of identity.", { exact: true }).count(), 6);
  await page.locator("#comparison-filter").selectOption("still-failed");
  assert.equal(await count(), 2);
  assert.match(await text("comparison-rows"), /Still failed — changed error/);
  await page.locator("#comparison-filter").selectOption("changed"); assert.equal(await count(), 2);
  await changed.getByText("Escaped string: Formatted output", { exact: true }).first().click();
  assert.equal(await changed.locator("details[open] pre").textContent(), JSON.stringify("x\r\ny"));
  checks.push("Duplicate leftovers stay ambiguous; all six paired categories rendered; changed errors still failed; exact CRLF/LF content; path and position separate; no case/path normalization.");

  const literal = '\uFEFF  e\u0301 😀\r\n"quoted",\t <img src="https://invalid.example/no" onerror="window.injected=true">';
  await load("original", upload("literal-original.json", report([ok("=1+1", literal)])));
  await load("rerun", upload("literal-rerun.json", report([{ ...ok("=1+1", literal), extra: "not displayed" }])));
  await page.locator("#comparison-filter").selectOption("all");
  assert.deepEqual(await page.locator('pre[aria-label="Formatted output (read-only)"]').allTextContents(), [literal, literal]);
  assert.equal(await page.locator("#comparison-rows img, #comparison-rows a").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator('[data-kind="success-same"]').count(), 1);
  checks.push("Literal Unicode/FEFF/CRLF/quotes/formula-like paths retained; HTML-like report content stays text; escaped-string disclosure shows exact line endings; unknown fields ignored.");

  await load("original", upload("empty-original.json", zero));
  await load("rerun", upload("empty-rerun.json", zero));
  assert.match(await text("comparison-empty"), /Both accepted reports contain zero/);
  await load("original", originalPath); await load("rerun", rerunPath); await map(2, 1); await map(4, 2);
  await page.locator("#comparison-filter").selectOption("all");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.locator(".comparison-columns").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length), 1);
  await page.locator("#results-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "comparison-mobile.png") });
  assert.equal(await page.locator("#comparison-summary").getAttribute("aria-live"), "polite");
  checks.push("Empty reports distinct from missing input/no filter matches; 390px layout has one column and no horizontal document overflow; live status attributes present (not screen-reader proof).");

  // Existing single-report viewer: actual downloads, not just URL/status checks.
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(pathToFileURL(join(__dirname, "saved-batch-report.html")).href);
  await page.getByRole("heading", { name: "Saved batch-report viewer", exact: true }).waitFor();
  assert.equal(await page.locator("#export-report").isDisabled(), true);
  await page.locator("#report-file").setInputFiles(originalPath);
  await page.waitForFunction(() => document.querySelector("#read-status").dataset.state === "accepted");
  await page.locator("#report-filter").selectOption("failure");
  async function download(button, name) {
    const pending = page.waitForEvent("download");
    await page.locator(button).click();
    const received = await pending;
    assert.equal(received.suggestedFilename(), "saved-batch-report.csv");
    const path = join(artifacts, name);
    await received.saveAs(path);
    return readFileSync(path);
  }
  const csv = await download("#export-report", "supplied-report.csv");
  const header = '"position","file","status","formatted","error_stage","error_name","error_message"\r\n';
  const q = (value) => '"' + value.replace(/"/g, '""') + '"';
  const expected = header + original.results.map((row) => [String(row.position), row.file, row.ok ? "success" : "failure",
    row.ok ? row.formatted : "", row.ok ? "" : row.error.stage, row.ok ? "" : row.error.name, row.ok ? "" : row.error.message]
    .map(q).join(",")).join("\r\n") + "\r\n";
  assert.deepEqual(csv, Buffer.from(expected));
  assert.equal(await page.locator("#report-rows > li").count(), 2);
  const oldUrl = await page.locator("#download-report").getAttribute("href");
  await page.locator("#report-file").setInputFiles({ name: "invalid", mimeType: "application/json", buffer: Buffer.from("invalid") });
  await page.waitForFunction(() => document.querySelector("#read-status").dataset.state === "invalid");
  await page.locator("#report-file").setInputFiles(upload("__read-error__.json", zero));
  await page.waitForFunction(() => document.querySelector("#read-status").dataset.state === "read-error");
  assert.equal(await page.locator("#download-report").getAttribute("href"), oldUrl);
  assert.deepEqual(await download("#download-report", "retry-report.csv"), csv);
  await page.locator("#report-file").setInputFiles(upload("zero.json", zero));
  await page.waitForFunction(() => document.querySelector("#report-totals").textContent.includes("Total: 0"));
  assert.equal(await page.locator("#download-report").isHidden(), true);
  assert.equal(await page.evaluate((url) => window.testRevoked.includes(url), oldUrl), true);
  assert.deepEqual(await download("#export-report", "empty-report.csv"), Buffer.from(header));
  await page.locator("#report-file").setInputFiles(upload("surrogate.json", report([ok("a", "\ud800")])));
  await page.waitForFunction(() => document.querySelector("#accepted-name").textContent === "surrogate.json");
  await page.locator("#export-report").click();
  assert.match(await text("export-status"), /unpaired UTF-16 surrogate/);
  assert.equal(await page.locator("#download-report").isHidden(), true);
  await page.locator("#report-file").setInputFiles(originalPath);
  await page.waitForFunction(() => document.querySelector("#accepted-name").textContent.includes("comparison-original"));
  await page.evaluate(() => { window.nativeCreateURL = URL.createObjectURL; URL.createObjectURL = () => { throw new Error("controlled download failure"); }; });
  await page.locator("#export-report").click();
  assert.match(await text("export-status"), /Download unavailable/);
  await page.evaluate(() => { URL.createObjectURL = window.nativeCreateURL; });
  assert.deepEqual(await download("#export-report", "recovered-report.csv"), csv);
  checks.push("Single-report CSV actual download bytes: all five occurrences despite failure filter; retry survives invalid/read-failed selection; replacement revokes URL; zero headers; lone-surrogate refusal; download failure/recovery.");

  assert.deepEqual(errors, []);
  const allowed = new Set(["saved-batch-comparison.html", "saved-batch-comparison.css", "saved-batch-comparison.js",
    "saved-batch-comparison-viewer.js", "saved-batch-report.html", "saved-batch-report.css", "saved-batch-report.js", "saved-batch-report-viewer.js"]
    .map((name) => pathToFileURL(join(__dirname, name)).href));
  assert.deepEqual(requests.filter((url) => !allowed.has(url) && !url.startsWith("blob:")), []);
  assert.deepEqual(readFileSync(originalPath), originalBytes);
  assert.deepEqual(readFileSync(rerunPath), rerunBytes);
  const evidence = { browser: await browser.version(), offline: true, suppliedSummary, checks,
    pageErrors: errors, requests: [...new Set(requests)], artifacts: resolve(artifacts) };
  writeFileSync(join(artifacts, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
