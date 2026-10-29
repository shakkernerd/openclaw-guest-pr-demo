"use strict";

(() => {
  const input = document.getElementById("report-file");
  const filter = document.getElementById("report-filter");
  const status = document.getElementById("read-status");
  const attempted = document.getElementById("attempted-file");
  const attemptedName = document.getElementById("attempted-name");
  const accepted = document.getElementById("accepted-report");
  const acceptedName = document.getElementById("accepted-name");
  const acceptedSize = document.getElementById("accepted-size");
  const totals = document.getElementById("report-totals");
  const visible = document.getElementById("visible-count");
  const empty = document.getElementById("empty-state");
  const rows = document.getElementById("report-rows");
  let renderedReport = null;
  let renderedFilter = null;

  function literal(element, value) {
    element.textContent = value;
    // An adjacent annotation, not a substitution for an empty parsed value.
    element.nextElementSibling.hidden = value !== "";
  }

  function field(parent, label, value) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    const text = document.createElement("pre");
    text.className = "literal";
    text.tabIndex = 0;
    text.setAttribute("aria-label", label + " (read-only)");
    const annotation = document.createElement("span");
    annotation.className = "empty-value";
    annotation.textContent = "Empty string";
    detail.append(text, annotation);
    literal(text, value);
    parent.append(term, detail);
  }

  function render(viewer) {
    const current = viewer.accepted;
    const latest = viewer.status;
    status.textContent = latest.message + (current
      ? " Displaying the accepted report named below."
      : " No accepted report is displayed.");
    status.dataset.state = latest.kind;
    attempted.hidden = latest.name === null;
    literal(attemptedName, latest.name === null ? "" : latest.name);

    // Status-only changes leave selectable accepted content in place. These
    // references are render keys, not another accepted-data or filter owner.
    if (current === renderedReport && viewer.filter === renderedFilter) return;
    renderedReport = current;
    renderedFilter = viewer.filter;
    filter.value = viewer.filter;
    accepted.hidden = current === null;
    rows.replaceChildren();
    visible.textContent = "Visible occurrences: 0.";
    if (!current) {
      empty.textContent = "No accepted report. Choose a saved report file to begin.";
      empty.hidden = false;
      return;
    }
    literal(acceptedName, current.name);
    acceptedSize.textContent = "Read size: " + current.byteLength + " bytes.";
    const report = current.report;
    totals.textContent = "Full report — Total: " + report.total +
      "; Succeeded: " + report.succeeded + "; Failed: " + report.failed + ".";
    const selected = viewer.rows;
    visible.textContent = "Visible occurrences: " + selected.length + " of " + report.total +
      " (" + filter.options[filter.selectedIndex].textContent + ").";
    empty.hidden = selected.length !== 0;
    empty.textContent = report.total === 0
      ? "Accepted report is empty: it contains zero results."
      : "No occurrences match this filter. The full report totals are unchanged.";
    const fragment = document.createDocumentFragment();
    for (const result of selected) {
      const row = document.createElement("li");
      row.value = result.position;
      const heading = document.createElement("h3");
      heading.textContent = "Occurrence " + result.position + (result.ok ? " — Success" : " — Failure");
      const fields = document.createElement("dl");
      field(fields, "File as supplied", result.file);
      if (result.ok) {
        field(fields, "Formatted output", result.formatted);
      } else {
        field(fields, "Error stage", result.error.stage);
        field(fields, "Error name", result.error.name);
        field(fields, "Error message", result.error.message);
      }
      row.append(heading, fields);
      fragment.append(row);
    }
    rows.append(fragment);
  }

  const viewer = new SavedBatchReport(render);
  input.addEventListener("change", () => {
    const file = input.files[0];
    // Let a later choice of the same file produce a fresh change event.
    input.value = "";
    void viewer.selectFile(file);
  });
  input.addEventListener("cancel", () => { void viewer.selectFile(null); });
  filter.addEventListener("change", () => { viewer.setFilter(filter.value); });
  window.addEventListener("pagehide", () => { void viewer.selectFile(null); });
  render(viewer);
})();
