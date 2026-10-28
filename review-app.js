/* DOM adapter only; state validation and transitions live in review-state.js. */
(function () {
  "use strict";
  const review = globalThis.RecordReview;
  const $ = id => document.getElementById(id);
  const labels = { unreviewed: "Unreviewed", approved: "Approved", rejected: "Rejected", "follow-up": "Needs follow-up" };
  const getStorage = () => window.localStorage;
  const restored = review.restore(getStorage);
  let state = restored.state || review.emptyState();
  let selectedId = null;
  let importSequence = 0;
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
  }

  function render() {
    const totals = review.counts(state);
    $("count-progress").textContent = totals.reviewed + " / " + totals.total;
    $("review-progress").max = totals.total || 1;
    $("review-progress").value = totals.reviewed;
    for (const decision of ["approved", "rejected", "follow-up"]) $("count-" + decision).textContent = totals[decision];
    const visible = review.visibleRecords(state, $("search").value, $("filter").value);
    if (!visible.some(record => record.id === selectedId)) selectedId = visible[0]?.id ?? null;
    $("list-count").textContent = visible.length + " of " + totals.total + " records";
    const fragment = document.createDocumentFragment();
    for (const record of visible) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "record";
      button.setAttribute("aria-current", String(record.id === selectedId));
      const title = document.createElement("strong");
      title.textContent = record.title;
      const subtitle = document.createElement("small");
      subtitle.textContent = record.id + " · " + labels[state.reviews[record.id].decision];
      button.append(title, subtitle);
      button.addEventListener("click", () => {
        selectedId = record.id;
        render();
        $("record-list").querySelector('[aria-current="true"]').focus({ preventScroll: true });
      });
      item.append(button);
      fragment.append(item);
    }
    $("record-list").replaceChildren(fragment);
    const record = visible.find(record => record.id === selectedId);
    $("record-editor").hidden = !record;
    $("empty").hidden = Boolean(record);
    if (!record) {
      $("empty").querySelector("h2").textContent = totals.total ? "No matching records" : "Your next review starts here";
      $("empty").querySelector("p").textContent = totals.total ? "Try another search or decision filter. Your reviews are still here." : "Import JSON above, or try the sample records.";
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

  function acceptImport(text, source) {
    let next;
    try { next = review.importJSON(text, state); }
    catch (error) { rejectImport(error); return; }
    state = next;
    selectedId = null;
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
    acceptImport($("paste-json").value, "pasted JSON");
  });

  $("file-input").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    const sequence = ++importSequence;
    event.target.value = ""; // allow retrying the same file
    $("activity").textContent = "Reading " + file.name + "…";
    try {
      const text = await file.text();
      // A slow earlier read must never replace a newer import, even a rejected one.
      if (sequence !== importSequence) return;
      acceptImport(text, file.name);
    } catch {
      if (sequence === importSequence) rejectImport(new Error("Could not read that file. Try pasting its JSON instead."));
    }
  });

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
    if (selectedId === null) return;
    const previousId = selectedId;
    state = review.updateReview(state, selectedId, { decision: button.dataset.decision });
    save();
    render();
    $("activity").textContent = previousId + ": " + labels[button.dataset.decision] + (selectedId !== previousId ? ". Moved out of the current filter." : ".");
    if (selectedId !== previousId) $("filter").focus({ preventScroll: true });
  });

  $("notes").addEventListener("input", () => {
    if (selectedId === null) return;
    state = review.updateReview(state, selectedId, { notes: $("notes").value });
    save(); // Don't re-render the editor: preserve caret, focus, and IME input.
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
