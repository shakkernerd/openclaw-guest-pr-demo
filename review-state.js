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

  function visibleRecords(state, query = "", decision = "all") {
    const needle = query.trim().toLowerCase();
    return state.records.filter(record =>
      (decision === "all" || state.reviews[record.id].decision === decision) &&
      (!needle || (record.id + "\n" + record.title).toLowerCase().includes(needle)));
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
    updateReview, visibleRecords, counts, exportJSON, restore, persist,
  });
});
