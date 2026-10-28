"use strict";

// Strict CSV with physical line numbers for actionable validation errors.
function parseCsv(text, source = "CSV") {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let cells = [], field = "", state = "start", touched = false;
  let line = 1, rowLine = 1;
  const fail = (message) => { throw new Error(source + ":" + line + ": " + message); };
  function endRow() {
    // Ignore truly blank physical lines, not comma-only or quoted-empty rows.
    if (touched || cells.length || field) rows.push({ cells: [...cells, field], line: rowLine });
    cells = []; field = ""; state = "start"; touched = false;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] !== "\n") fail("bare CR; use LF or CRLF line endings");
      if (c === "\r") i++;
      if (state === "quoted") field += "\n";
      else endRow();
      line++;
      if (state !== "quoted") rowLine = line;
      continue;
    }
    touched = true;
    if (state === "quoted") {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = "closed";
      } else field += c;
    } else if (c === ",") {
      cells.push(field); field = ""; state = "start";
    } else if (state === "closed") {
      fail("expected comma or newline after closing quote");
    } else if (c === '"') {
      if (state !== "start") fail("quote inside an unquoted field");
      state = "quoted";
    } else {
      field += c; state = "plain";
    }
  }
  if (state === "quoted") fail("unterminated quoted field");
  endRow();
  return rows;
}

function encodeCsv(rows) {
  return rows.map((row) => row.map((value) => {
    const cell = String(value);
    return /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
  }).join(",")).join("\n") + "\n";
}

module.exports = { parseCsv, encodeCsv };
