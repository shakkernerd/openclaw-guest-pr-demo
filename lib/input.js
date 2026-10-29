"use strict";

const { readFileSync } = require("node:fs");
const { TextDecoder } = require("node:util");
const { ManifestError } = require("./errors.js");
const { parseJsonInput } = require("./json-input.js");

function readJsonFile(filePath) {
  let contents;
  try {
    contents = readFileSync(filePath);
  } catch (error) {
    throw new ManifestError("INPUT_READ_FAILED", "Cannot read " + JSON.stringify(filePath) + " (" + (error.code || "read error") + ").");
  }
  try {
    // Reject corrupt bytes instead of silently replacing characters in a label.
    // TextDecoder also accepts and removes a leading UTF-8 BOM.
    return parseJsonInput(new TextDecoder("utf-8", { fatal: true }).decode(contents), filePath);
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    // Do not echo file contents: orders may contain private delivery details.
    throw new ManifestError("INVALID_JSON", JSON.stringify(filePath) + " is not valid UTF-8 JSON. Use double-quoted keys and strings, with no comments or trailing commas.");
  }
}

module.exports = { readJsonFile };
