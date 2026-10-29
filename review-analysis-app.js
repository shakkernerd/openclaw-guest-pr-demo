/* DOM/file adapter only. Classification and exact proposal policy live in the
   shared analysis owner; accepted results and choices live only in this closure. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 10;
  let workingFile = null;
  let returnedFiles = [];
  let savedFile = null;
  let workflow = "analyze";
  let savedResult = false;
  let revision = 0;
  let report = null;
  let page = 0;
  let busy = false;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function updateAnalyze() {
    $("analyze").disabled = busy || workflow !== "analyze" || !workingFile || !returnedFiles.length;
    $("view-saved").disabled = busy || workflow !== "saved" || !savedFile;
  }

  // Every input change and each Analyze attempt supersedes BOTH pending success
  // and pending failure. Clearing the DOM also releases the prior report values.
  function invalidate(message) {
    revision++;
    busy = false;
    report = null;
    savedResult = false;
    page = 0;
    $("results").hidden = true;
    $("results-heading").textContent = "2. Results";
    $("result-context").textContent = "";
    $("working-summary").textContent = "";
    $("source-results").replaceChildren();
    $("overlap-results").replaceChildren();
    $("overlap-filter").value = "all";
    $("overlap-filter").disabled = true;
    $("previous-page").disabled = true;
    $("next-page").disabled = true;
    $("page-status").textContent = "No report loaded or analysis yet.";
    $("overlap-empty").hidden = true;
    $("overlap-empty").textContent = "";
    $("analysis-error").textContent = "";
    $("analysis-status").textContent = message;
    updateAnalyze();
  }

  function choicesChanged() {
    invalidate(workflow === "saved" ? "Choices changed. View saved report to read the chosen JSON file." :
      "Choices changed. Analyze to read the current files.");
    renderChoices();
  }

  function renderChoices() {
    $("saved-name").textContent = savedFile ? savedFile.name : "None chosen";
    $("clear-saved").disabled = !savedFile;
    $("working-name").textContent = workingFile ? workingFile.name : "None chosen";
    $("clear-working").disabled = !workingFile;
    $("clear-returns").disabled = !returnedFiles.length;
    $("returned-count").textContent = returnedFiles.length + " returned file(s) in source order";
    $("returned-files").replaceChildren(...returnedFiles.map((file, index) => {
      const item = node("li");
      const sourceLabel = node("span", "Source " + (index + 1) + ": " + file.name, "literal");
      sourceLabel.tabIndex = -1; // Neutral focus target when a move reaches its bound.
      item.append(sourceLabel);
      const controls = node("div", undefined, "row");
      for (const [label, delta] of [["Move up", -1], ["Move down", 1], ["Remove", 0]]) {
        const button = node("button", label);
        button.type = "button";
        button.setAttribute("aria-label", label + " returned source " + (index + 1));
        button.disabled = delta === -1 ? index === 0 : delta === 1 ? index === returnedFiles.length - 1 : false;
        button.addEventListener("click", () => {
          if (button.disabled) return;
          const destination = delta ? index + delta : Math.min(index, returnedFiles.length - 2);
          if (delta) [returnedFiles[index], returnedFiles[destination]] = [returnedFiles[destination], returnedFiles[index]];
          else returnedFiles.splice(index, 1);
          choicesChanged();
          // Keep the same action after an interior move/removal. At a move
          // boundary focus the neutral label, never the opposite move action.
          const row = $("returned-files").children[destination];
          const buttons = row ? [...row.querySelectorAll("button")] : [];
          (buttons.find(control => control.textContent === label && !control.disabled) ||
            row?.children[0] || $("returned-input")).focus();
        });
        controls.append(button);
      }
      item.append(controls);
      return item;
    }));
  }

  function renderSources() {
    $("working-summary").textContent = "Working: " + report.working.filename +
      " · " + report.working.recordCount + " records · " + report.sources.length + " returned source(s).";
    $("source-results").replaceChildren(...report.sources.map(source => {
      const item = node("li", undefined, "panel");
      item.append(node("h3", "Source " + source.ordinal + ": " + source.filename, "literal"));
      const c = source.counts;
      item.append(node("p", (savedResult ? "SAVED recorded counts · " : "") +
        "Total: " + c.total + " · Eligible: " + c.eligible + " · Unchanged: " + c.unchanged +
        " · Changed-record conflicts: " + c.conflict + " · Unknown IDs: " + c.unknown, "message"));
      if (!source.issues.length) item.append(node("p", savedResult ? "No issues recorded." : "No issues.", "hint"));
      else {
        const issues = node("ul", undefined, "issues");
        for (const issue of source.issues) {
          const row = node("li");
          row.append(node("span", issue.kind === "conflict" ? "Changed-record conflict: " : "Unknown ID: "),
            node("span", issue.id, "literal"));
          issues.append(row);
        }
        item.append(issues);
      }
      return item;
    }));
  }

  function renderOverlaps() {
    if (!report) return;
    const filter = $("overlap-filter").value;
    const matches = report.overlaps.filter(overlap => filter === "all" || overlap.status === filter);
    const pages = Math.ceil(matches.length / PAGE_SIZE);
    page = Math.max(0, Math.min(page, pages - 1));
    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, matches.length);
    $("page-status").textContent = (savedResult ? "SAVED report · " : "") +
      (matches.length ? "Showing " + (start + 1) + "–" + end : "Showing 0") +
      " of " + matches.length + " matching overlaps · " + report.overlaps.length + " total · Page " +
      (pages ? page + 1 : 0) + " of " + pages + " · Up to " + PAGE_SIZE + " per page";
    $("previous-page").disabled = !matches.length || page === 0;
    $("next-page").disabled = !matches.length || page >= pages - 1;
    $("overlap-empty").hidden = matches.length !== 0;
    $("overlap-empty").textContent = report.overlaps.length ? "No overlaps match this filter." :
      savedResult ? "No overlapping proposals recorded in this saved report." :
        "No overlapping proposals. An overlap needs at least two eligible or unchanged returned proposals for a working record.";
    $("overlap-results").replaceChildren(...matches.slice(start, end).map(overlap => {
      const item = node("li", undefined, "panel");
      item.append(node("h3", "Record ID: " + overlap.id, "literal"),
        node("p", (savedResult ? "SAVED recorded classification: " : "") +
          (overlap.status === "identical" ? "Identical" : "Disagreement") +
          " · " + overlap.proposals.length + " proposals", "message"));
      for (const proposal of overlap.proposals) {
        const section = node("section", undefined, "proposal");
        section.append(node("h4", "Source " + proposal.sourceOrdinal + ": " + proposal.filename, "literal"),
          node("p", "Decision: " + proposal.decision),
          node("p", proposal.notes === "" ? "Notes: empty (0 characters)" : "Notes (exact text):", "hint"),
          node("pre", proposal.notes, "notes literal"));
        // Literal text stays primary. This optional representation makes CR/LF,
        // tabs, trailing spaces and empty strings distinguishable without export.
        const exact = node("details");
        exact.append(node("summary", "Exact note string (JSON escapes)"), node("pre", JSON.stringify(proposal.notes)));
        section.append(exact);
        item.append(section);
      }
      return item;
    }));
  }

  $("workflow").addEventListener("change", () => {
    workflow = $("workflow").value;
    $("analyze-inputs").hidden = workflow !== "analyze";
    $("saved-inputs").hidden = workflow !== "saved";
    choicesChanged();
  });
  $("saved-file").addEventListener("change", () => {
    savedFile = $("saved-file").files[0] || null;
    choicesChanged();
  });
  $("clear-saved").addEventListener("click", () => {
    savedFile = null;
    $("saved-file").value = "";
    choicesChanged();
    $("saved-file").focus();
  });
  $("working-file").addEventListener("change", () => {
    workingFile = $("working-file").files[0] || null;
    choicesChanged();
  });
  $("returned-input").addEventListener("change", () => {
    const files = [...$("returned-input").files];
    if (!files.length) return; // A cancelled add has not changed any choices.
    returnedFiles.push(...files);
    $("returned-input").value = ""; // Allow the same file to be explicitly added again.
    choicesChanged();
  });
  $("clear-working").addEventListener("click", () => {
    workingFile = null;
    $("working-file").value = "";
    choicesChanged();
    $("working-file").focus();
  });
  $("clear-returns").addEventListener("click", () => {
    returnedFiles = [];
    $("returned-input").value = "";
    choicesChanged();
    $("returned-input").focus();
  });
  async function readCurrent() {
    const saved = workflow === "saved";
    if (busy || (saved ? !savedFile : !workingFile || !returnedFiles.length)) return;
    invalidate(saved ? "Reading the chosen saved report…" : "Reading the current files…");
    const attempt = revision;
    const files = saved ? [savedFile] : [workingFile, ...returnedFiles];
    busy = true;
    updateAnalyze();
    try {
      const inputs = await Promise.all(files.map(async file => {
        try { return { filename: file.name, text: await file.text() }; }
        catch (error) { throw new Error("Could not read " + JSON.stringify(file.name) + ": " + error.message); }
      }));
      if (attempt !== revision) return;
      const result = saved ? RecordReturnAnalysis.parseReportJSON(inputs[0].text) :
        RecordReturnAnalysis.analyzeReturns(inputs[0], inputs.slice(1));
      if (attempt !== revision) return;
      report = result;
      savedResult = saved;
      $("results-heading").textContent = saved ? "2. SAVED report data" : "2. Fresh analysis";
      $("result-context").textContent = saved ? "SAVED report file: " + inputs[0].filename +
        "\nCounts, eligibility, issues and classifications are recorded claims from this report, not a fresh comparison or revalidation of original records. Only this report file was read; no named working or returned file was opened." :
        "FRESH analysis of the currently chosen working and returned snapshots. All complete snapshots were validated and compared for this run.";
      renderSources();
      $("overlap-filter").disabled = false;
      renderOverlaps();
      $("results").hidden = false;
      $("analysis-status").textContent = saved ? "SAVED report loaded for the current choice. No original records revalidated. No reviews applied." :
        "Analysis complete for the current choices. No reviews applied.";
    } catch (error) {
      if (attempt !== revision) return;
      $("analysis-error").textContent = error.message;
      $("analysis-status").textContent = (saved ? "Saved report could not be loaded." : "Analysis failed.") +
        " Check the chosen files and try again. No results retained.";
    } finally {
      if (attempt === revision) { busy = false; updateAnalyze(); }
    }
  }
  $("analyze").addEventListener("click", readCurrent);
  $("view-saved").addEventListener("click", readCurrent);
  $("overlap-filter").addEventListener("change", () => { page = 0; renderOverlaps(); });
  $("previous-page").addEventListener("click", () => {
    if (!$("previous-page").disabled) { page--; renderOverlaps(); }
  });
  $("next-page").addEventListener("click", () => {
    if (!$("next-page").disabled) { page++; renderOverlaps(); }
  });
  renderChoices();
  updateAnalyze();
})();
