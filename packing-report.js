"use strict";

const { parcelLabel } = require("./parcel-label.js");

// All dynamic data goes into text nodes, never attributes, CSS, or scripts.
const escapeText = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const countLabel = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const quantityLabel = (count, kind) => count === null ? `Unknown ${kind} quantity` : `${parcelLabel(count)} ${kind}`;

function issues(errors) {
  return `<ul class="issues">${errors.map(({ code, path, message }) => `
    <li><p class="issue-code"><code>${escapeText(code)}</code></p>
      <p class="issue-message">${escapeText(message)}</p>
      <p class="issue-path">Input path: <code>${escapeText(path)}</code></p></li>`).join("")}</ul>`;
}

function shipmentCard(shipment, index) {
  const status = shipment.valid ? "ready" : "blocked";
  const id = shipment.shipmentId === null ? `Entry ${index + 1} (missing shipment ID)` : shipment.shipmentId;
  const quantities = `${quantityLabel(shipment.packedQuantity, "packed")} / ${quantityLabel(shipment.expectedQuantity, "ordered")}`;
  const parcels = shipment.parcelCount === null ? "Unknown parcel count" : countLabel(shipment.parcelCount, "parcel");
  return `<details id="shipment-${index}" class="shipment ${status}"${shipment.valid ? "" : " open"}>
  <summary><span class="badge ${status}">${status.toUpperCase()}</span>
    <bdi class="shipment-id">${escapeText(id)}</bdi>
    <span class="quantities">${escapeText(quantities)}; ${escapeText(parcels)}</span>
    <span class="disclosure-label">Toggle details · ${escapeText(countLabel(shipment.errors.length, "issue"))}</span></summary>
  <div class="shipment-body"><p class="entry-label">Input entry ${index + 1} · paths use zero-based indexes</p>
    ${shipment.errors.length ? `<h3>Action needed</h3>${issues(shipment.errors)}` : "<p>No packing issues found. Complete the physical packing, address, and label checks before dispatch.</p>"}
  </div>
</details>`;
}

function formatHtmlReport(batch) {
  const entries = batch.shipments.map((shipment, index) => ({ shipment, index }));
  const ready = entries.filter(({ shipment }) => shipment.valid);
  const blocked = entries.filter(({ shipment }) => !shipment.valid);
  const section = (id, title, entries, empty) => `<section id="${id}" aria-labelledby="${id}-heading">
    <h2 id="${id}-heading">${title} <span class="section-count">${entries.length}</span></h2>
    ${entries.length ? entries.map(({ shipment, index }) => shipmentCard(shipment, index)).join("\n") : `<p class="empty">${empty}</p>`}
  </section>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Shipment packing report</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; color: #172c35; background: #f3f5f4; line-height: 1.5; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 1040px; margin: auto; padding: 48px 24px; }
    a { color: #14596d; text-underline-offset: .2em; }
    :focus-visible { outline: 3px solid #005fcc; outline-offset: 4px; }
    .skip-link { position: absolute; top: 8px; left: 8px; transform: translateY(-200%); background: white; padding: 12px; z-index: 1; }
    .skip-link:focus { transform: none; }
    .eyebrow { font-size: .75rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; color: #49616b; }
    h1 { font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -.04em; line-height: 1.1; margin: 12px 0 20px; }
    h2 { font-size: 1.25rem; margin: 32px 0 14px; }
    h3 { font-size: 1rem; margin: 12px 0; }
    .intro { max-width: 70ch; color: #49616b; }
    .overall { padding: 14px 18px; border-left: 4px solid; border-radius: 4px; font-weight: 650; }
    .ready { --status: #21664a; --wash: #e9f5ee; }
    .blocked { --status: #933b1a; --wash: #fff0e7; }
    .overall, .badge { color: var(--status); background: var(--wash); }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
    .stats > div { background: white; padding: 20px; border: 1px solid #ced8d7; border-radius: 10px; }
    dt { color: #49616b; font-size: .875rem; }
    dd { font-size: 2rem; font-weight: 700; margin: 4px 0 0; }
    nav { display: flex; flex-wrap: wrap; gap: 24px; padding: 8px 0; }
    .section-count { color: #49616b; font-size: .875rem; margin-left: 6px; }
    .shipment { margin: 12px 0; background: white; border: 1px solid #ced8d7; border-left: 4px solid var(--status); border-radius: 8px; }
    summary { padding: 20px; cursor: pointer; overflow-wrap: anywhere; }
    summary::marker { color: var(--status); }
    .badge { display: inline-block; padding: 3px 8px; margin: 0 10px 8px 0; border-radius: 4px; font-size: .75rem; font-weight: 750; letter-spacing: .04em; }
    .shipment-id { font-weight: 700; white-space: pre-wrap; }
    .quantities, .disclosure-label { display: block; margin: 3px 0 0 18px; }
    .quantities { font-size: .9375rem; }
    .disclosure-label { color: #49616b; font-size: .8125rem; text-decoration: underline; text-underline-offset: .2em; }
    .shipment-body { border-top: 1px solid #e0e6e4; padding: 4px 24px 20px; }
    .entry-label, .issue-path, .empty { color: #49616b; font-size: .8125rem; }
    .issues { list-style: none; padding: 0; margin: 0; }
    .issues li { border-left: 2px solid #b75d34; padding: 2px 16px; margin: 18px 0; }
    .issues p { margin: 6px 0; overflow-wrap: anywhere; white-space: pre-wrap; unicode-bidi: plaintext; }
    code { font-family: ui-monospace, monospace; font-size: .8125rem; }
    .issue-code { font-weight: 700; color: #933b1a; }
    footer { border-top: 1px solid #ced8d7; margin-top: 36px; padding-top: 20px; color: #49616b; font-size: .8125rem; }
    @media (max-width: 540px) { main { padding: 24px 16px; } .stats { gap: 8px; } .stats > div { padding: 12px; } summary { padding: 16px; } .shipment-body { padding: 4px 16px 16px; } }
    @media print { :root { background: white; } main { max-width: none; padding: 0; } nav, .skip-link, .disclosure-label { display: none; } details { break-inside: avoid; } }
  </style>
</head>
<body>
<a class="skip-link" href="#shipments">Skip to shipments</a>
<main>
  <header><p class="eyebrow">Fulfillment / packing check</p>
    <h1>Shipment packing report</h1>
    <p class="intro">Compare recorded packing with each order. Resolve blocked shipments, then regenerate this report before dispatch.</p>
    <p class="overall ${batch.valid ? "ready" : "blocked"}">${batch.valid ? "Packing validation passed" : "Needs attention — batch validation failed"}</p>
  </header>
  <dl class="stats" aria-label="Batch totals">
    <div><dt>Total shipments</dt><dd>${entries.length}</dd></div>
    <div><dt>Ready</dt><dd>${ready.length}</dd></div>
    <div><dt>Blocked</dt><dd>${blocked.length}</dd></div>
  </dl>
${entries.length === 0 && batch.errors.length ? `<section aria-labelledby="batch-issues"><h2 id="batch-issues">Batch issues</h2>${issues(batch.errors)}</section>` : ""}
${entries.length === 0 && batch.valid ? "<p>No shipments in this batch.</p>" : ""}
  <div id="shipments">
    <nav aria-label="Shipment status sections"><a href="#blocked">Blocked (${blocked.length})</a><a href="#ready">Ready (${ready.length})</a></nav>
    <p class="entry-label">Blocked details start expanded. Tab to a shipment summary; press Enter or Space to toggle its details.</p>
    ${section("blocked", "Blocked shipments", blocked, "No blocked shipment entries. Check the overall result and any batch issues above.")}
    ${section("ready", "Ready shipments", ready, "No ready shipments.")}
  </div>
  <footer>READY means recorded packing validation passed, not dispatch authorization. Physical packing, address, and label checks are still required. This is a static snapshot; regenerate it after changing the batch. No data is sent or modified by this report.</footer>
</main>
</body>
</html>`;
}

module.exports = { formatHtmlReport };
