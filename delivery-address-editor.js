"use strict";

(() => {
  const lines = document.getElementById("address-lines");
  const addButton = document.getElementById("add-line");
  const formatButton = document.getElementById("format-address");
  const status = document.getElementById("address-status");
  const output = document.getElementById("formatted-address");
  let nextLineId = 1;

  function invalidate() {
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

  function appendLine() {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const input = document.createElement("textarea");
    const actions = document.createElement("div");
    const upButton = document.createElement("button");
    const downButton = document.createElement("button");
    const removeButton = document.createElement("button");
    input.id = "address-line-" + nextLineId++;
    input.rows = 2;
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
    labelRows();
    return input;
  }

  lines.addEventListener("input", invalidate);
  addButton.addEventListener("click", () => {
    const input = appendLine();
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
})();
