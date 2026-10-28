import { reviewBytes, matchingIndices, issueEvents, issueParcels, issueLabel, exportSelection, MAX_BYTES } from './review.mjs';

const $ = id => document.getElementById(id);
const pageSize = 30;
let review = null, originalBytes = null, originalName = '', loadVersion = 0;
let selected = new Set(), active = null, page = 0;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const filters = () => ({ parcel: $('parcel-filter').value, issue: $('issue-filter').value, query: $('search').value });
function resetFilters() {
  for (const id of ['parcel-filter', 'issue-filter', 'search']) $(id).value = '';
  page = 0;
}
function clearView() {
  review = null; originalBytes = null; originalName = '';
  selected = new Set(); active = null; page = 0;
  resetFilters();
  $('review').hidden = true; $('empty').hidden = false; $('error').hidden = true;
  $('original').hidden = true; $('original').open = false; $('original-text').textContent = '';
  $('totals').replaceChildren(); $('rows').replaceChildren(); $('inspector').replaceChildren();
  $('download').disabled = true;
}
function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = element('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  // Give browsers, including contained previews, time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function loadFile(filePromise, label = 'file') {
  const version = ++loadVersion;
  clearView();
  $('file-status').textContent = 'Reading ' + label + '… No review is available until the whole file passes validation.';
  try {
    const file = await filePromise;
    if (version !== loadVersion) return;
    if (file.size > MAX_BYTES) throw new Error('File exceeds the 5 MiB limit. Nothing was reviewed.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (version !== loadVersion) return;
    originalBytes = bytes; originalName = file.name;
    $('original').hidden = false;
    $('original-meta').textContent = file.name + ' · ' + bytes.byteLength + ' bytes · retained in memory only';
    review = reviewBytes(bytes, file.name);
    $('file-status').textContent = 'Validated ' + file.name + ' · ' + bytes.byteLength + ' bytes · ' + review.report.summary.inputRecords + ' records · complete review';
    $('empty').hidden = true; $('review').hidden = false;
    renderTotals(); renderQueue();
  } catch (error) {
    if (version !== loadVersion) return;
    review = null; selected.clear();
    $('empty').hidden = true;
    $('file-status').textContent = 'Rejected ' + label + '. Previous results and selection have been cleared.';
    $('error-message').textContent = error.message || 'The file could not be read. No partial review is available.';
    $('error').hidden = false;
  }
}

function renderTotals() {
  const labels = { inputRecords: 'Input records', uniqueEvents: 'Unique variants', retryDuplicates: 'Retry duplicates', parcels: 'Parcels', conflictingEventIds: 'Conflicting IDs', contradictoryParcels: 'Contradictory parcels', exceptions: 'Exceptions' };
  $('totals').replaceChildren(...Object.entries(labels).map(([key, label]) => {
    const box = element('div', undefined, 'stat' + (key === 'exceptions' ? ' exception' : ''));
    box.dataset.total = key;
    box.append(element('strong', String(review.report.summary[key])), element('span', label));
    return box;
  }));
}
function updateSelection(matches) {
  const visibleSet = new Set(matches);
  const hidden = [...selected].filter(index => !visibleSet.has(index)).length;
  $('selection-count').textContent = selected.size + ' selected · ' + hidden + ' hidden by filters';
  $('download').textContent = 'Download selected JSON (' + selected.size + ')';
  $('download').disabled = !selected.size;
  $('clear-selection').disabled = !selected.size;
  $('select-matches').disabled = !matches.length;
}
function renderQueue() {
  if (!review) return;
  const matches = matchingIndices(review.report, filters());
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  page = Math.min(page, pages - 1);
  const pageMatches = matches.slice(page * pageSize, (page + 1) * pageSize);
  if (!pageMatches.includes(active)) active = pageMatches[0] ?? null;
  $('match-count').textContent = matches.length + ' of ' + review.report.exceptions.length + ' exceptions match';
  updateSelection(matches);
  const rows = pageMatches.map(index => {
    const issue = review.report.exceptions[index];
    const row = element('tr'); row.dataset.index = index;
    if (index === active) row.className = 'active';
    const checkCell = element('td');
    const check = element('input'); check.type = 'checkbox'; check.checked = selected.has(index);
    check.setAttribute('aria-label', 'Select ' + issueLabel(issue.code) + ': ' + issueParcels(issue).join(', '));
    check.addEventListener('change', () => {
      if (check.checked) selected.add(index); else selected.delete(index);
      updateSelection(matches);
    });
    checkCell.append(check);
    const description = element('td');
    description.append(element('div', issueParcels(issue).join(' / '), 'parcel-names'),
      element('span', issueLabel(issue.code), 'issue-chip' + (issue.code === 'EVENT_ID_CONFLICT' ? '' : ' terminal')));
    if (issue.eventId) description.append(element('div', 'Event ID: ' + issue.eventId, 'small muted'));
    const evidence = element('td');
    const inspect = element('button', 'Inspect →', 'secondary inspect-button'); inspect.type = 'button';
    inspect.setAttribute('aria-label', 'Inspect ' + issueLabel(issue.code) + ': ' + issueParcels(issue).join(', '));
    inspect.setAttribute('aria-pressed', String(index === active));
    inspect.addEventListener('click', () => {
      active = index;
      // Keep the activating button focused; do not recreate the table on inspect.
      for (const candidate of $('rows').children) {
        const isActive = Number(candidate.dataset.index) === active;
        candidate.classList.toggle('active', isActive);
        candidate.querySelector('button').setAttribute('aria-pressed', String(isActive));
      }
      renderInspector();
    });
    const events = issueEvents(issue);
    evidence.append(inspect, element('span', events.length + ' variants · ' + events.reduce((sum, event) => sum + event.sources.length, 0) + ' source records', 'evidence-count'));
    row.append(checkCell, description, evidence);
    return row;
  });
  $('rows').replaceChildren(...rows);
  $('no-matches').hidden = matches.length > 0;
  $('no-matches').textContent = review.report.exceptions.length ? 'No exceptions match these filters. Hidden selections are still selected.' : 'No exceptions detected under the audit rules. This is not shipment authorization.';
  $('page-info').textContent = matches.length ? 'Page ' + (page + 1) + ' of ' + pages + ' · 30 per page' : '0 results';
  $('prev').disabled = page === 0; $('next').disabled = page >= pages - 1;
  renderInspector();
}
function renderEvent(event) {
  const box = element('section', undefined, 'event');
  box.append(element('h3', event.parcelId + ' · ' + event.type, 'event-heading'),
    element('p', 'Event ' + event.eventId, 'event-meta'),
    element('p', 'Normalized instant: ' + event.occurredAt, 'event-meta'));
  if (event.conflictingEventId) box.append(element('p', 'Conflicting ID — all variants retained; no winner.', 'evidence-note'));
  for (const source of event.sources) {
    const details = element('details'); details.open = true;
    details.append(element('summary', 'Original record #' + source.recordIndex + ' · line ' + source.line));
    details.append(element('p', source.filename + ' · bytes [' + source.byteStart + ', ' + source.byteEnd + ')', 'source-label'));
    details.append(element('p', 'Original timestamp: ' + source.occurredAt, 'source-label'));
    const raw = element('pre', source.rawJSON); raw.tabIndex = 0;
    details.append(raw); box.append(details);
  }
  return box;
}
function renderInspector() {
  const inspector = $('inspector'); inspector.replaceChildren();
  if (active === null) {
    inspector.append(element('h3', 'Evidence inspector'), element('p', 'Inspect an exception to see every variant and its original source records.', 'placeholder'));
    return;
  }
  const issue = review.report.exceptions[active];
  const top = element('div', undefined, 'inspector-top');
  top.append(element('span', 'EXCEPTION EVIDENCE', 'eyebrow'), element('span', 'Unresolved · read-only', 'count-badge'));
  inspector.append(top, element('h3', issue.eventId || issue.parcelId, 'inspector-id'), element('p', issueLabel(issue.code), 'muted'));
  inspector.append(element('p', issue.code === 'EVENT_ID_CONFLICT'
    ? 'One event ID has different event evidence. Every variant below is retained, including variants on other parcels. Arrival order and timestamps do not choose a winner.'
    : 'Both delivered and cancelled events exist for this parcel. Neither overrides the other, regardless of time or arrival order.', 'explanation'));
  for (const event of issueEvents(issue)) inspector.append(renderEvent(event));
  const affected = new Set(issueParcels(issue));
  const timeline = element('details'); timeline.append(element('summary', 'Full affected-parcel timelines (including non-exception events)'));
  for (const parcel of review.report.parcels.filter(item => affected.has(item.parcelId))) {
    timeline.append(element('h3', parcel.parcelId));
    timeline.append(element('p', 'Observed terminal evidence: ' + (parcel.terminalEvidence.join(' + ') || 'none') + ' — not a resolved status.', 'small muted'));
    for (const event of parcel.timeline) timeline.append(renderEvent(event));
  }
  inspector.append(timeline);
  const json = element('details'); json.append(element('summary', 'Complete exception JSON (export shape)'));
  const pre = element('pre', JSON.stringify(issue, null, 2)); pre.tabIndex = 0; json.append(pre); inspector.append(json);
}

$('file').addEventListener('change', event => {
  const file = event.target.files[0];
  // Allows selecting the same file again, including after fixing a bad export.
  event.target.value = '';
  if (file) loadFile(Promise.resolve(file), file.name);
});
$('example').addEventListener('click', () => loadFile((async () => {
  const response = await fetch('./example.json');
  if (!response.ok) throw new Error('The local synthetic example could not be read. Choose a file instead.');
  return new File([await response.arrayBuffer()], 'synthetic-example.json', { type: 'application/json' });
})(), 'synthetic example'));
$('reset').addEventListener('click', () => {
  loadVersion++; clearView(); $('file').value = '';
  $('file-status').textContent = 'No file loaded. Your partner export can be added when it is ready.';
});
const dropZone = $('drop-zone');
for (const name of ['dragenter', 'dragover']) dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) dropZone.addEventListener(name, () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  const files = event.dataTransfer.files;
  if (files.length !== 1) { loadFile(Promise.reject(new Error('Choose exactly one events JSON file. Multiple files are not merged.')), 'drop'); return; }
  loadFile(Promise.resolve(files[0]), files[0].name);
});
// Never navigate away if a file is dropped outside the chooser.
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
for (const id of ['parcel-filter', 'issue-filter', 'search']) $(id).addEventListener(id === 'issue-filter' ? 'change' : 'input', () => { page = 0; renderQueue(); });
$('clear-filters').addEventListener('click', () => { resetFilters(); renderQueue(); });
$('select-matches').addEventListener('click', () => {
  if (!review) return;
  matchingIndices(review.report, filters()).forEach(index => selected.add(index)); renderQueue();
});
$('clear-selection').addEventListener('click', () => { selected.clear(); renderQueue(); });
$('prev').addEventListener('click', () => { page--; renderQueue(); });
$('next').addEventListener('click', () => { page++; renderQueue(); });
$('download').addEventListener('click', () => {
  if (review && selected.size) download(exportSelection(review.report, selected), 'selected-exceptions.json', 'application/json');
});
$('download-original').addEventListener('click', () => {
  if (originalBytes) download(originalBytes, 'original-' + originalName, 'application/octet-stream');
});
$('original').addEventListener('toggle', () => {
  if ($('original').open && originalBytes && !$('original-text').textContent) {
    try { $('original-text').textContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes); }
    catch { $('original-text').textContent = 'Invalid UTF-8 cannot be displayed faithfully. Download the original bytes instead.'; }
  }
});
