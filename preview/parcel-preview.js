"use strict";

function validateDraft(identifier, countText) {
  const name = identifier.trim();
  const digits = countText.trim();
  const count = Number(digits);
  const errors = {
    identifier: name ? "" : "Enter a parcel identifier or name.",
    count: !/^[0-9]+$/.test(digits)
      ? "Enter a non-negative whole number using digits only (0 is valid)."
      : !Number.isSafeInteger(count)
        ? "Use a count no larger than 9007199254740991."
        : "",
  };
  return {
    errors,
    value: errors.identifier || errors.count ? null : { identifier: name, count },
  };
}

function mountPreview(document, parcelLabel) {
  const get = (id) => document.getElementById(id);
  const form = get("parcel-form");
  const identifier = get("parcel-identifier");
  const count = get("parcel-count");
  const preview = get("label-preview");
  const previewStatus = get("preview-status");
  const sheet = get("label-sheet");
  const status = get("action-status");
  const clearSheet = get("clear-sheet");

  function createLabel(value) {
    const label = document.createElement("article");
    label.className = "parcel-label";
    const name = document.createElement("h3");
    name.className = "parcel-name";
    name.textContent = value.identifier;
    const items = document.createElement("p");
    items.className = "parcel-items";
    items.textContent = parcelLabel(value.count);
    label.append(name, items);
    return label;
  }

  function renderDraft(showErrors) {
    const draft = validateDraft(identifier.value, count.value);
    for (const [field, input] of [["identifier", identifier], ["count", count]]) {
      const error = showErrors ? draft.errors[field] : "";
      get(`${field}-error`).textContent = error;
      input.setAttribute("aria-invalid", error ? "true" : "false");
    }
    // Always discard the previous preview, including when the new draft fails.
    preview.replaceChildren();
    if (draft.value) {
      preview.append(createLabel(draft.value));
      previewStatus.textContent = "Ready to add to your sheet.";
    } else {
      previewStatus.textContent = showErrors
        ? "Fix the marked fields to preview a label."
        : "Enter a parcel and item count to preview a label.";
    }
    return draft;
  }

  function updateSheet() {
    const size = sheet.children.length;
    get("sheet-count").textContent = `${size} ${size === 1 ? "label" : "labels"}`;
    get("sheet-empty").hidden = size > 0;
    clearSheet.disabled = size === 0;
  }

  form.addEventListener("input", () => {
    status.textContent = "";
    renderDraft(true);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = renderDraft(true);
    if (!draft.value) {
      status.textContent = "Label not added. Fix the marked fields; your sheet is unchanged.";
      (draft.errors.identifier ? identifier : count).focus();
      return;
    }
    // Accepted labels are independent text-only snapshots, never draft references.
    sheet.append(createLabel(draft.value));
    updateSheet();
    status.textContent = `Label added. ${get("sheet-count").textContent} on your sheet.`;
  });

  form.addEventListener("reset", (event) => {
    event.preventDefault();
    identifier.value = "";
    count.value = "";
    renderDraft(false);
    status.textContent = "Form reset. Your sheet is unchanged.";
    identifier.focus();
  });

  clearSheet.addEventListener("click", () => {
    sheet.replaceChildren();
    updateSheet();
    status.textContent = "Sheet cleared. Your draft is unchanged.";
    // Move focus off the now-disabled Clear sheet button.
    identifier.focus();
  });

  renderDraft(false);
  updateSheet();
}

module.exports = { validateDraft, mountPreview };
