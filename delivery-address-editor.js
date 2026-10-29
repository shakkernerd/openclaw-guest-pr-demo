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
      row.querySelector("label").textContent = "Line " + (index + 1);
      row.querySelector("button").setAttribute("aria-label", "Remove line " + (index + 1));
    });
  }

  function appendLine() {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const input = document.createElement("textarea");
    const removeButton = document.createElement("button");
    input.id = "address-line-" + nextLineId++;
    input.rows = 2;
    input.spellcheck = false;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-describedby", "draft-help");
    label.htmlFor = input.id;
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
    row.append(label, input, removeButton);
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
