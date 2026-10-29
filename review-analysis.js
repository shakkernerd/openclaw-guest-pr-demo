/* Pure multi-return analysis, shared by the real CLI and offline page. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./review-state.js"));
  else root.RecordReturnAnalysis = factory(root.RecordReview);
})(typeof globalThis === "object" ? globalThis : this, function (review) {
  "use strict";

  // Adapters supply exact display filenames and whole-file text. The optional
  // purpose retains the CLI's full-path diagnostics. Validate ALL snapshots
  // before aggregation, including unknown/conflicting records and their reviews.
  function analyzeReturns(workingInput, returnedInputs) {
    if (!returnedInputs.length) throw new Error("Choose at least one returned snapshot.");
    const inputs = [workingInput, ...returnedInputs];
    const [working, ...returned] = inputs.map(input =>
      review.parseSnapshotJSON(input.text, input.purpose || "Input " + JSON.stringify(input.filename)));
    const proposalsById = new Map();
    const sources = returned.map((snapshot, index) => {
      const ordinal = index + 1;
      const filename = inputs[ordinal].filename;
      const { counts, entries } = review.previewReviewUpdates(working, snapshot);
      const conflicts = new Set(entries.filter(entry => entry.kind === "conflict").map(entry => entry.id));
      const issues = [
        ...working.records.filter(record => conflicts.has(record.id)).map(({ id }) => ({ id, kind: "conflict" })),
        ...entries.filter(entry => entry.kind === "unknown").map(({ id }) => ({ id, kind: "unknown" })),
      ];
      for (const { id, kind, after } of entries) {
        if (kind !== "eligible" && kind !== "unchanged") continue;
        if (!proposalsById.has(id)) proposalsById.set(id, []);
        proposalsById.get(id).push({ sourceOrdinal: ordinal, filename,
          decision: after.review.decision, notes: after.review.notes });
      }
      return { ordinal, filename, counts, issues };
    });
    const overlaps = working.records.flatMap(({ id }) => {
      const proposals = proposalsById.get(id);
      if (!proposals || proposals.length < 2) return [];
      const identical = proposals.every(proposal =>
        proposal.decision === proposals[0].decision && proposal.notes === proposals[0].notes);
      return [{ id, status: identical ? "identical" : "disagreement", proposals }];
    });
    return { kind: "record-review-return-analysis",
      working: { filename: inputs[0].filename, recordCount: working.records.length },
      sources, overlaps };
  }

  // Saved reports use the producer above’s unversioned JSON shape, not a
  // snapshot. Validate the entire boundary before exposing any result. These
  // are recorded claims: no original records are available to reclassify them.
  function parseReportJSON(text) {
    const fail = (where, message) => { throw new Error("Saved report " + where + ": " + message); };
    const shape = (value, keys, where) => {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).length !== keys.length ||
          !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) {
        fail(where, "expected exactly " + keys.join(", ") + ".");
      }
    };
    const string = (value, where) => {
      if (typeof value !== "string") fail(where, "expected text.");
    };
    const id = (value, where) => {
      string(value, where);
      if (!value.trim()) fail(where, "expected a non-empty record ID.");
    };
    const count = (value, where) => {
      if (!Number.isSafeInteger(value) || value < 0) fail(where, "expected a non-negative integer.");
    };
    const array = (value, where) => {
      if (!Array.isArray(value)) fail(where, "expected an array.");
    };
    if (typeof text !== "string" || !text.trim()) fail("input", "choose a saved analysis JSON file.");
    let value;
    try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch { fail("input", "invalid JSON. Check commas, quotes and brackets."); }
    shape(value, ["kind", "working", "sources", "overlaps"], "root");
    if (value.kind !== "record-review-return-analysis") fail("kind", "expected record-review-return-analysis.");
    shape(value.working, ["filename", "recordCount"], "working");
    string(value.working.filename, "working.filename");
    count(value.working.recordCount, "working.recordCount");
    array(value.sources, "sources");
    if (!value.sources.length) fail("sources", "expected at least one returned source.");
    const sourceIssues = [];
    const workingIds = new Set(), unknownIds = new Set();
    value.sources.forEach((source, index) => {
      const where = "source " + (index + 1);
      shape(source, ["ordinal", "filename", "counts", "issues"], where);
      if (source.ordinal !== index + 1) fail(where, "ordinals must follow source order starting at 1.");
      string(source.filename, where + " filename");
      const c = source.counts;
      const keys = ["total", "eligible", "unchanged", "unknown", "conflict"];
      shape(c, keys, where + " counts");
      keys.forEach(key => count(c[key], where + " counts." + key));
      if (c.total !== c.eligible + c.unchanged + c.unknown + c.conflict ||
          c.total - c.unknown > value.working.recordCount) fail(where, "inconsistent recorded counts.");
      array(source.issues, where + " issues");
      const ids = new Set();
      let conflicts = 0, unknowns = 0;
      source.issues.forEach(issue => {
        shape(issue, ["id", "kind"], where + " issue");
        id(issue.id, where + " issue ID");
        if (ids.has(issue.id)) fail(where, "duplicate issue ID.");
        ids.add(issue.id);
        if (issue.kind === "conflict" && !unknowns) conflicts++;
        else if (issue.kind === "unknown") unknowns++;
        else fail(where, "issues must be conflicts followed by unknown IDs.");
        (issue.kind === "conflict" ? workingIds : unknownIds).add(issue.id);
      });
      if (conflicts !== c.conflict || unknowns !== c.unknown) fail(where, "issue counts do not match recorded counts.");
      sourceIssues.push(ids);
    });
    array(value.overlaps, "overlaps");
    if (value.overlaps.length > value.working.recordCount) fail("overlaps", "exceeds the recorded working count.");
    const overlapIds = new Set();
    const proposalCounts = value.sources.map(() => 0);
    value.overlaps.forEach((overlap, index) => {
      const where = "overlap " + (index + 1);
      shape(overlap, ["id", "status", "proposals"], where);
      id(overlap.id, where + " ID");
      if (overlapIds.has(overlap.id)) fail(where, "duplicate overlap ID.");
      overlapIds.add(overlap.id);
      workingIds.add(overlap.id);
      // Deliberately do not recompute the saved classification.
      if (!["identical", "disagreement"].includes(overlap.status)) fail(where, "unknown recorded status.");
      array(overlap.proposals, where + " proposals");
      if (overlap.proposals.length < 2) fail(where, "expected at least two proposals.");
      let previousOrdinal = 0;
      overlap.proposals.forEach(proposal => {
        shape(proposal, ["sourceOrdinal", "filename", "decision", "notes"], where + " proposal");
        const ordinal = proposal.sourceOrdinal;
        if (!Number.isSafeInteger(ordinal) || ordinal <= previousOrdinal || ordinal > value.sources.length) {
          fail(where, "proposal sources must exist and follow source order without repeats.");
        }
        previousOrdinal = ordinal;
        if (proposal.filename !== value.sources[ordinal - 1].filename) fail(where, "proposal filename differs from its source.");
        if (!review.DECISIONS.includes(proposal.decision)) fail(where, "unknown decision.");
        string(proposal.notes, where + " notes");
        if (sourceIssues[ordinal - 1].has(overlap.id)) fail(where, "an issue cannot also propose from the same source.");
        proposalCounts[ordinal - 1]++;
      });
    });
    proposalCounts.forEach((total, index) => {
      const c = value.sources[index].counts;
      if (total > c.eligible + c.unchanged) fail("source " + (index + 1), "too many overlapping proposals for its recorded counts.");
    });
    // All sources refer to one working snapshot. Check only internal ID claims,
    // not original record equality or the saved identical/disagreement status.
    for (const id of workingIds) {
      if (unknownIds.has(id)) fail("IDs", "a working-record ID cannot also be recorded as unknown.");
    }
    if (workingIds.size > value.working.recordCount) fail("IDs", "known working IDs exceed the recorded working count.");
    // Return the parsed values and array order untouched, including empty notes,
    // whitespace, line endings, duplicate filenames and prototype-like IDs.
    return value;
  }

  return Object.freeze({ analyzeReturns, parseReportJSON });
});
