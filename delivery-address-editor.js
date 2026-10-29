"use strict";

(() => {
  const lines = document.getElementById("address-lines");
  const addButton = document.getElementById("add-line");
  const formatButton = document.getElementById("format-address");
  const status = document.getElementById("address-status");
  const output = document.getElementById("formatted-address");
  const importFile = document.getElementById("import-draft");
  const importStatus = document.getElementById("import-status");
  const importPreview = document.getElementById("import-preview");
  const importDecision = document.getElementById("import-decision");
  const replaceButton = document.getElementById("replace-draft");
  const cancelButton = document.getElementById("cancel-import");
  const exportButton = document.getElementById("export-draft");
  const exportStatus = document.getElementById("export-status");
  const exportPreview = document.getElementById("export-preview");
  const download = document.getElementById("download-draft");
  let nextLineId = 1;
  let importGeneration = 0;
  let stagedDraft = null;
  let downloadUrl = null;

  function clearExport() {
    if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    download.removeAttribute("href");
    download.hidden = true;
    exportPreview.value = "";
    exportPreview.hidden = true;
    exportStatus.textContent = "No current export. Choose Export draft JSON to create a snapshot.";
  }

  function invalidate() {
    clearExport();
    output.value = "";
    output.hidden = true;
    status.textContent = "Draft not formatted.";
    status.dataset.state = "draft";
  }

  function labelRows() {
    Array.from(lines.children).forEach((row, index) => {
      const [upButton, downButton, removeButton] = row.querySelectorAll("button");
      row.querySelector("label").textContent = "Line " + (index + 1);
      upButton.setAttribute("aria-label", "Move line " + (index + 1) + " up");
      downButton.setAttribute("aria-label", "Move line " + (index + 1) + " down");
      removeButton.setAttribute("aria-label", "Remove line " + (index + 1));
      upButton.disabled = index === 0;
      downButton.disabled = index === lines.children.length - 1;
    });
  }

  function moveLine(row, offset) {
    const rows = Array.from(lines.children);
    const index = rows.indexOf(row);
    if (!rows[index + offset]) return;
    const input = row.querySelector("textarea");
    const { selectionStart, selectionEnd, selectionDirection } = input;
    // Relocate the existing row, never its text or controls.
    lines.insertBefore(row, offset < 0 ? rows[index - 1] : rows[index + 2] || null);
    labelRows();
    invalidate();
    input.focus();
    input.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
  }

  function appendLine(value = "") {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const input = document.createElement("textarea");
    const actions = document.createElement("div");
    const upButton = document.createElement("button");
    const downButton = document.createElement("button");
    const removeButton = document.createElement("button");
    input.id = "address-line-" + nextLineId++;
    input.rows = 2;
    input.value = value;
    input.spellcheck = false;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-describedby", "draft-help");
    label.htmlFor = input.id;
    actions.className = "actions";
    upButton.type = "button";
    upButton.textContent = "Move up";
    upButton.addEventListener("click", () => moveLine(row, -1));
    downButton.type = "button";
    downButton.textContent = "Move down";
    downButton.addEventListener("click", () => moveLine(row, 1));
    for (const button of [upButton, downButton]) {
      // Cancel the pointer's focus default, not the native disabled semantics.
      button.addEventListener("pointerdown", (event) => {
        if (button.disabled) event.preventDefault();
      });
    }
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      const index = Array.from(lines.children).indexOf(row);
      row.remove();
      labelRows();
      invalidate();
      const neighbor = lines.children[index] || lines.children[index - 1];
      (neighbor ? neighbor.querySelector("textarea") : addButton).focus();
    });
    actions.append(upButton, downButton, removeButton);
    row.append(label, input, actions);
    lines.append(row);
    return input;
  }

  function clearImport() {
    // This editor owns both the generation guard and the staged snapshot.
    // Pending reads need not be abortable: only the current generation may settle.
    importGeneration += 1;
    stagedDraft = null;
    importPreview.value = "";
    importDecision.hidden = true;
    replaceButton.disabled = true;
    cancelButton.disabled = true;
    importFile.value = "";
  }

  importFile.addEventListener("change", async () => {
    const file = importFile.files[0];
    clearImport();
    const generation = importGeneration;
    if (!file) {
      importStatus.textContent = "No file selected. Current draft unchanged.";
      return;
    }
    importStatus.textContent = "Reading selected file. Current draft unchanged.";
    cancelButton.disabled = false;
    try {
      const bytes = await file.arrayBuffer();
      if (generation !== importGeneration) return;
      const snapshot = addressDraftCodec.decode(bytes);
      const preview = addressDraftCodec.encode(snapshot);
      stagedDraft = snapshot;
      importPreview.value = preview;
      importDecision.hidden = false;
      replaceButton.disabled = false;
      importStatus.textContent = "Ready: " + snapshot.length +
        " draft lines. Replace will discard the current draft, including edits made while reading.";
    } catch (error) {
      if (generation !== importGeneration) return;
      importStatus.textContent = "Could not import: " + error.message + ". Current draft unchanged.";
    }
  });
  cancelButton.addEventListener("click", () => {
    clearImport();
    importStatus.textContent = "Import cancelled. Current draft unchanged.";
    importFile.focus();
  });
  replaceButton.addEventListener("click", () => {
    if (stagedDraft === null) return;
    const snapshot = stagedDraft;
    clearImport();
    for (const row of Array.from(lines.children)) row.remove();
    for (const value of snapshot) appendLine(value);
    labelRows();
    invalidate();
    importStatus.textContent = "Draft replaced with " + snapshot.length + " lines. Not formatted.";
    (lines.querySelector("textarea") || addButton).focus();
  });
  exportButton.addEventListener("click", () => {
    clearExport();
    try {
      exportPreview.value = addressDraftCodec.encode(
        Array.from(lines.querySelectorAll("textarea"), (input) => input.value),
      );
      exportPreview.hidden = false;
    } catch (error) {
      exportStatus.textContent = "Could not export: " + error.message;
      return;
    }
    // Keep the URL usable for a normal download/retry until invalidation,
    // another export, or pagehide. Never revoke immediately after clicking.
    try {
      downloadUrl = URL.createObjectURL(new Blob([exportPreview.value], { type: "application/json;charset=utf-8" }));
      download.href = downloadUrl;
      download.hidden = false;
      download.click();
      exportStatus.textContent = "Export snapshot ready. Download requested; if it did not save, use the download link or select the JSON below.";
    } catch {
      if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
      download.removeAttribute("href");
      download.hidden = true;
      exportStatus.textContent = "Download unavailable. Select the read-only JSON below.";
    }
  });
  window.addEventListener("pagehide", () => {
    clearImport();
    importStatus.textContent = "No import staged. Current draft unchanged.";
    clearExport();
  });

  lines.addEventListener("input", invalidate);
  addButton.addEventListener("click", () => {
    const input = appendLine();
    labelRows();
    invalidate();
    input.focus();
  });
  formatButton.addEventListener("click", () => {
    invalidate();
    try {
      output.value = formatDeliveryAddress(
        Array.from(lines.querySelectorAll("textarea"), (input) => input.value),
      );
      output.hidden = false;
      status.textContent = "Address formatted. Plain text is ready to select.";
      status.dataset.state = "success";
    } catch (error) {
      status.textContent = "Could not format: " + error.message;
      status.dataset.state = "error";
    }
  });

  appendLine();
  labelRows();
})();
