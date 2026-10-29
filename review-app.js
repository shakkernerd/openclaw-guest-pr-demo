/* DOM adapter only; state validation and transitions live in review-state.js. */
(function () {
  "use strict";
  const review = globalThis.RecordReview;
  const $ = id => document.getElementById(id);
  const labels = { unreviewed: "Unreviewed", approved: "Approved", rejected: "Rejected", "follow-up": "Needs follow-up" };
  const getStorage = () => window.localStorage;
  const restored = review.restore(getStorage);
  let state = restored.state || review.emptyState();
  let editorId = null;
  const selectedIds = new Set();
  let bulkUndo = null;
  let importSequence = 0;
  let comparisonSequence = 0;
  let comparedSnapshot = null;
  let comparedSource = "";
  const decisionButtons = [...document.querySelectorAll("[data-decision]")];
  const memoryWarning = "Memory only — browser storage is blocked or full. Embedded Files previews may deny storage. Export before closing or reloading; an older saved copy may otherwise return.";

  function storageMessage(text, saved = false) {
    $("storage-status").textContent = text;
    $("storage-status").classList.toggle("saved", saved);
  }

  function updateExport() { $("export-json").value = review.exportJSON(state); }

  function save() {
    const saved = review.persist(getStorage, state);
    storageMessage(saved ? "Saved in this browser — records, decisions, and notes will restore here when storage is available. Keep an export as a backup." : memoryWarning, saved);
    if ($("export-panel").open) updateExport();
    if (comparedSnapshot) renderComparison();
  }

  function comparisonText(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function renderComparison() {
    const { counts, entries } = review.compareSnapshots(state, comparedSnapshot);
    $("compare-results").hidden = false;
    $("compare-source").textContent = "Compared snapshot: " + comparedSource + ". Current working review updates as you edit; search and filters do not limit this comparison.";
    $("compare-status").textContent = "Current: " + counts.current + " records · Compared: " + counts.compared +
      " · Added: " + counts.added + " · Removed: " + counts.removed +
      " · Shared: " + counts.shared + " (changed: " + counts.changed + ", unchanged: " + counts.unchanged + ").";
    $("compare-breakdown").textContent = "Among shared IDs — record-field changes: " + counts.recordChanged +
      " · Decision/note changes: " + counts.reviewChanged + " (decisions: " + counts.decisionChanged +
      ", notes: " + counts.notesChanged + "). Categories can overlap.";
    $("compare-empty").hidden = entries.length !== 0;
    const list = $("compare-list");
    const expanded = new Set([...list.querySelectorAll("details[open]")].map(node => node.dataset.id));
    list.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement("li");
      const details = document.createElement("details");
      details.dataset.id = entry.id;
      details.open = expanded.has(entry.id);
      const changes = entry.kind === "added" ? "Added in compared snapshot" : entry.kind === "removed"
        ? "Removed in compared snapshot" : [entry.fields.length ? "Record fields changed" : "",
          entry.decisionChanged ? "Decision changed" : "", entry.notesChanged ? "Notes changed" : ""].filter(Boolean).join(" · ");
      details.append(comparisonText("summary", JSON.stringify(entry.id) + " — " + changes));
      if (entry.fields?.length) details.append(comparisonText("p", "Changed record fields: " + entry.fields.map(key => JSON.stringify(key)).join(", ")));
      const sides = document.createElement("div");
      sides.className = "comparison-sides";
      for (const [label, value] of [["Current working review (before)", entry.before], ["Compared snapshot (after)", entry.after]]) {
        const side = document.createElement("section");
        side.setAttribute("aria-label", label);
        side.append(comparisonText("h3", label));
        if (value) {
          side.append(comparisonText("h4", "Record · all fields"), comparisonText("pre", JSON.stringify(value.record, null, 2)),
            comparisonText("h4", "Review · decision and notes"), comparisonText("pre", JSON.stringify(value.review, null, 2)));
        } else side.append(comparisonText("p", "Not present in this review."));
        sides.append(side);
      }
      details.append(sides);
      item.append(details);
      list.append(item);
    }
  }

  function resetComparison() {
    comparedSnapshot = null;
    comparedSource = "";
    $("compare-results").hidden = true;
    $("compare-list").replaceChildren();
    for (const id of ["compare-status", "compare-error", "compare-source", "compare-breakdown"]) $(id).textContent = "";
  }

  function rejectComparison(error) {
    $("compare-error").textContent = error.message + " Comparison cleared; your working review is unchanged.";
    $("compare-status").textContent = "Comparison rejected.";
  }

  function acceptComparison(text, source) {
    try { comparedSnapshot = review.parseSnapshotJSON(text); }
    catch (error) { rejectComparison(error); return; }
    comparedSource = source;
    renderComparison(); // Never render the working editor or write to storage.
  }

  $("compare-open").addEventListener("click", () => {
    $("compare-panel").open = true;
    $("compare-json").focus();
  });
  $("compare-paste").addEventListener("click", () => {
    comparisonSequence++;
    resetComparison();
    acceptComparison($("compare-json").value, "pasted JSON");
  });
  $("compare-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    const sequence = ++comparisonSequence;
    event.target.value = "";
    resetComparison();
    $("compare-status").textContent = "Reading compared snapshot: " + file.name + "…";
    try {
      const text = await file.text();
      if (sequence !== comparisonSequence || !$("compare-panel").open) return;
      acceptComparison(text, file.name);
    } catch {
      if (sequence === comparisonSequence && $("compare-panel").open) rejectComparison(new Error("Could not read that file. Try pasting its JSON instead."));
    }
  });
  function clearComparison() {
    comparisonSequence++; // Closing also invalidates pending success/failure.
    resetComparison();
    $("compare-json").value = "";
    $("compare-file").value = "";
  }
  $("compare-close").addEventListener("click", () => {
    clearComparison();
    $("compare-panel").open = false;
    $("compare-open").focus();
  });
  $("compare-panel").addEventListener("toggle", () => {
    if (!$("compare-panel").open) clearComparison();
  });
  $("compare-toggle").addEventListener("click", () => {
    // Invalidate on activation, before the native close and queued toggle event.
    if ($("compare-panel").open) clearComparison();
  });

  const matchingRecords = () => review.visibleRecords(state, $("search").value, $("filter").value);

  function renderBulkControls(visible) {
    const selectedVisible = visible.filter(record => selectedIds.has(record.id)).length;
    $("bulk-count").textContent = selectedIds.size + " selected · " +
      (selectedIds.size - selectedVisible) + " hidden by current search/filter.";
    $("select-visible").disabled = visible.length === selectedVisible;
    $("clear-selection").disabled = selectedIds.size === 0;
    $("bulk-apply").disabled = selectedIds.size === 0;
    $("bulk-apply").textContent = "Apply to " + selectedIds.size + " selected";
    $("bulk-undo").disabled = !bulkUndo;
    $("bulk-undo").textContent = bulkUndo ? "Undo last bulk action (" + bulkUndo.length + ")" : "Undo last bulk action";
    $("bulk-undo-status").textContent = bulkUndo
      ? "Undo available for " + bulkUndo.length + " changed decisions; later notes are kept."
      : "No bulk undo available.";
  }

  $("select-visible").addEventListener("click", () => {
    // Resolve visibility after note completion, never replace hidden selections.
    const visible = matchingRecords();
    for (const record of visible) selectedIds.add(record.id);
    renderList(visible);
  });
  $("clear-selection").addEventListener("click", () => {
    selectedIds.clear();
    renderList(matchingRecords());
  });
  $("bulk-apply").addEventListener("click", () => {
    if (!selectedIds.size) return;
    const decision = $("bulk-decision").value;
    const result = review.bulkDecision(state, [...selectedIds], decision);
    // Even reasserting the current decision is later intent, not old undo work.
    bulkUndo = result.changes.length ? result.changes : null;
    state = result.state;
    if (result.changes.length) { save(); render(); }
    else renderBulkControls(matchingRecords());
    $("bulk-result").textContent = "Changed " + result.changes.length + " of " + selectedIds.size +
      " selected decisions to " + labels[decision] + "." + (bulkUndo ? " Undo is available." : " No decisions changed; no undo available.");
  });
  $("bulk-undo").addEventListener("click", () => {
    if (!bulkUndo) return;
    const result = review.undoBulkDecision(state, bulkUndo);
    bulkUndo = null;
    state = result.state;
    save();
    render();
    $("bulk-result").textContent = "Restored " + result.changes.length + " decisions. Notes were kept. No bulk undo available.";
  });

  // Reuse matching buttons so a note blur cannot remove a pending click target.
  const listItems = new Map();
  function renderList(visible) {
    const visibleIds = new Set(visible.map(record => record.id));
    for (const [id, item] of listItems) {
      if (!visibleIds.has(id)) { item.remove(); listItems.delete(id); }
    }
    const list = $("record-list");
    $("list-count").textContent = visible.length + " of " + state.records.length + " records";
    visible.forEach((record, index) => {
      let item = listItems.get(record.id);
      if (!item) {
        item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "record";
        button.append(document.createElement("strong"), document.createElement("small"));
        button.addEventListener("click", () => {
          if (editorId === record.id) return; // Blur may remove this current row.
          editorId = record.id;
          render();
          button.focus({ preventScroll: true });
        });
        const select = document.createElement("button");
        select.type = "button";
        select.className = "record-select";
        select.addEventListener("click", () => {
          // Capture the row ID, not its position or the open editor. This still
          // works when note-exit removes this row during click capture.
          if (selectedIds.has(record.id)) selectedIds.delete(record.id);
          else selectedIds.add(record.id);
          renderList(matchingRecords());
          if (!select.isConnected) {
            const target = selectedIds.size ? "clear-selection" : "search";
            $(target).focus({ preventScroll: true });
          }
        });
        item.append(button, select);
        listItems.set(record.id, item);
      }
      const select = item.children[1];
      const selected = selectedIds.has(record.id);
      select.setAttribute("aria-pressed", String(selected));
      select.setAttribute("aria-label", "Select record " + record.id + " for bulk decision");
      select.textContent = selected ? "Selected" : "Select";
      const button = item.firstElementChild;
      button.setAttribute("aria-current", String(record.id === editorId));
      button.querySelector("strong").textContent = record.title;
      button.querySelector("small").textContent = record.id + " · " + labels[state.reviews[record.id].decision];
      if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
    });
    renderBulkControls(visible);
    const outsideResults = editorId !== null && !visibleIds.has(editorId);
    $("selection-status").hidden = !outsideResults;
    $("selection-status").textContent = outsideResults ? editorId + " no longer matches the current search/filter. You are still editing this record." : "";
  }

  function render() {
    const totals = review.counts(state);
    $("count-progress").textContent = totals.reviewed + " / " + totals.total;
    $("review-progress").max = totals.total || 1;
    $("review-progress").value = totals.reviewed;
    for (const decision of ["approved", "rejected", "follow-up"]) $("count-" + decision).textContent = totals[decision];
    const visible = review.visibleRecords(state, $("search").value, $("filter").value);
    if (!visible.some(record => record.id === editorId)) editorId = visible[0]?.id ?? null;
    renderList(visible);
    const record = visible.find(record => record.id === editorId);
    $("record-editor").hidden = !record;
    $("empty").hidden = Boolean(record);
    if (!record) {
      $("empty").querySelector("h2").textContent = totals.total ? "No matching records" : "Your next review starts here";
      $("empty").querySelector("p").textContent = totals.total ? "Try another search or decision filter. Your reviews are still here." : "Import JSON or CSV above, or try the sample records.";
      $("notes").value = "";
      return;
    }
    $("record-id").textContent = record.id;
    $("record-title").textContent = record.title;
    $("record-json").textContent = JSON.stringify(record, null, 2);
    $("notes").value = state.reviews[record.id].notes;
    for (const button of decisionButtons) button.setAttribute("aria-pressed", String(button.dataset.decision === state.reviews[record.id].decision));
  }

  function rejectImport(error) {
    $("import-panel").open = true;
    $("import-error").textContent = error.message + " Your accepted records and reviews are unchanged.";
    $("activity").textContent = "Import rejected. Nothing was replaced.";
  }

  function acceptImport(text, source, format = "json") {
    let next;
    try { next = format === "csv" ? review.importCSV(text, state) : review.importJSON(text, state); }
    catch (error) { rejectImport(error); return; }
    state = next;
    editorId = null;
    selectedIds.clear();
    bulkUndo = null;
    $("bulk-result").textContent = "";
    $("search").value = "";
    $("filter").value = "all";
    $("import-error").textContent = "";
    $("activity").textContent = "Accepted " + state.records.length + " records from " + source + ".";
    $("import-panel").open = false;
    save();
    render();
  }

  $("import-paste").addEventListener("click", () => {
    importSequence++;
    const format = $("paste-format").value;
    acceptImport($("paste-json").value, "pasted " + format.toUpperCase(), format);
  });

  // Explicit controls choose the parser, never the filename/MIME type or text.
  // Both file types, paste, and sample share the same latest-started counter.
  for (const [id, format] of [["file-input", "json"], ["csv-file-input", "csv"]]) {
    $(id).addEventListener("change", async event => {
      const file = event.target.files[0];
      if (!file) return;
      const sequence = ++importSequence;
      event.target.value = ""; // allow retrying the same file
      $("activity").textContent = "Reading " + file.name + "…";
      try {
        const text = await file.text();
        // A slow earlier read must never replace a newer import, even a rejected one.
        if (sequence !== importSequence) return;
        acceptImport(text, file.name, format);
      } catch {
        if (sequence === importSequence) rejectImport(new Error("Could not read that file. Try pasting its contents with the matching format instead."));
      }
    });
  }

  $("sample").addEventListener("click", () => {
    importSequence++;
    acceptImport(JSON.stringify([
      { id: "R-101", title: "Verify delivery address", recipient: "Alex Morgan", address: "12 Orchard Lane", postcode: "Missing", country: "UK" },
      { id: "R-102", title: "Confirm parcel count", expectedItems: 3, packedItems: 3 },
      { id: "R-103", title: "Inspect packaging notes", packaging: "Fragile glassware", note: "Check protective cushioning before dispatch." },
      { id: "R-104", title: "Check label readability", label: "Recipient and destination confirmed", quality: "Clear" },
    ]), "sample data");
  });

  $("search").addEventListener("input", render);
  $("filter").addEventListener("change", render);
  for (const button of decisionButtons) button.addEventListener("click", () => {
    if (editorId === null) return;
    const previousId = editorId;
    state = review.updateReview(state, editorId, { decision: button.dataset.decision });
    bulkUndo = null;
    $("bulk-result").textContent = "";
    save();
    render();
    $("activity").textContent = previousId + ": " + labels[button.dataset.decision] + (editorId !== previousId ? ". Moved out of the current filter." : ".");
    if (editorId !== previousId) $("filter").focus({ preventScroll: true });
  });

  // All click-activated controls share the same note-exit ordering, including
  // native details summaries. Text inputs/selects keep their native focus path.
  const clickControl = event => event.target.closest?.("button:not(:disabled), summary");
  document.addEventListener("pointerdown", event => {
    if (event.isPrimary && event.button === 0 && document.activeElement === $("notes") && clickControl(event)) {
      // Do not blur/reflow before mouse-up, or activate anything on press.
      // Dragging away therefore still cancels the native click.
      event.preventDefault();
    }
  });
  document.addEventListener("click", event => {
    // Hit testing is complete. Finish the note before any action handler or
    // summary default action runs; do not replay clicks or use a timing delay.
    if (document.activeElement === $("notes")) clickControl(event)?.focus({ preventScroll: true });
  }, true);

  $("notes").addEventListener("input", () => {
    if (editorId === null) return;
    state = review.updateReview(state, editorId, { notes: $("notes").value });
    save(); // Don't re-render the editor: preserve caret, focus, and IME input.
  });
  $("notes").addEventListener("blur", () => {
    // Refresh matches only after editing. Keep this editor/ID even if its note
    // no longer matches, so the next edit or decision cannot target another ID.
    renderList(review.visibleRecords(state, $("search").value, $("filter").value));
  });

  function selectExport() {
    updateExport();
    $("export-panel").open = true;
    $("export-json").focus();
    $("export-json").select();
  }
  $("export-open").addEventListener("click", selectExport);
  $("select-export").addEventListener("click", selectExport);
  $("export-panel").addEventListener("toggle", () => { if ($("export-panel").open) updateExport(); });
  $("download").addEventListener("click", () => {
    updateExport();
    let url;
    let link;
    try {
      url = URL.createObjectURL(new Blob([$("export-json").value], { type: "application/json" }));
      link = document.createElement("a");
      link.href = url;
      link.download = "record-review.json";
      document.body.append(link);
      link.click();
      $("download-status").textContent = "Download requested, not confirmed. The embedded Files preview may block it silently. If no file appears, use Select JSON to copy, then Ctrl/Cmd+C and save it in a text file.";
    } catch {
      $("download-status").textContent = "Download is unavailable here. Use Select JSON to copy, then Ctrl/Cmd+C and save it in a text file.";
    } finally {
      if (link) link.remove();
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });

  if (restored.status === "restored") {
    storageMessage("Restored your saved review from this browser. Future changes will be saved here when possible; keep an export as a backup.", true);
    $("import-panel").open = false;
  } else if (restored.status === "empty") {
    storageMessage("No saved review yet. Changes will be saved in this browser when possible; keep an export as a backup.");
  } else if (restored.status === "invalid") {
    storageMessage("Saved data is invalid or from an unsupported version. It has not been overwritten. Import a valid dataset or backup to start again; your next accepted change will replace that saved copy.");
  } else storageMessage(memoryWarning);
  render();
  updateExport();
})();
