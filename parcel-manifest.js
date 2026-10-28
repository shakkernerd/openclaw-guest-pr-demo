"use strict";

const TEXT_FIELDS = ["id", "recipient", "street", "postcode", "destination", "service"];

function isRow(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptySummary() {
  return { byDestination: [], byService: [], byDestinationAndService: [] };
}

function documentError(message) {
  return {
    valid: false,
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    errors: [{ row: null, field: "$", message }],
    summary: emptySummary(),
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

/**
 * Validate a parsed JSON array without changing the input. Row numbers are
 * one-based. Every occurrence of a duplicate, trimmed ID is invalid.
 */
function validateManifest(manifest) {
  if (!Array.isArray(manifest)) {
    return documentError("Expected a JSON array of parcel objects.");
  }

  const idRows = new Map();
  for (let index = 0; index < manifest.length; index += 1) {
    const parcel = manifest[index];
    if (isRow(parcel) && typeof parcel.id === "string" && parcel.id.trim()) {
      const id = parcel.id.trim();
      if (!idRows.has(id)) idRows.set(id, []);
      idRows.get(id).push(index + 1);
    }
  }

  const errors = [];
  const destinations = new Map();
  const services = new Map();
  const routes = new Map();
  let validRows = 0;

  for (let index = 0; index < manifest.length; index += 1) {
    const parcel = manifest[index];
    const row = index + 1;
    const errorCount = errors.length;
    const addError = (field, message) => errors.push({ row, field, message });

    if (!isRow(parcel)) {
      addError("$", "Expected a parcel object, not null, an array, or a primitive.");
      continue;
    }

    const normalized = {};
    for (const field of TEXT_FIELDS) {
      if (typeof parcel[field] !== "string" || !parcel[field].trim()) {
        addError(field, "Required: provide a non-empty string.");
      } else {
        normalized[field] = parcel[field].trim();
      }
    }

    if (normalized.id && idRows.get(normalized.id).length > 1) {
      const rows = idRows.get(normalized.id);
      // Keep one diagnostic per row without repeating an unbounded list in each.
      const sample = rows.slice(0, 10).join(", ");
      const remainder = rows.length > 10 ? ", ... (" + rows.length + " rows total)" : "";
      addError("id", "Duplicate ID in rows " + sample + remainder + "; give each parcel a unique ID.");
    }
    if (normalized.destination && !/^[a-zA-Z]{2}$/.test(normalized.destination)) {
      addError("destination", "Use a two-letter destination country code, for example GB or US.");
    }
    if (!Number.isSafeInteger(parcel.itemCount) || parcel.itemCount <= 0) {
      addError("itemCount", "Required: provide a positive safe integer (1 to 9007199254740991), not a string.");
    }

    if (errors.length !== errorCount) continue;

    validRows += 1;
    const destination = normalized.destination.toUpperCase();
    const service = normalized.service.toLowerCase();
    increment(destinations, destination);
    increment(services, service);
    // A nested Map avoids delimiter collisions and special object keys.
    if (!routes.has(destination)) routes.set(destination, new Map());
    increment(routes.get(destination), service);
  }

  const entries = (counts) => [...counts.entries()].sort(([a], [b]) => compareText(a, b));
  const summary = {
    byDestination: entries(destinations).map(([destination, parcels]) => ({ destination, parcels })),
    byService: entries(services).map(([service, parcels]) => ({ service, parcels })),
    byDestinationAndService: entries(routes).flatMap(([destination, counts]) =>
      entries(counts).map(([service, parcels]) => ({ destination, service, parcels }))),
  };

  return {
    valid: errors.length === 0,
    totalRows: manifest.length,
    validRows,
    invalidRows: manifest.length - validRows,
    errors,
    summary,
  };
}

/** Parse JSON and return the same report shape for syntax and validation errors. */
function parseManifest(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // JSON.parse may echo untrusted input, including terminal escape sequences.
    const message = error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g,
      (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
    return documentError("Invalid JSON: " + message);
  }
  return validateManifest(manifest);
}

module.exports = { validateManifest, parseManifest };
