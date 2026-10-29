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

  return Object.freeze({ analyzeReturns });
});
