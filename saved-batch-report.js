"use strict";

// The local file boundary owns accepted data, read generations, and row selection.
// Used by the classic-script viewer; no codec, formatter, or command is loaded.
const SavedBatchReport = (() => {
  const filters = ["all", "success", "failure", "read", "decode", "format"];

  function object(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(label + " must be an object");
    }
  }

  function string(value, label) {
    if (typeof value !== "string") {
      throw new TypeError(label + " must be a string");
    }
  }

  function decode(bytes) {
    let text;
    try {
      // Consume an encoding BOM only; FEFF within parsed strings remains data.
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TypeError("Report must contain valid UTF-8.");
    }
    let report;
    try {
      report = JSON.parse(text);
    } catch {
      throw new SyntaxError("Report must contain one complete JSON document.");
    }
    object(report, "Report");
    for (const field of ["total", "succeeded", "failed"]) {
      if (!Number.isSafeInteger(report[field]) || report[field] < 0) {
        throw new TypeError(field + " must be a safe nonnegative integer");
      }
    }
    if (!Array.isArray(report.results)) {
      throw new TypeError("results must be an array");
    }
    if (report.total !== report.results.length) {
      throw new RangeError("total must equal the number of results");
    }
    let succeeded = 0;
    for (let index = 0; index < report.results.length; index += 1) {
      const result = report.results[index];
      const label = "results[" + index + "]";
      object(result, label);
      if (result.position !== index + 1) {
        throw new RangeError(label + ".position must equal " + (index + 1));
      }
      string(result.file, label + ".file");
      if (typeof result.ok !== "boolean") {
        throw new TypeError(label + ".ok must be a boolean");
      }
      if (result.ok) {
        string(result.formatted, label + ".formatted");
        succeeded += 1;
      } else {
        object(result.error, label + ".error");
        if (!["read", "decode", "format"].includes(result.error.stage)) {
          throw new TypeError(label + ".error.stage must be read, decode, or format");
        }
        string(result.error.name, label + ".error.name");
        string(result.error.message, label + ".error.message");
        Object.freeze(result.error);
      }
      Object.freeze(result);
    }
    if (report.succeeded !== succeeded || report.failed !== report.total - succeeded) {
      throw new RangeError("succeeded and failed must match the result outcomes");
    }
    // Keep unknown fields intact, without interpreting them. Freeze the defined
    // structure; neither filtering nor rendering edits it or revalidates it.
    Object.freeze(report.results);
    return Object.freeze(report);
  }

  return class SavedBatchReport {
    #accepted = null;
    #status = Object.freeze({ kind: "idle", name: null, message: "No file selected." });
    #filter = "all";
    #generation = 0;
    #onChange;

    constructor(onChange) {
      this.#onChange = onChange;
    }

    get accepted() { return this.#accepted; }
    get status() { return this.#status; }
    get filter() { return this.#filter; }

    get rows() {
      if (!this.#accepted) return [];
      const results = this.#accepted.report.results;
      switch (this.#filter) {
        case "all": return results;
        case "success": return results.filter((result) => result.ok);
        case "failure": return results.filter((result) => !result.ok);
        default: return results.filter((result) => !result.ok && result.error.stage === this.#filter);
      }
    }

    setFilter(filter) {
      if (!filters.includes(filter)) throw new TypeError("Unknown report filter");
      this.#filter = filter;
      this.#onChange(this);
    }

    #showStatus(kind, name, message) {
      this.#status = Object.freeze({ kind, name, message });
      this.#onChange(this);
    }

    async selectFile(file) {
      const generation = ++this.#generation;
      if (!file) {
        this.#showStatus("empty", null, "Selection cancelled or empty. No report replaced.");
        return;
      }
      const name = file.name;
      this.#showStatus("reading", name, "Reading selected file. No report replaced yet.");
      let bytes;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        if (generation !== this.#generation) return;
        this.#showStatus("read-error", name, "Could not read selected file. No report replaced.");
        return;
      }
      if (generation !== this.#generation) return;
      let report;
      try {
        report = decode(bytes);
      } catch (error) {
        this.#showStatus("invalid", name, error.message + " No report replaced.");
        return;
      }
      this.#accepted = Object.freeze({ name, byteLength: bytes.byteLength, report });
      this.#showStatus("accepted", name, "Report accepted. Structure checked, not authenticity or current validity.");
    }
  };
})();
