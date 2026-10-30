"use strict";

// Inputs are accepted reports from savedBatchReportCodec, never draft files.
const SavedBatchComparison = (() => {
  function pathCounts(report) {
    const counts = new Map();
    for (const row of report.results) counts.set(row.file, (counts.get(row.file) || 0) + 1);
    return counts;
  }

  function compare(original, rerun, mappings = []) {
    const originalCounts = pathCounts(original);
    const rerunCounts = pathCounts(rerun);
    const pairs = new Map();
    const usedRerun = new Set();
    // Explicit mappings take priority. Reject the entire request, not just a
    // conflicting entry; an occurrence may be used at most once on either side.
    for (const mapping of mappings) {
      const { originalPosition, rerunPosition } = mapping;
      if (!Number.isSafeInteger(originalPosition) || originalPosition < 1 || originalPosition > original.total ||
          !Number.isSafeInteger(rerunPosition) || rerunPosition < 1 || rerunPosition > rerun.total) {
        throw new RangeError("Mapping positions must identify an occurrence in each accepted report.");
      }
      if (pairs.has(originalPosition) || usedRerun.has(rerunPosition)) {
        throw new RangeError("Each occurrence may have only one explicit counterpart. Remove the conflicting mapping first.");
      }
      pairs.set(originalPosition, { rerunPosition, basis: "explicit" });
      usedRerun.add(rerunPosition);
    }
    const uniqueRerun = new Map(rerun.results.filter((row) => rerunCounts.get(row.file) === 1)
      .map((row) => [row.file, row.position]));
    for (const row of original.results) {
      const position = uniqueRerun.get(row.file);
      // Counts are from FULL reports, not remaining/unmapped or filtered rows.
      if (!pairs.has(row.position) && originalCounts.get(row.file) === 1 &&
          position !== undefined && !usedRerun.has(position)) {
        pairs.set(row.position, { rerunPosition: position, basis: "unique-exact-path" });
        usedRerun.add(position);
      }
    }
    const duplicatePath = (row) => (originalCounts.get(row.file) || 0) > 1 || (rerunCounts.get(row.file) || 0) > 1;
    const rows = [];
    for (const before of original.results) {
      const pair = pairs.get(before.position);
      if (!pair) {
        rows.push(Object.freeze({ original: before, rerun: null, basis: null,
          kind: "original-only", ambiguous: duplicatePath(before) }));
        continue;
      }
      const after = rerun.results[pair.rerunPosition - 1];
      let kind;
      if (!before.ok && after.ok) kind = "failure-to-success";
      else if (before.ok && !after.ok) kind = "success-to-failure";
      else if (before.ok) kind = before.formatted === after.formatted ? "success-same" : "success-changed";
      else kind = ["stage", "name", "message"].every((key) => before.error[key] === after.error[key])
        ? "failure-same" : "failure-changed";
      rows.push(Object.freeze({ original: before, rerun: after, basis: pair.basis, kind, ambiguous: false,
        pathChanged: before.file !== after.file, positionChanged: before.position !== after.position }));
    }
    for (const after of rerun.results) {
      if (!usedRerun.has(after.position)) rows.push(Object.freeze({ original: null, rerun: after,
        basis: null, kind: "rerun-only", ambiguous: duplicatePath(after) }));
    }
    const counts = { paired: pairs.size, originalOnly: original.total - pairs.size,
      rerunOnly: rerun.total - pairs.size, ambiguousOccurrences: rows.filter((row) => row.ambiguous).length,
      "failure-to-success": 0, "success-to-failure": 0, "success-same": 0,
      "success-changed": 0, "failure-same": 0, "failure-changed": 0 };
    for (const row of rows) if (row.basis !== null) counts[row.kind] += 1;
    return Object.freeze({ rows: Object.freeze(rows), counts: Object.freeze(counts) });
  }

  return class SavedBatchComparison {
    static compare = compare;
    #original;
    #rerun;
    #acceptedOriginal = null;
    #acceptedRerun = null;
    #mappings = Object.freeze([]);
    #result = null;
    #onChange;
    #revision = 0;

    constructor(onChange = () => {}) {
      this.#onChange = onChange;
      this.#original = new SavedBatchReport(() => this.#changed());
      this.#rerun = new SavedBatchReport(() => this.#changed());
    }

    side(side) {
      if (side === "original") return this.#original;
      if (side === "rerun") return this.#rerun;
      throw new TypeError("Unknown comparison side");
    }
    get mappings() { return this.#mappings; }
    get result() { return this.#result; }
    get revision() { return this.#revision; }

    #compute(mappings) {
      if (!this.#acceptedOriginal || !this.#acceptedRerun) return null;
      return compare(this.#acceptedOriginal.report, this.#acceptedRerun.report, mappings);
    }
    #changed() {
      const original = this.#original.accepted;
      const rerun = this.#rerun.accepted;
      if (original !== this.#acceptedOriginal || rerun !== this.#acceptedRerun) {
        this.#acceptedOriginal = original;
        this.#acceptedRerun = rerun;
        this.#mappings = Object.freeze([]);
        this.#result = this.#compute(this.#mappings);
        this.#revision += 1;
      }
      this.#onChange(this);
    }
    addMapping(originalPosition, rerunPosition) {
      if (!this.#acceptedOriginal || !this.#acceptedRerun) throw new Error("Accept both reports before mapping occurrences.");
      const mappings = Object.freeze([...this.#mappings, Object.freeze({ originalPosition, rerunPosition })]);
      const result = this.#compute(mappings); // Validate before changing any state.
      this.#mappings = mappings;
      this.#result = result;
      this.#onChange(this);
    }
    removeMapping(originalPosition) {
      const mappings = Object.freeze(this.#mappings.filter((mapping) => mapping.originalPosition !== originalPosition));
      const result = this.#compute(mappings);
      this.#mappings = mappings;
      this.#result = result;
      this.#onChange(this);
    }
  };
})();
