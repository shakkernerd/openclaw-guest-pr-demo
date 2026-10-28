"use strict";

const { MEANING, isObject, pointer, diagnostic } = require("./common.js");
const KNOWN = {
  status: ["Waiting for evidence", "Needs review"],
  category: ["missing", "excluded", "changed", "ambiguous"],
  version: ["original", "revised"],
  disposition: ["non-completed", "duplicate", "included", "malformed", "cancelled"],
};

/** Validate JSON-compatible data without modifying, coercing, or resolving it. */
function validateExport(input) {
  const diagnostics = [];
  const sources = new Map();
  const decisions = new Map();
  const globalOccurrences = new Map();
  const add = (code, path, message, extra) => diagnostics.push(diagnostic(code, path, message, extra));
  const warn = (code, path, message, extra) => add(code, path, message, { ...extra, severity: "warning" });
  function string(value, path, nonempty = true) {
    if (typeof value !== "string" || (nonempty && value.length === 0)) {
      add("INVALID_TYPE", path, nonempty ? "Expected a nonempty string." : "Expected a string (empty is allowed).");
      return false;
    }
    return true;
  }
  function known(kind) {
    return (value, path) => {
      if (string(value, path) && !KNOWN[kind].includes(value)) {
        warn("UNKNOWN_VALUE", path, "Unobserved " + kind + " value; preserved, not assumed invalid or authorized.");
      }
    };
  }
  function integer(minimum) {
    return (value, path) => {
      if (!Number.isSafeInteger(value) || value < minimum) {
        add("INVALID_INTEGER", path, "Expected a safe integer >= " + minimum + ".");
      }
    };
  }
  function hash(value, path) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      add("INVALID_HASH", path, "Expected 64 lowercase hexadecimal characters; a declaration is not verified evidence.");
    }
  }
  function date(value, path) {
    const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
      add("INVALID_DATE", path, "Expected a real calendar date in YYYY-MM-DD form.");
    }
  }
  function timestamp(value, path) {
    if (value === null) return;
    const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
      add("INVALID_TIMESTAMP", path, "Expected null or a real canonical UTC timestamp with milliseconds.");
    }
  }
  function object(value, path, fields) {
    if (!isObject(value)) { add("INVALID_TYPE", path, "Expected a JSON object."); return false; }
    for (const key of Object.keys(value).sort()) {
      if (!Object.hasOwn(fields, key)) add("UNKNOWN_FIELD", pointer(path, key), "Field is not part of the supported export contract.");
    }
    for (const [key, check] of Object.entries(fields)) {
      const location = pointer(path, key);
      if (!Object.hasOwn(value, key)) add("MISSING_FIELD", location, "Required field is missing.");
      else check(value[key], location);
    }
    return true;
  }
  function array(check, minimum = 0) {
    return (value, path) => {
      if (!Array.isArray(value)) { add("INVALID_TYPE", path, "Expected an array."); return; }
      if (value.length < minimum) add("EMPTY_ARRAY", path, "Expected at least " + minimum + " item(s).");
      for (let index = 0; index < value.length; index++) check(value[index], pointer(path, index));
    };
  }
  function register(map, key, path, code, value) {
    if (typeof key !== "string" || !key.length) return;
    const first = map.get(key);
    if (first) {
      first.ambiguous = true;
      add(code, path, "Identity is duplicated; no record is selected as the winner.", { relatedPaths: [first.path] });
    } else map.set(key, { path, value, ambiguous: false });
  }
  function file(value, path) {
    object(value, path, { path: string, sha256: hash, bytes: integer(0) });
  }
  function source(value, path) {
    if (object(value, path, { version: known("version"), filename: string, sourcePath: string, sha256: hash })) {
      register(sources, value.version, pointer(path, "version"), "DUPLICATE_SOURCE_VERSION", value);
    }
  }
  function evidence(value, path) {
    object(value, path, { datasetSha256: hash, reviewDate: date, csv: file, report: file, sources: array(source, 1) });
  }
  function categories(value, path) {
    const seen = new Map();
    array((item, location) => {
      known("category")(item, location);
      register(seen, item, location, "DUPLICATE_CATEGORY", item);
    }, 1)(value, path);
  }
  function occurrences(value, path) {
    const seen = new Map();
    array((item, location) => {
      if (!object(item, location, {
        version: known("version"), occurrenceKey: string, filename: string, sourcePath: string,
        sourceSha256: hash, line: integer(1), endLine: integer(1),
        salesIncluded: (flag, p) => { if (typeof flag !== "boolean") add("INVALID_TYPE", p, "Expected a boolean."); },
        disposition: known("disposition"),
      })) return;
      register(seen, item.occurrenceKey, pointer(location, "occurrenceKey"), "DUPLICATE_OCCURRENCE", item);
      if (Number.isSafeInteger(item.line) && Number.isSafeInteger(item.endLine) && item.endLine < item.line) {
        add("INVALID_LINE_RANGE", pointer(location, "endLine"), "endLine must be >= line.");
      }
      if (typeof item.occurrenceKey === "string" && typeof item.version === "string" && Number.isSafeInteger(item.line) &&
          item.occurrenceKey !== item.version + ":" + item.line) {
        warn("UNRECOGNIZED_OCCURRENCE_KEY", pointer(location, "occurrenceKey"), "Key does not follow the observed version:line convention; it is treated as opaque.");
      }
      if (typeof item.occurrenceKey === "string" && item.occurrenceKey.length) {
        const first = globalOccurrences.get(item.occurrenceKey);
        if (first && first.decisionPath !== path) {
          warn("REUSED_OCCURRENCE", pointer(location, "occurrenceKey"), "Occurrence key is also used by another decision.", { relatedPaths: [first.path] });
        } else if (!first) globalOccurrences.set(item.occurrenceKey, { decisionPath: path, path: pointer(location, "occurrenceKey") });
      }
      if (typeof item.version === "string") {
        const declaration = sources.get(item.version);
        if (!declaration || declaration.ambiguous) {
          add("UNKNOWN_SOURCE_REFERENCE", pointer(location, "version"), "Occurrence must reference one unambiguous source declaration.");
        } else {
          for (const [key, sourceKey] of [["filename", "filename"], ["sourcePath", "sourcePath"], ["sourceSha256", "sha256"]]) {
            if (Object.hasOwn(item, key) && Object.hasOwn(declaration.value, sourceKey) && item[key] !== declaration.value[sourceKey]) {
              add("SOURCE_REFERENCE_MISMATCH", pointer(location, key), "Occurrence conflicts with its declared source.",
                { relatedPaths: [pointer(declaration.path.slice(0, -"/version".length), sourceKey)] });
            }
          }
        }
      }
    }, 1)(value, path);
  }
  function decision(value, path) {
    if (!object(value, path, {
      groupKey: string, orderId: string, categories, status: known("status"),
      note: (note, p) => string(note, p, false), revision: integer(0), updatedAt: timestamp,
      sourceEvidence: occurrences,
    })) return;
    register(decisions, value.groupKey, pointer(path, "groupKey"), "DUPLICATE_DECISION_IDENTITY", value);
    if (typeof value.groupKey === "string" && typeof value.orderId === "string" && value.groupKey !== "id:" + value.orderId) {
      warn("UNRECOGNIZED_GROUP_KEY", pointer(path, "groupKey"), "Key does not follow the observed id:orderId convention; it is treated as opaque.");
    }
  }

  object(input, "", {
    schemaVersion: (value, path) => { if (value !== 1) add("UNSUPPORTED_SCHEMA_VERSION", path, "Only numeric schemaVersion 1 is supported."); },
    workspace: string,
    evidence,
    meaning: (value, path) => {
      if (string(value, path, false) && value !== MEANING) warn("UNRECOGNIZED_MEANING", path, "Unrecognized declaration; read-only report semantics do not change.");
    },
    decisions: array(decision),
  });
  return {
    valid: !diagnostics.some(item => item.severity === "error"),
    decisionCount: isObject(input) && Array.isArray(input.decisions) ? input.decisions.length : null,
    diagnostics,
  };
}

module.exports = { validateExport };
