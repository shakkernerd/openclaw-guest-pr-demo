"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const labels = {
    "failure-to-success": "Recorded failure → recorded success",
    "success-to-failure": "Recorded success → recorded failure (regression)",
    "success-same": "Success — same output",
    "success-changed": "Success — changed output",
    "failure-same": "Still failed — same error",
    "failure-changed": "Still failed — changed error",
    "original-only": "Original-only — no established rerun counterpart; not reverified",
    "rerun-only": "Rerun-only — no established original counterpart",
  };
  const acceptedKeys = { original: undefined, rerun: undefined };
  const filter = byId("comparison-filter");
  let renderedResult;
  let renderedFilter;
  let renderedMappings;
  let renderedRevision = 0;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function field(parent, label, value) {
    const text = element("pre", value, "literal");
    text.tabIndex = 0;
    text.setAttribute("aria-label", label + " (read-only)");
    const detail = element("dd");
    detail.append(text);
    if (value === "") detail.append(element("span", "Empty string", "empty-value"));
    const escaped = element("details");
    escaped.append(element("summary", "Escaped string: " + label));
    const encoded = element("pre", JSON.stringify(value), "literal");
    encoded.tabIndex = 0;
    escaped.append(encoded);
    detail.append(escaped);
    parent.append(element("dt", label), detail);
  }
  function showSide(model, side) {
    const viewer = model.side(side);
    const status = byId(side + "-status");
    status.dataset.state = viewer.status.kind;
    status.textContent = viewer.status.message + (viewer.status.name !== null
      ? " Latest selection: " + JSON.stringify(viewer.status.name) + "." : "") +
      (viewer.accepted ? " Using the accepted report below." : " No accepted report.");
    if (acceptedKeys[side] === viewer.accepted) return;
    acceptedKeys[side] = viewer.accepted;
    const container = byId(side + "-accepted");
    container.replaceChildren();
    const select = byId("map-" + side);
    select.replaceChildren(element("option", "Choose an occurrence"));
    select.firstChild.value = "";
    if (!viewer.accepted) return;
    const { name, byteLength, report } = viewer.accepted;
    const fields = element("dl");
    field(fields, "Accepted report name", name);
    container.append(fields, element("p", "Read size: " + byteLength + " bytes."),
      element("p", "Full report — Total: " + report.total + "; Succeeded: " + report.succeeded + "; Failed: " + report.failed + "."));
    for (const row of report.results) {
      const option = element("option", "#" + row.position + " — " + (row.ok ? "Success" : "Failure") + " — " + row.file);
      option.value = String(row.position);
      select.append(option);
    }
  }
  function occurrence(result, side) {
    const section = element("section");
    section.append(element("h4", side + (result ? " occurrence #" + result.position : " — no counterpart")));
    if (!result) return section;
    section.append(element("p", result.ok ? "Recorded success" : "Recorded failure"));
    const fields = element("dl");
    field(fields, "File as supplied", result.file);
    if (result.ok) field(fields, "Formatted output", result.formatted);
    else {
      field(fields, "Error stage", result.error.stage);
      field(fields, "Error name", result.error.name);
      field(fields, "Error message", result.error.message);
    }
    section.append(fields);
    return section;
  }
  function selected(row, value) {
    if (value === "all") return true;
    if (value === "ambiguous") return row.ambiguous;
    if (value === "still-failed") return row.kind === "failure-same" || row.kind === "failure-changed";
    if (value === "changed") return row.kind === "success-changed" || row.kind === "failure-changed";
    return row.kind === value;
  }
  function render(model) {
    showSide(model, "original");
    showSide(model, "rerun");
    if (renderedRevision !== model.revision) {
      byId("mapping-status").dataset.state = "idle";
      byId("mapping-status").textContent = "Accepted report changed. Explicit mappings cleared; exact-path conventions recalculated when both sides are accepted.";
      // Both selections belong to the accepted pair, even if just one side changed.
      byId("map-original").value = "";
      byId("map-rerun").value = "";
      renderedRevision = model.revision;
    }
    byId("mapping-controls").disabled = model.result === null;
    if (renderedMappings !== model.mappings) {
      renderedMappings = model.mappings;
      const list = byId("mapping-list");
      list.replaceChildren();
      for (const mapping of model.mappings) {
        const item = element("li", "Explicit: original #" + mapping.originalPosition + " → rerun #" + mapping.rerunPosition);
        const remove = element("button", "Remove mapping");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove mapping original " + mapping.originalPosition + " to rerun " + mapping.rerunPosition);
        remove.addEventListener("click", () => {
          model.removeMapping(mapping.originalPosition);
          byId("mapping-status").dataset.state = "idle";
          byId("mapping-status").textContent = "Mapping removed. Exact-path conventions recalculated.";
          byId("map-original").focus();
        });
        item.append(remove);
        list.append(item);
      }
    }
    // Read-status updates preserve comparison row nodes, focus and selection.
    if (renderedResult === model.result && renderedFilter === filter.value) return;
    renderedResult = model.result;
    renderedFilter = filter.value;
    const rows = byId("comparison-rows");
    const empty = byId("comparison-empty");
    const outcomes = byId("outcome-counts");
    rows.replaceChildren();
    outcomes.replaceChildren();
    if (!model.result) {
      byId("comparison-summary").textContent = "Accept an original and a rerun report to compare.";
      byId("comparison-visible").textContent = "Visible comparison rows: 0.";
      empty.textContent = "Two accepted reports are required. No comparison yet.";
      empty.hidden = false;
      return;
    }
    const { counts } = model.result;
    byId("comparison-summary").textContent = "Paired occurrences: " + counts.paired +
      "; Original-only (not reverified): " + counts.originalOnly + "; Rerun-only: " + counts.rerunOnly +
      ". Ambiguous duplicate occurrences among unpaired rows: " + counts.ambiguousOccurrences + ".";
    for (const key of Object.keys(labels).slice(0, 6)) outcomes.append(element("li", labels[key] + ": " + counts[key]));
    const visibleRows = model.result.rows.filter((row) => selected(row, filter.value));
    byId("comparison-visible").textContent = "Visible comparison rows: " + visibleRows.length + " of " + model.result.rows.length +
      ". A pair occupies one row; every unpaired occurrence occupies its own row. Filters do not change totals or matching.";
    empty.hidden = visibleRows.length !== 0;
    empty.textContent = model.result.rows.length === 0
      ? "Both accepted reports contain zero occurrences."
      : "No comparison rows match this filter. Full comparison counts are unchanged.";
    const fragment = document.createDocumentFragment();
    for (const row of visibleRows) {
      const item = element("li");
      item.dataset.kind = row.kind;
      item.append(element("h3", labels[row.kind]));
      if (row.basis) {
        item.append(element("p", row.basis === "explicit" ? "Correspondence: explicit user mapping."
          : "Correspondence: unique exact-path convention, not proof of identity."));
        item.append(element("p", "Path: " + (row.pathChanged ? "changed" : "same") + "; position: " +
          (row.positionChanged ? "changed" : "same") + ". Separate from outcome/content comparison."));
      } else if (row.ambiguous) item.append(element("p", "Ambiguous duplicate-path group: no automatic occurrence pairing. Explicit mapping required."));
      const columns = element("div", undefined, "comparison-columns");
      columns.append(occurrence(row.original, "Original"), occurrence(row.rerun, "Rerun"));
      item.append(columns);
      fragment.append(item);
    }
    rows.append(fragment);
  }

  const comparison = new SavedBatchComparison(render);
  for (const side of ["original", "rerun"]) {
    const input = byId(side + "-file");
    input.addEventListener("change", () => {
      const file = input.files[0];
      input.value = "";
      void comparison.side(side).selectFile(file);
    });
    input.addEventListener("cancel", () => { void comparison.side(side).selectFile(null); });
  }
  byId("mapping-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const status = byId("mapping-status");
    try {
      comparison.addMapping(Number(byId("map-original").value), Number(byId("map-rerun").value));
      status.dataset.state = "idle";
      status.textContent = "Explicit mapping added. Active explicit mappings: " + comparison.mappings.length + ".";
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = error.message + " Accepted reports and mappings unchanged.";
    }
  });
  filter.addEventListener("change", () => render(comparison));
  window.addEventListener("pagehide", () => {
    void comparison.side("original").selectFile(null);
    void comparison.side("rerun").selectFile(null);
  });
  render(comparison);
})();
