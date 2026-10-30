/* Shared by the offline browser app and Node's built-in tests. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecordReview = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const FORMAT = "record-review";
  const VERSION = 1;
  const STORAGE_KEY = "record-review:v1";
  const DECISIONS = Object.freeze(["unreviewed", "approved", "rejected", "follow-up"]);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const blankReview = () => ({ decision: "unreviewed", notes: "" });
  const emptyState = () => ({ format: FORMAT, version: VERSION, records: [], reviews: {} });

  function validateRecords(records) {
    if (!Array.isArray(records)) throw new Error("Records must be a JSON array.");
    const ids = new Set();
    records.forEach((record, index) => {
      const position = "Record " + (index + 1);
      if (!object(record)) throw new Error(position + " must be an object.");
      if (typeof record.id !== "string" || !record.id.trim()) {
        throw new Error(position + " needs a non-empty string id (convert numeric IDs to strings).");
      }
      if (typeof record.title !== "string" || !record.title.trim()) {
        throw new Error(position + " needs a non-empty string title.");
      }
      if (ids.has(record.id)) throw new Error(position + " repeats id " + JSON.stringify(record.id) + ".");
      ids.add(record.id);
    });
    return ids;
  }

  function validateSnapshot(value) {
    if (!object(value) || value.format !== FORMAT || value.version !== VERSION) {
      throw new Error('Expected a records array or a version 1 "record-review" export.');
    }
    const ids = validateRecords(value.records);
    if (!object(value.reviews)) throw new Error("Export reviews must be an object keyed by record ID.");
    if (Object.keys(value.reviews).length !== ids.size) {
      throw new Error("Export must contain exactly one review for every record.");
    }
    for (const [id, review] of Object.entries(value.reviews)) {
      if (!ids.has(id)) throw new Error("Export contains a review for unknown id " + JSON.stringify(id) + ".");
      if (!object(review) || !DECISIONS.includes(review.decision) || typeof review.notes !== "string") {
        throw new Error("Invalid decision or notes for id " + JSON.stringify(id) + ".");
      }
    }
    return {
      format: FORMAT, version: VERSION, records: value.records,
      reviews: Object.fromEntries(value.records.map(({ id }) => [id, {
        decision: value.reviews[id].decision, notes: value.reviews[id].notes,
      }])),
    };
  }

  function parseJSON(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("Choose a JSON file or paste JSON first.");
    try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch { throw new Error("Invalid JSON. Check commas, quotes, and brackets. Nothing was replaced."); }
  }

  // CSV syntax only: no trimming, type inference, or review metadata. A single
  // leading BOM is ignored; quoted line endings are kept exactly as supplied.
  function parseCSV(text) {
    if (typeof text !== "string") throw new Error("Choose a CSV file or paste CSV first.");
    text = text.replace(/^\uFEFF/, "");
    if (!text.length) throw new Error("CSV needs a header row including id and title.");
    const rows = [];
    let row = [], cell = "", quoted = false, closed = false;
    const endCell = () => { row.push(cell); cell = ""; closed = false; };
    const endRow = () => { endCell(); rows.push(row); row = []; };
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char !== '"') cell += char;
        else if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else if (char === ",") endCell();
      else if (char === "\r" || char === "\n") {
        endRow();
        if (char === "\r" && text[index + 1] === "\n") index++;
      } else if (closed) {
        throw new Error("CSV row " + (rows.length + 1) + ": only a comma or line ending may follow a closing quote.");
      } else if (char === '"') {
        if (cell.length) throw new Error("CSV row " + (rows.length + 1) + ": a quote must start the cell.");
        quoted = true;
      } else cell += char;
    }
    if (quoted) throw new Error("CSV row " + (rows.length + 1) + ": unclosed quoted cell.");
    // One final line ending terminates a row; it does not add a phantom row.
    if (row.length || cell.length || closed) endRow();
    const [headers, ...data] = rows;
    if (headers.some(header => !header.trim())) throw new Error("CSV column names must not be blank.");
    if (new Set(headers).size !== headers.length) throw new Error("CSV column names must be unique (exact, case-sensitive names).");
    if (!headers.includes("id") || !headers.includes("title")) {
      throw new Error("CSV header must include the exact column names id and title.");
    }
    return data.map((cells, index) => {
      if (cells.length !== headers.length) {
        throw new Error("CSV row " + (index + 2) + " has " + cells.length + " cells; expected " + headers.length + ".");
      }
      // Own properties even for __proto__, constructor, etc., just like JSON.
      return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
    });
  }

  // Pure transaction shared by JSON arrays and CSV: validate every record
  // before returning a replacement, preserving reviews only by exact ID.
  function replaceRecords(records, previous) {
    validateRecords(records);
    return {
      format: FORMAT, version: VERSION, records,
      reviews: Object.fromEntries(records.map(({ id }) => [id, own(previous.reviews, id)
        ? { ...previous.reviews[id] } : blankReview()])),
    };
  }

  function importJSON(text, previous = emptyState()) {
    const value = parseJSON(text);
    return Array.isArray(value) ? replaceRecords(value, previous) : validateSnapshot(value);
  }

  function importCSV(text, previous = emptyState()) {
    return replaceRecords(parseCSV(text), previous);
  }

  function updateReview(state, id, patch) {
    if (!own(state.reviews, id)) throw new Error("This record is not in the accepted dataset.");
    const review = { ...state.reviews[id], ...patch };
    if (!DECISIONS.includes(review.decision) || typeof review.notes !== "string") {
      throw new Error("Choose a valid decision and use text for notes.");
    }
    return { ...state, reviews: { ...state.reviews, [id]: { decision: review.decision, notes: review.notes } } };
  }

  // Validate the whole batch before allocating one review-map copy. Notes and
  // records never participate; the change list is transient undo data only.
  function transitionDecisions(state, entries) {
    const ids = new Set();
    const changes = [];
    for (const { id, decision } of entries) {
      if (typeof id !== "string" || !own(state.reviews, id)) {
        throw new Error("This record is not in the accepted dataset.");
      }
      if (ids.has(id)) throw new Error("Choose each record ID only once.");
      if (!DECISIONS.includes(decision)) throw new Error("Choose a valid decision.");
      ids.add(id);
      const before = state.reviews[id].decision;
      if (before !== decision) changes.push({ id, before, after: decision });
    }
    if (!changes.length) return { state, changes };
    const reviews = { ...state.reviews };
    for (const { id, after } of changes) reviews[id] = { ...reviews[id], decision: after };
    return { state: { ...state, reviews }, changes };
  }

  function bulkDecision(state, ids, decision) {
    if (!Array.isArray(ids)) throw new Error("Choose an explicit array of record IDs.");
    if (!DECISIONS.includes(decision)) throw new Error("Choose a valid decision.");
    return transitionDecisions(state, ids.map(id => ({ id, decision })));
  }

  function undoBulkDecision(state, changes) {
    if (!Array.isArray(changes)) throw new Error("Invalid bulk undo.");
    // Defense in depth: stale decision intent must never be overwritten. The
    // adapter also discards this entry on every later decision or replacement.
    for (const change of changes) {
      if (!object(change) || typeof change.id !== "string" || !own(state.reviews, change.id) ||
          !DECISIONS.includes(change.before) || !DECISIONS.includes(change.after) ||
          change.before === change.after || state.reviews[change.id].decision !== change.after) {
        throw new Error("This bulk undo no longer matches the current decisions.");
      }
    }
    return transitionDecisions(state, changes.map(({ id, before }) => ({ id, decision: before })));
  }

  // Comparison and returned reviews share the saved-snapshot contract.
  function parseSnapshotJSON(text, purpose = "Compare") {
    const value = parseJSON(text);
    if (Array.isArray(value)) throw new Error(purpose + ' needs a saved version 1 "record-review" snapshot, not a records array.');
    return validateSnapshot(value);
  }

  // JSON object member order is irrelevant; array order and types are not.
  function equalJSON(left, right) {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every(key => own(right, key) && equalJSON(left[key], right[key]));
  }

  // Pure projection of accepted snapshots. No sorting/mutation or storage; full
  // before/after values remain available, including absent vs null/empty fields.
  function compareSnapshots(current, compared) {
    const currentById = new Map(current.records.map(record => [record.id, record]));
    const comparedById = new Map(compared.records.map(record => [record.id, record]));
    const counts = { current: current.records.length, compared: compared.records.length,
      added: 0, removed: 0, shared: 0, changed: 0, unchanged: 0,
      recordChanged: 0, reviewChanged: 0, decisionChanged: 0, notesChanged: 0 };
    const entries = [];
    const ids = [...currentById.keys(), ...[...comparedById.keys()].filter(id => !currentById.has(id))];
    for (const id of ids) {
      const before = currentById.has(id) ? { record: currentById.get(id), review: current.reviews[id] } : null;
      const after = comparedById.has(id) ? { record: comparedById.get(id), review: compared.reviews[id] } : null;
      if (!before || !after) {
        const kind = before ? "removed" : "added";
        counts[kind]++;
        entries.push({ id, kind, before, after });
        continue;
      }
      counts.shared++;
      const fields = [...Object.keys(before.record), ...Object.keys(after.record).filter(key => !own(before.record, key))]
        .filter(key => !own(before.record, key) || !own(after.record, key) || !equalJSON(before.record[key], after.record[key]));
      const decisionChanged = before.review.decision !== after.review.decision;
      const notesChanged = before.review.notes !== after.review.notes;
      if (!fields.length && !decisionChanged && !notesChanged) { counts.unchanged++; continue; }
      counts.changed++;
      if (fields.length) counts.recordChanged++;
      if (decisionChanged || notesChanged) counts.reviewChanged++;
      if (decisionChanged) counts.decisionChanged++;
      if (notesChanged) counts.notesChanged++;
      entries.push({ id, kind: "changed", before, after, fields, decisionChanged, notesChanged });
    }
    return { counts, entries };
  }

  // A returned snapshot proposes review metadata only. Validate ALL entries
  // before classifying, including reviews on unknown/conflicting records.
  // Use the comparison owner's exact recursive values, never display strings.
  function previewReviewUpdates(current, incoming) {
    const snapshot = validateSnapshot(incoming);
    const currentById = new Map(current.records.map(record => [record.id, record]));
    const counts = { total: snapshot.records.length, eligible: 0, unchanged: 0, unknown: 0, conflict: 0 };
    const entries = snapshot.records.map(record => {
      const before = currentById.has(record.id)
        ? { record: currentById.get(record.id), review: current.reviews[record.id] } : null;
      const after = { record, review: snapshot.reviews[record.id] };
      const kind = !before ? "unknown" : !equalJSON(before.record, record) ? "conflict"
        : equalJSON(before.review, after.review) ? "unchanged" : "eligible";
      counts[kind]++;
      return { id: record.id, kind, before, after };
    });
    return { counts, entries };
  }

  // Read-only three-way plan, not a replacement snapshot or an apply token.
  // Validate/normalize every side before classifying the union of exact IDs.
  function planReviewReconciliation(baseline, current, returned) {
    const snapshots = [baseline, current, returned].map(validateSnapshot);
    const [baseById, currentById, returnedById] = snapshots.map(snapshot =>
      new Map(snapshot.records.map(record => [record.id, { record, review: snapshot.reviews[record.id] }])));
    // Returned order first; absent returns follow current, then baseline order.
    const ids = new Set([...returnedById.keys(), ...currentById.keys(), ...baseById.keys()]);
    const counts = { total: ids.size, proposed: 0, preserved: 0, unchanged: 0,
      converged: 0, conflict: 0, unknown: 0, missing: 0 };
    const entries = [...ids].map(id => {
      const baseline = baseById.get(id) || null;
      const current = currentById.get(id) || null;
      const returned = returnedById.get(id) || null;
      const issues = [];
      if (!baseline) issues.push("unknown-baseline");
      if (!current) issues.push("missing-current");
      if (!returned) issues.push("missing-returned");
      const currentSourceChanged = baseline && current && !equalJSON(baseline.record, current.record);
      const returnedSourceChanged = baseline && returned && !equalJSON(baseline.record, returned.record);
      if (currentSourceChanged) issues.push("current-source-changed");
      if (returnedSourceChanged) issues.push("returned-source-changed");
      let kind;
      if (currentSourceChanged || returnedSourceChanged) kind = "conflict";
      else if (!baseline) kind = "unknown";
      else if (!current || !returned) kind = "missing";
      else {
        const currentChanged = !equalJSON(baseline.review, current.review);
        const returnedChanged = !equalJSON(baseline.review, returned.review);
        if (!currentChanged && !returnedChanged) kind = "unchanged";
        else if (!returnedChanged) kind = "preserved";
        else if (!currentChanged) kind = "proposed";
        else if (equalJSON(current.review, returned.review)) kind = "converged";
        else { kind = "conflict"; issues.push("review-diverged"); }
      }
      counts[kind]++;
      return { id, kind, issues, baseline, current, returned,
        proposed: kind === "proposed" ? { ...returned.review } : null };
    });
    return { kind: "record-review-reconciliation", counts, entries };
  }

  // All working-state transitions are immutable. A preview retains its state
  // identity as a freshness guard, not a candidate state to overwrite from.
  // Revalidate and rederive first, then make one complete review-map copy.
  function applyReviewUpdates(current, incoming, previewState) {
    const preview = previewReviewUpdates(current, incoming);
    if (current !== previewState) return { state: current, preview, stale: true, changed: 0 };
    const changes = preview.entries.filter(entry => entry.kind === "eligible");
    if (!changes.length) return { state: current, preview, stale: false, changed: 0 };
    const reviews = { ...current.reviews };
    for (const { id, after } of changes) reviews[id] = { ...after.review };
    return { state: { ...current, reviews }, preview, stale: false, changed: changes.length };
  }

  // Recovery uses only the actual immutable before/after identities retained by
  // the adapter. Never merge fields or overwrite a newer working-state identity.
  function undoReviewUpdates(current, before, after) {
    return before && after && before !== after && current === after ? before : current;
  }

  function visibleRecords(state, query = "", decision = "all") {
    const needle = query.trim().toLowerCase();
    return state.records.filter(record =>
      (decision === "all" || state.reviews[record.id].decision === decision) &&
      (!needle || (record.id + "\n" + record.title + "\n" + state.reviews[record.id].notes).toLowerCase().includes(needle)));
  }

  function counts(state) {
    const result = Object.fromEntries(DECISIONS.map(decision => [decision, 0]));
    for (const review of Object.values(state.reviews)) result[review.decision]++;
    return { ...result, total: state.records.length, reviewed: state.records.length - result.unreviewed };
  }

  function exportJSON(state) { return JSON.stringify(validateSnapshot(state), null, 2); }

  // Explicit IDs only; selection order and visibility never reorder the records.
  // Reuse the version-1 serializer, including its complete snapshot validation.
  function exportSelectedJSON(state, ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error("Select at least one record to export. Nothing was exported.");
    const selected = new Set(ids);
    const accepted = new Set(state.records.map(record => record.id));
    if (selected.size !== ids.length || ids.some(id => typeof id !== "string" || !accepted.has(id))) {
      throw new Error("Choose each selected record ID exactly once from the working review.");
    }
    const records = state.records.filter(record => selected.has(record.id));
    return exportJSON({ ...state, records,
      reviews: Object.fromEntries(records.map(({ id }) => [id, state.reviews[id]])),
    });
  }

  // The getter itself can throw in an opaque-origin iframe, before getItem runs.
  function restore(getStorage) {
    let text;
    try { text = getStorage().getItem(STORAGE_KEY); }
    catch { return { status: "unavailable", state: null }; }
    if (text === null) return { status: "empty", state: null };
    try { return { status: "restored", state: validateSnapshot(JSON.parse(text)) }; }
    catch { return { status: "invalid", state: null }; }
  }

  function persist(getStorage, state) {
    try {
      getStorage().setItem(STORAGE_KEY, exportJSON(state));
      return true;
    } catch { return false; }
  }

  return Object.freeze({
    FORMAT, VERSION, STORAGE_KEY, DECISIONS, emptyState, importJSON, importCSV,
    updateReview, bulkDecision, undoBulkDecision, parseSnapshotJSON, compareSnapshots, previewReviewUpdates, planReviewReconciliation, applyReviewUpdates, undoReviewUpdates, visibleRecords, counts, exportJSON, exportSelectedJSON, restore, persist,
  });
});
