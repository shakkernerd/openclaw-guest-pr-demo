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

  // Pure transaction: finish all validation before returning a replacement.
  // Raw datasets preserve reviews by exact ID; exports restore an exact snapshot.
  function importJSON(text, previous = emptyState()) {
    const value = parseJSON(text);
    if (!Array.isArray(value)) return validateSnapshot(value);
    validateRecords(value);
    return {
      format: FORMAT, version: VERSION, records: value,
      reviews: Object.fromEntries(value.map(({ id }) => [id, own(previous.reviews, id)
        ? { ...previous.reviews[id] } : blankReview()])),
    };
  }

  function updateReview(state, id, patch) {
    if (!own(state.reviews, id)) throw new Error("This record is not in the accepted dataset.");
    const review = { ...state.reviews[id], ...patch };
    if (!DECISIONS.includes(review.decision) || typeof review.notes !== "string") {
      throw new Error("Choose a valid decision and use text for notes.");
    }
    return { ...state, reviews: { ...state.reviews, [id]: { decision: review.decision, notes: review.notes } } };
  }

  // Comparison accepts saved reviews only, never the raw-array import contract.
  function parseSnapshotJSON(text) {
    const value = parseJSON(text);
    if (Array.isArray(value)) throw new Error('Compare needs a saved version 1 "record-review" snapshot, not a records array.');
    return validateSnapshot(value);
  }

  // JSON object member order is irrelevant; array order and types are not.
  function equalJSON(left, right) {
    if (left === right) return true;
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
    FORMAT, VERSION, STORAGE_KEY, DECISIONS, emptyState, importJSON,
    updateReview, parseSnapshotJSON, compareSnapshots, visibleRecords, counts, exportJSON, restore, persist,
  });
});
