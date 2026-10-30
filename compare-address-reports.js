"use strict";

const { readFileSync } = require("node:fs");
const { savedBatchReportCodec } = require("./saved-batch-report.js");
const { compare } = require("./saved-batch-comparison.js");

function readReport(side, file) {
  let stage = "read";
  try {
    const bytes = readFileSync(file);
    stage = "decode";
    return savedBatchReportCodec.decode(bytes);
  } catch (error) {
    process.stderr.write(side + " report " + JSON.stringify(file) + " (" + stage + "): " +
      error.name + ": " + error.message + "\n");
    process.exitCode = 1;
    return null;
  }
}

function decodeMappings(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new TypeError("Mappings must contain valid UTF-8.");
  }
  let mappings;
  try {
    mappings = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SyntaxError("Mappings must contain one complete JSON document.");
  }
  if (!Array.isArray(mappings)) throw new TypeError("Mappings must be an array");
  mappings.forEach((mapping, index) => {
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new TypeError("mappings[" + index + "] must be an object");
    }
  });
  // Position validity and correspondence belong exclusively to compare.
  return mappings;
}

function mappingFailure(file, stage, error) {
  process.stderr.write("mapping file " + JSON.stringify(file) + " (" + stage + "): " +
    error.name + ": " + error.message + "\n");
  process.exitCode = 1;
  return null;
}

function readMappings(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    // Native filesystem errors carry a code; unrelated runtime errors stay native.
    if (typeof error.code !== "string") throw error;
    return mappingFailure(file, "read", error);
  }
  try {
    return decodeMappings(bytes);
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error;
    return mappingFailure(file, "decode", error);
  }
}

function compareReports(original, rerun, mappings, file) {
  try {
    return compare(original, rerun, mappings);
  } catch (error) {
    // Recognize only the unchanged owner's two mapping refusals, not arbitrary
    // RangeErrors (for example a runtime capacity failure). Do not revalidate.
    if (file === undefined || !(error instanceof RangeError) || ![
      "Mapping positions must identify an occurrence in each accepted report.",
      "Each occurrence may have only one explicit counterpart. Remove the conflicting mapping first.",
    ].includes(error.message)) throw error;
    return mappingFailure(file, "compare", error);
  }
}

const files = process.argv.slice(2);
if (files.length !== 2 && !(files.length === 4 && files[2] === "--mappings")) {
  process.stderr.write("Usage: node compare-address-reports.js ORIGINAL RERUN [--mappings MAPPING_FILE]\n");
  process.exitCode = 2;
} else {
  // Finish original read/decode before touching rerun; stop at the first failure.
  const original = readReport("original", files[0]);
  if (original) {
    const rerun = readReport("rerun", files[1]);
    if (rerun) {
      const mappings = files.length === 4 ? readMappings(files[3]) : [];
      if (mappings !== null) {
        const result = compareReports(original, rerun, mappings, files[3]);
        if (result !== null) {
          // Serialization and output errors must not become input diagnostics.
          process.stdout.write(JSON.stringify(result) + "\n");
          process.exitCode = 0;
        }
      }
    }
  }
}
