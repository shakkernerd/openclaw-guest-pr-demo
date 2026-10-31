"use strict";

(() => {
  const input = document.getElementById("report-file");
  const filter = document.getElementById("report-filter");
  const query = document.getElementById("report-query");
  const clearQuery = document.getElementById("clear-query");
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
  const exportButton = document.getElementById("export-report");
  const exportStatus = document.getElementById("export-status");
  const download = document.getElementById("download-report");
  let downloadUrl = null;
  let renderedReport = null;
  let renderedFilter = null;
  let renderedQuery = null;

  function clearExport() {
    if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    download.removeAttribute("href");
    download.hidden = true;
    exportStatus.dataset.state = "idle";
    exportStatus.textContent = "No current export. Choose Export all occurrences CSV to create a snapshot.";
  }

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
    // references are render keys, not another accepted-data or projection owner.
    if (current === renderedReport && viewer.filter === renderedFilter &&
        viewer.query === renderedQuery) return;
    if (current !== renderedReport) {
      clearExport();
      exportButton.disabled = current === null;
    }
    renderedReport = current;
    renderedFilter = viewer.filter;
    renderedQuery = viewer.query;
    filter.value = viewer.filter;
    if (query.value !== viewer.query) query.value = viewer.query;
    clearQuery.disabled = viewer.query === "";
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
      " (" + filter.options[filter.selectedIndex].textContent +
      (viewer.query === "" ? "" : "; search: " + JSON.stringify(viewer.query)) + ").";
    empty.hidden = selected.length !== 0;
    empty.textContent = report.total === 0
      ? "Accepted report is empty: it contains zero results."
      : viewer.query === ""
        ? "No occurrences match this outcome filter. Choose All. The full report totals are unchanged."
        : "No occurrences match this search and outcome filter. Clear the search or choose All. The full report totals are unchanged.";
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
  query.addEventListener("input", () => { viewer.setQuery(query.value); });
  clearQuery.addEventListener("click", () => {
    viewer.setQuery("");
    query.focus();
  });
  exportButton.addEventListener("click", () => {
    if (!viewer.accepted) return;
    clearExport();
    let csv;
    try {
      csv = viewer.toCsv();
    } catch (error) {
      exportStatus.dataset.state = "error";
      exportStatus.textContent = "Could not export: " + error.message + " Accepted report unchanged.";
      return;
    }
    try {
      // No BOM or newline conversion. Keep the URL alive for a normal retry.
      downloadUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8", endings: "transparent" }));
      download.href = downloadUrl;
      download.hidden = false;
      download.click();
      exportStatus.textContent = "CSV snapshot ready: " + viewer.accepted.report.total +
        " occurrences. Download requested; if it did not save, use Download CSV again.";
    } catch {
      clearExport();
      exportStatus.dataset.state = "error";
      exportStatus.textContent = "Download unavailable. Try Export all occurrences CSV again. Accepted report unchanged.";
    }
  });
  window.addEventListener("pagehide", () => {
    clearExport();
    void viewer.selectFile(null);
  });
  render(viewer);
})();
