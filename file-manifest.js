"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const HELP = `Usage:
  node file-manifest.js create ROOT FILE [FILE ...]
  node file-manifest.js verify ROOT MANIFEST
  node file-manifest.js compare BEFORE AFTER
  node file-manifest.js --help

Create writes deterministic JSON to stdout; redirect only to a separate,
non-input file. FILE paths are canonical, slash-separated paths below ROOT.
Verify reads a JSON manifest and reports every declared file as ok, missing,
changed, or unreadable. It never writes files. Exit: 0 success, 1 differences
or unreadable declared files, 2 invalid input/root or creation failure.
Compare validates two version-1 manifests and reports added, removed, changed,
or unchanged entries as JSON with before/after size and SHA-256 (null if absent).
It reads only the manifests, never declared files; no ROOT is used. Output is
path-sorted. Exit: 0 equal declarations, 1 differences, 2 invalid input.

Only regular files are supported. Symlinks below the resolved ROOT are
rejected, as is a symlink at any input manifest itself. Absolute/traversing/ambiguous
paths, duplicates, and empty file sets are rejected. See README.md for the
path grammar and schema. ROOT itself may resolve through symlinks.

A manifest covers only declared bytes, not directory completeness,
authenticity, a filesystem snapshot, or hostile filesystem race safety.
`;

function fail(code, message, file) {
  const error = new Error(message);
  error.code = code;
  if (file !== undefined) error.file = file;
  return error;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validatePath(file) {
  if (typeof file !== "string" || !file || !file.isWellFormed() ||
      /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(file) ||
      file.split("/").some((part) => !part || part === "." || part === ".." ||
        /[. ]$/u.test(part) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw fail("INVALID_PATH", "Expected a canonical relative file path", file);
  }
}

function sortedPaths(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw fail("INVALID_MANIFEST", "At least one declared file is required");
  }
  const seen = new Set();
  for (const file of files) {
    validatePath(file);
    if (seen.has(file)) throw fail("DUPLICATE_PATH", "Duplicate declared path", file);
    seen.add(file);
  }
  // Default string order is locale-independent UTF-16 code-unit order.
  return [...files].sort();
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, ["version", "algorithm", "files"]) ||
      manifest.version !== 1 || manifest.algorithm !== "sha256" ||
      !Array.isArray(manifest.files)) {
    throw fail("INVALID_MANIFEST", "Expected version 1, algorithm sha256, and files");
  }
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ["path", "size", "sha256"]) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        typeof entry.sha256 !== "string" || entry.sha256.length !== 64 ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw fail("INVALID_MANIFEST", "Each entry needs path, nonnegative safe-integer size, and lowercase SHA-256");
    }
  }
  sortedPaths(manifest.files.map((entry) => entry.path));
  return [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function resolveRoot(root) {
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory()) {
    throw fail("INVALID_ROOT", "ROOT must be a directory");
  }
  return resolved;
}

function declaredFile(root, file) {
  const parts = file.split("/");
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) {
    throw fail("INVALID_PATH", "Path escapes ROOT", file);
  }
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw fail("SYMLINK", "Symlinks below ROOT are not supported", file);
    if (i < parts.length - 1 && !stat.isDirectory()) {
      throw fail("NOT_DIRECTORY", "A path parent is not a directory", file);
    }
    if (i === parts.length - 1 && !stat.isFile()) {
      throw fail("UNSUPPORTED_TYPE", "Only regular files are supported", file);
    }
  }
  return target;
}

function withRegularFile(filename, consume) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw fail("SYMLINK", "Symlinks are not supported");
  if (!stat.isFile()) throw fail("UNSUPPORTED_TYPE", "Only regular files are supported");
  // Defense in depth, not a guarantee against hostile concurrent replacements.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) |
    (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(filename, flags);
  try {
    if (!fs.fstatSync(fd).isFile()) throw fail("UNSUPPORTED_TYPE", "Only regular files are supported");
    return consume(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fingerprint(root, file) {
  return withRegularFile(declaredFile(root, file), (fd) => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      size += bytes;
      if (!Number.isSafeInteger(size)) throw fail("TOO_LARGE", "Byte size exceeds a safe integer");
      hash.update(buffer.subarray(0, bytes));
    }
    return { size, sha256: hash.digest("hex") };
  });
}

function createManifest(root, files) {
  const sorted = sortedPaths(files);
  const resolved = resolveRoot(root);
  return {
    version: 1,
    algorithm: "sha256",
    files: sorted.map((file) => {
      try {
        return { path: file, ...fingerprint(resolved, file) };
      } catch (error) {
        error.file = file;
        throw error;
      }
    }),
  };
}

function verifyManifest(root, manifest) {
  // Validate the entire imported document before inspecting declared paths.
  const entries = validateManifest(manifest);
  const resolved = resolveRoot(root);
  const files = entries.map((entry) => {
    const expected = { size: entry.size, sha256: entry.sha256 };
    try {
      const actual = fingerprint(resolved, entry.path);
      const status = actual.size === expected.size && actual.sha256 === expected.sha256 ? "ok" : "changed";
      return { path: entry.path, status, expected, actual };
    } catch (error) {
      return {
        path: entry.path,
        status: error.code === "ENOENT" ? "missing" : "unreadable",
        expected,
        code: error.code || "IO_ERROR",
      };
    }
  });
  return { ok: files.every((file) => file.status === "ok"), files };
}

function compareManifests(before, after) {
  // Reuse the full version-1 validation before building any comparison.
  // Declared paths are keys only: no root resolution or filesystem access.
  const beforeEntries = validateManifest(before);
  const afterEntries = validateManifest(after);
  const beforeByPath = new Map(beforeEntries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(afterEntries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
  const files = paths.map((file) => {
    const previous = beforeByPath.get(file);
    const next = afterByPath.get(file);
    const status = !previous ? "added" : !next ? "removed" :
      previous.size === next.size && previous.sha256 === next.sha256 ? "unchanged" : "changed";
    return {
      path: file,
      status,
      before: previous ? { size: previous.size, sha256: previous.sha256 } : null,
      after: next ? { size: next.size, sha256: next.sha256 } : null,
    };
  });
  return { ok: files.every((file) => file.status === "unchanged"), files };
}

function readManifest(filename) {
  const bytes = withRegularFile(filename, (fd) => fs.readFileSync(fd));
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fail("INVALID_MANIFEST", "Manifest must be UTF-8 JSON without a BOM");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw fail("INVALID_MANIFEST", "Manifest must be UTF-8 JSON without a BOM");
  }
}

function main(args) {
  try {
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write(HELP);
      return 0;
    }
    const [command, first, ...inputs] = args;
    let result;
    if (command === "create" && first && inputs.length > 0) {
      result = createManifest(first, inputs);
    } else if (command === "verify" && first && inputs.length === 1) {
      result = verifyManifest(first, readManifest(inputs[0]));
    } else if (command === "compare" && first && inputs.length === 1) {
      result = compareManifests(readManifest(first), readManifest(inputs[0]));
    } else {
      throw fail("USAGE", "Use --help for create ROOT FILE..., verify ROOT MANIFEST, or compare BEFORE AFTER");
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return (command === "verify" || command === "compare") && !result.ok ? 1 : 0;
  } catch (error) {
    const detail = { code: error.code || "IO_ERROR", message: error.message };
    if (error.file !== undefined) detail.path = error.file;
    process.stderr.write(`${JSON.stringify({ error: detail })}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { createManifest, verifyManifest, compareManifests };
