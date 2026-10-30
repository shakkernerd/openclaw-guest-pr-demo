"use strict";

const fs = require("node:fs");
const { TextDecoder } = require("node:util");

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_DEPTH = 64;
const MAX_VALUES = 10_000;
const MAX_COMPARISONS = 10_000;
const MAX_REPORT_BYTES = 256 * 1024;

function parseInput(bytes, side) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError(`${side}: expected a Buffer`);
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new Error(`${side}: input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  let text;
  try {
    // Preserve a BOM so JSON.parse rejects it rather than silently stripping it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${side}: invalid UTF-8`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Native parse errors can quote input; keep diagnostics bounded and data-free.
    throw new Error(`${side}: invalid JSON`);
  }
  let values = 0;
  function normalize(value, depth) {
    if (depth > MAX_DEPTH) throw new Error(`${side}: depth exceeds ${MAX_DEPTH}`);
    if (++values > MAX_VALUES) {
      throw new Error(`${side}: value count exceeds ${MAX_VALUES}`);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${side}: nonfinite number`);
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new Error(`${side}: unsafe integer`);
      }
      return value === 0 ? 0 : value;
    }
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1));
    // Null prototypes keep literal __proto__/constructor keys as ordinary data.
    const object = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      object[key] = normalize(value[key], depth + 1);
    }
    return object;
  }
  return normalize(parsed, 0);
}

/** Compare two bounded UTF-8 Buffers; return a complete report or throw. */
function compareJson(leftBytes, rightBytes) {
  const left = parseInput(leftBytes, "left");
  const right = parseInput(rightBytes, "right");
  const parts = { added: [], removed: [], changed: [] };
  let reportBytes = Buffer.byteLength('{"added":[],"removed":[],"changed":[]}\n');
  let comparisons = 0;

  function record(kind, entry) {
    const encoded = JSON.stringify(entry);
    reportBytes += Buffer.byteLength(encoded) + (parts[kind].length ? 1 : 0);
    if (reportBytes > MAX_REPORT_BYTES) {
      throw new Error(`report exceeds ${MAX_REPORT_BYTES} bytes`);
    }
    parts[kind].push(encoded);
  }

  function visit(before, after, path, beforePresent, afterPresent) {
    if (++comparisons > MAX_COMPARISONS) {
      throw new Error(`comparison count exceeds ${MAX_COMPARISONS}`);
    }
    if (!beforePresent) {
      record("added", { path, value: after });
    } else if (!afterPresent) {
      record("removed", { path, value: before });
    } else if (before !== after) {
      if (Array.isArray(before) && Array.isArray(after)) {
        for (let i = 0; i < Math.max(before.length, after.length); i++) {
          visit(before[i], after[i], [...path, i], i < before.length, i < after.length);
        }
      } else if (before !== null && after !== null &&
                 typeof before === "object" && typeof after === "object" &&
                 !Array.isArray(before) && !Array.isArray(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) {
          visit(before[key], after[key], [...path, key],
            Object.hasOwn(before, key), Object.hasOwn(after, key));
        }
      } else {
        record("changed", { path, before, after });
      }
    }
  }
  visit(left, right, [], true, true);
  return {
    report: `{"added":[${parts.added.join(",")}],"removed":[${parts.removed.join(",")}],"changed":[${parts.changed.join(",")}]}\n`,
    different: parts.added.length + parts.removed.length + parts.changed.length > 0,
  };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readInput(file, side, inputStats) {
  try {
    // Nonblocking open lets us reject FIFOs without waiting for a writer.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      inputStats.push(stat); // Retain identity even if size/read/close fails.
      if (!stat.isFile()) throw new Error(`${side}: input must be a regular file`);
      if (stat.size > BigInt(MAX_INPUT_BYTES)) {
        throw new Error(`${side}: input exceeds ${MAX_INPUT_BYTES} bytes`);
      }
      // Do not trust stat alone: a concurrently growing file is still bounded.
      const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_INPUT_BYTES) {
        throw new Error(`${side}: input exceeds ${MAX_INPUT_BYTES} bytes`);
      }
      return { bytes: bytes.subarray(0, size), stat };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code) throw new Error(`${side}: cannot read file (${error.code})`);
    throw error;
  }
}

function writeDiagnostic(error, args, inputStats) {
  try {
    const sink = fs.fstatSync(2, { bigint: true });
    if (inputStats.some(input => sameFile(input, sink))) return;
    // A prior failure may have prevented opening either input. Check their paths
    // too; keep known descriptor identities in case a path no longer names it.
    for (const file of args.slice(0, 2)) {
      try {
        if (sameFile(fs.statSync(file, { bigint: true }), sink)) return;
      } catch (statError) {
        if (sink.isFile() && statError.code !== "ENOENT" && statError.code !== "ENOTDIR") return;
      }
    }
    fs.writeSync(2, `json-diff: ${error.message}\n`);
  } catch { /* Exit 2 even if stderr cannot be inspected or written. */ }
}

function main() {
  const args = process.argv.slice(2);
  const inputStats = [];
  try {
    if (args.length !== 2) throw new Error("usage: node json-diff.js LEFT.json RIGHT.json");
    const left = readInput(args[0], "left", inputStats);
    const right = readInput(args[1], "right", inputStats);
    const { report, different } = compareJson(left.bytes, right.bytes);
    try {
      const output = fs.fstatSync(1, { bigint: true });
      if ([left.stat, right.stat].some(input => sameFile(input, output))) {
        throw new Error("stdout: aliases an input file");
      }
      const bytes = Buffer.from(report);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(1, bytes, offset, bytes.length - offset);
        if (count === 0) throw new Error("stdout: zero-byte write");
        offset += count;
      }
    } catch (error) {
      if (error.code) throw new Error(`stdout: cannot write (${error.code})`);
      throw error;
    }
    process.exitCode = different ? 1 : 0;
  } catch (error) {
    process.exitCode = 2;
    writeDiagnostic(error, args, inputStats);
  }
}

module.exports = { compareJson };
if (require.main === module) main();
