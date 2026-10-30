"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createManifest, verifyManifest } = require("./file-manifest.js");

const CLI = path.join(__dirname, "file-manifest.js");
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "file-manifest-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  fs.mkdirSync(root);
  return { temp, root, manifest: path.join(temp, "manifest.json") };
}

function put(root, file, bytes) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function entry(file, size = 0, sha256 = EMPTY_HASH) {
  return { path: file, size, sha256 };
}

function manifest(files) {
  return { version: 1, algorithm: "sha256", files };
}

function snapshot(root) {
  const result = {};
  function visit(directory, prefix) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix + name;
      const stat = fs.lstatSync(absolute);
      const item = { mode: stat.mode, mtimeMs: stat.mtimeMs };
      if (stat.isSymbolicLink()) item.link = fs.readlinkSync(absolute);
      else if (stat.isDirectory()) visit(absolute, relative + "/");
      else item.bytes = fs.readFileSync(absolute).toString("hex");
      result[relative] = item;
    }
  }
  visit(root, "");
  return result;
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function cli(args, expectedStatus, { evidence = false, preserve, ...options } = {}) {
  const before = preserve && snapshot(preserve);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, ...options,
  });
  if (evidence && process.env.FILE_MANIFEST_TEST_TRACE === "1") {
    if (options.cwd) console.log("cwd=" + shellQuote(options.cwd));
    if (options.uid !== undefined) console.log("child uid=" + options.uid + " gid=" + options.gid);
    console.log("$ " + [process.execPath, CLI, ...args].map(shellQuote).join(" "));
    console.log("status=" + result.status + " signal=" + result.signal);
    console.log("stdout:\n" + (result.stdout || "(empty)"));
    console.log("stderr:\n" + (result.stderr || "(empty)"));
  }
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedStatus, result.stderr + result.stdout);
  if (expectedStatus === 2) {
    assert.equal(result.stdout, "");
    assert.equal(typeof JSON.parse(result.stderr).error.code, "string");
  } else {
    assert.equal(result.stderr, "");
  }
  if (preserve) {
    assert.deepEqual(snapshot(preserve), before, "CLI must preserve fixture bytes, modes, mtimes and names");
    if (evidence && process.env.FILE_MANIFEST_TEST_TRACE === "1") {
      console.log("input-preservation: PASS (bytes, modes, mtimes, names; atime excluded)");
    }
  }
  return result;
}

function linkOrSkip(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Creating symlinks is not permitted on this Windows host");
      return false;
    }
    throw error;
  }
}

test("real CLI: deterministic create, unchanged control, owned mismatch, missing, and preservation", (t) => {
  const f = fixture(t);
  const bytes = Buffer.from([0, 255, 13, 10, 195, 169, 0]);
  put(f.root, "control.txt", "abc");
  put(f.root, "nested/owned.bin", bytes);
  put(f.root, "empty.txt", "");
  put(f.root, "undeclared.txt", "intentionally outside the declaration");
  const names = ["nested/owned.bin", "empty.txt", "control.txt"];
  const options = { evidence: true, preserve: f.temp };
  const created = cli(["create", f.root, ...names], 0, options);
  const parsed = JSON.parse(created.stdout);
  assert.deepEqual(parsed, manifest([
    entry("control.txt", 3, ABC_HASH), entry("empty.txt"),
    entry("nested/owned.bin", bytes.length, createHash("sha256").update(bytes).digest("hex")),
  ]));
  assert.equal(created.stdout, JSON.stringify(parsed, null, 2) + "\n");
  fs.writeFileSync(f.manifest, created.stdout);
  fs.utimesSync(path.join(f.root, "control.txt"), 123, 456);
  const reordered = cli(["create", "root", ...names.reverse()], 0, { ...options, cwd: f.temp });
  assert.equal(reordered.stdout, created.stdout);
  const copied = path.join(f.temp, "copy");
  fs.cpSync(f.root, copied, { recursive: true });
  assert.equal(cli(["create", copied, ...names], 0).stdout, created.stdout);

  const unchanged = JSON.parse(cli(["verify", f.root, f.manifest], 0, options).stdout);
  assert.equal(unchanged.ok, true);
  assert.deepEqual(unchanged.files.map((file) => file.status), ["ok", "ok", "ok"]);
  assert.equal(unchanged.files.length, 3, "undeclared files are ignored");

  const changed = Buffer.from(bytes);
  changed[1] = 254; // Intentional same-size mutation of only this test-owned file.
  fs.writeFileSync(path.join(f.root, "nested/owned.bin"), changed);
  const mismatch = JSON.parse(cli(["verify", f.root, f.manifest], 1, options).stdout);
  assert.deepEqual(mismatch.files.map((file) => file.status), ["ok", "ok", "changed"]);
  assert.equal(mismatch.files[2].expected.size, mismatch.files[2].actual.size);
  assert.notEqual(mismatch.files[2].expected.sha256, mismatch.files[2].actual.sha256);
  fs.unlinkSync(path.join(f.root, "empty.txt"));
  const missing = JSON.parse(cli(["verify", f.root, f.manifest], 1, options).stdout);
  assert.deepEqual(missing.files.map((file) => file.status), ["ok", "missing", "changed"]);
  assert.equal(missing.files[1].code, "ENOENT");
  assert.deepEqual(fs.readFileSync(path.join(f.root, "control.txt")), Buffer.from("abc"));
  assert.deepEqual(fs.readFileSync(path.join(f.root, "nested/owned.bin")), changed);
  assert.equal(fs.readFileSync(f.manifest, "utf8"), created.stdout);
});

test("hashes multiple chunks and literal Unicode, spaced, and dash-prefixed names", (t) => {
  const f = fixture(t);
  const large = Buffer.alloc(150001);
  for (let i = 0; i < large.length; i += 1) large[i] = i % 251;
  put(f.root, "é space/中.bin", large);
  put(f.root, "-literal", "abc");
  const result = JSON.parse(cli(["create", f.root, "é space/中.bin", "-literal"], 0, { preserve: f.temp }).stdout);
  assert.deepEqual(result.files, [entry("-literal", 3, ABC_HASH),
    entry("é space/中.bin", large.length, createHash("sha256").update(large).digest("hex"))]);
  result.files.reverse();
  assert.equal(verifyManifest(f.root, result).ok, true);
  assert.deepEqual(result.files.map((file) => file.path), ["é space/中.bin", "-literal"], "import is not mutated");
});

test("size-only and digest-only mismatches are both changed", (t) => {
  const f = fixture(t);
  put(f.root, "data", "abc");
  for (const item of [entry("data", 4, ABC_HASH), entry("data", 3)]) {
    const result = verifyManifest(f.root, manifest([item]));
    assert.equal(result.ok, false);
    assert.equal(result.files[0].status, "changed");
    assert.deepEqual(result.files[0].actual, { size: 3, sha256: ABC_HASH });
  }
});

test("rejects unsafe and ambiguous paths before any root access, on create and import", (t) => {
  const f = fixture(t);
  const invalid = ["", ".", "..", "../outside", "a/../b", "a/./b", "./a", "/absolute", "a//b", "a/",
    "C:/outside", "C:outside", "a\\b", "\\\\server\\share", "//server/share", "a\0b", "a\nb", "a\tb", "a\u007fb",
    "file:stream", "star*", "question?", "x<y", "x>y", 'a"b', "a|b", "trailing.", "trailing ",
    "CON", "nul.txt", "aux", "PRN.ext", "com1", "COM9.log", "LPT1", "LPT³.log", "\ud800", null, 17];
  for (const file of invalid) {
    const unavailableRoot = path.join(f.temp, "absent-root");
    assert.throws(() => createManifest(unavailableRoot, [file]), { code: "INVALID_PATH" });
    assert.throws(() => verifyManifest(unavailableRoot, manifest([entry(file)])), { code: "INVALID_PATH" });
  }
  put(f.temp, "outside", "must never be imported");
  fs.writeFileSync(f.manifest, JSON.stringify(manifest([entry("../outside")])));
  const result = cli(["verify", f.root, f.manifest], 2, { evidence: true, preserve: f.temp });
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_PATH");
});

test("strict schema, duplicate and empty-set validation", (t) => {
  const f = fixture(t);
  const good = entry("data");
  const bad = [null, [], {}, { ...manifest([good]), version: 2 }, { ...manifest([good]), algorithm: "sha512" },
    { ...manifest([good]), extra: true }, manifest([]), manifest([null]), manifest([{}]),
    { version: 1, algorithm: "sha256", files: {} },
    manifest([{ ...good, extra: true }]), manifest([{ path: "data", size: 0 }]),
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null].map((size) => manifest([{ ...good, size }])),
    ...["A".repeat(64), "g".repeat(64), "0".repeat(63), "0".repeat(65),
      EMPTY_HASH + "\n", EMPTY_HASH + "\r", EMPTY_HASH + "\u2028", 0, null]
      .map((sha256) => manifest([{ ...good, sha256 }])),
  ];
  for (const value of bad) {
    assert.throws(() => verifyManifest(f.root, value), { code: "INVALID_MANIFEST" });
  }
  assert.throws(() => createManifest(f.root, []), { code: "INVALID_MANIFEST" });
  assert.throws(() => createManifest(f.root, ["data", "data"]), { code: "DUPLICATE_PATH" });
  assert.throws(() => verifyManifest(f.root, manifest([good, good])), { code: "DUPLICATE_PATH" });
  fs.writeFileSync(f.manifest, JSON.stringify(manifest([good, good])));
  assert.equal(JSON.parse(cli(["verify", f.root, f.manifest], 2).stderr).error.code, "DUPLICATE_PATH");
});

test("real CLI: missing files, non-directory parents and unsupported types stay distinct", (t) => {
  const f = fixture(t);
  put(f.root, "control", "abc");
  fs.mkdirSync(path.join(f.root, "directory"));
  fs.writeFileSync(f.manifest, JSON.stringify(manifest([
    entry("missing-parent/file"), entry("directory"), entry("control/child"), entry("control", 3, ABC_HASH),
  ])));
  const options = { evidence: true, preserve: f.temp };
  const report = JSON.parse(cli(["verify", f.root, f.manifest], 1, options).stdout);
  assert.deepEqual(report.files.map(({ path: file, status, code }) => [file, status, code]), [
    ["control", "ok", undefined], ["control/child", "unreadable", "NOT_DIRECTORY"],
    ["directory", "unreadable", "UNSUPPORTED_TYPE"], ["missing-parent/file", "missing", "ENOENT"],
  ]);
  for (const [file, code] of [["missing", "ENOENT"], ["directory", "UNSUPPORTED_TYPE"], ["control/child", "NOT_DIRECTORY"]]) {
    const result = cli(["create", f.root, "control", file], 2, options);
    assert.equal(JSON.parse(result.stderr).error.code, code);
    assert.equal(JSON.parse(result.stderr).error.path, file);
  }
});

test("symlink leaves and parents are rejected, even internal or dangling; root aliases are explicit", (t) => {
  const f = fixture(t);
  put(f.root, "real/data", "abc");
  put(f.temp, "outside/data", "outside bytes");
  if (!linkOrSkip(t, path.join(f.root, "real/data"), path.join(f.root, "internal"), "file")) return;
  fs.symlinkSync(path.join(f.temp, "outside/data"), path.join(f.root, "external"), "file");
  fs.symlinkSync(path.join(f.temp, "does-not-exist"), path.join(f.root, "dangling"), "file");
  fs.symlinkSync(path.join(f.root, "real"), path.join(f.root, "internal-dir"), "dir");
  fs.symlinkSync(path.join(f.temp, "outside"), path.join(f.root, "external-dir"), "dir");
  const names = ["internal", "external", "dangling", "internal-dir/data", "external-dir/data"];
  for (const file of names) assert.throws(() => createManifest(f.root, [file]), { code: "SYMLINK" });
  fs.writeFileSync(f.manifest, JSON.stringify(manifest(names.map((name) => entry(name)))));
  const report = JSON.parse(cli(["verify", f.root, f.manifest], 1, { evidence: true, preserve: f.temp }).stdout);
  assert.ok(report.files.every((file) => file.status === "unreadable" && file.code === "SYMLINK"));
  const alias = path.join(f.temp, "root-alias");
  fs.symlinkSync(f.root, alias, "dir");
  assert.deepEqual(createManifest(alias, ["real/data"]), createManifest(f.root, ["real/data"]));
  const manifestAlias = path.join(f.temp, "manifest-alias.json");
  fs.symlinkSync(f.manifest, manifestAlias, "file");
  assert.equal(JSON.parse(cli(["verify", f.root, manifestAlias], 2).stderr).error.code, "SYMLINK");
});

test("hard links remain supported regular files", (t) => {
  const f = fixture(t);
  put(f.root, "original", "abc");
  fs.linkSync(path.join(f.root, "original"), path.join(f.root, "alias"));
  assert.deepEqual(createManifest(f.root, ["original", "alias"]).files, [entry("alias", 3, ABC_HASH), entry("original", 3, ABC_HASH)]);
});

test("real CLI: permission-denied file is unreadable, not changed or missing", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  // When tests run as root, only this child drops to an unprivileged uid/gid.
  // No grants, host settings, or files outside the owned fixture are changed.
  const options = { evidence: true };
  if (process.getuid() === 0) Object.assign(options, { uid: 65534, gid: 65534 });
  fs.chmodSync(f.temp, 0o755);
  fs.chmodSync(f.root, 0o755);
  put(f.root, "denied", "private test bytes");
  put(f.root, "control", "abc");
  fs.chmodSync(path.join(f.root, "control"), 0o644);
  const created = createManifest(f.root, ["denied", "control"]);
  fs.writeFileSync(f.manifest, JSON.stringify(created), { mode: 0o644 });
  fs.chmodSync(path.join(f.root, "denied"), 0o000);
  try {
    const report = JSON.parse(cli(["verify", f.root, f.manifest], 1, options).stdout);
    assert.deepEqual(report.files.map((file) => file.status), ["ok", "unreadable"]);
    assert.equal(report.files[1].code, "EACCES");
    const failure = cli(["create", f.root, "control", "denied"], 2, options);
    assert.equal(JSON.parse(failure.stderr).error.code, "EACCES");
    assert.equal(fs.statSync(path.join(f.root, "denied")).mode & 0o777, 0);
  } finally {
    fs.chmodSync(path.join(f.root, "denied"), 0o600);
  }
  assert.equal(fs.readFileSync(path.join(f.root, "denied"), "utf8"), "private test bytes");
  assert.equal(fs.readFileSync(path.join(f.root, "control"), "utf8"), "abc");
  assert.equal(fs.readFileSync(f.manifest, "utf8"), JSON.stringify(created));
  fs.chmodSync(f.manifest, 0o000);
  try {
    const failure = cli(["verify", f.root, f.manifest], 2, options);
    assert.equal(JSON.parse(failure.stderr).error.code, "EACCES");
  } finally {
    fs.chmodSync(f.manifest, 0o600);
  }
  assert.equal(fs.readFileSync(f.manifest, "utf8"), JSON.stringify(created));
  if (process.env.FILE_MANIFEST_TEST_TRACE === "1") {
    console.log("permission-case input-preservation: PASS (declared files and manifest bytes)");
  }
});

test("real CLI: malformed JSON/UTF-8/BOM, manifest errors and root errors are fatal", (t) => {
  const f = fixture(t);
  put(f.root, "data", "abc");
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.from("\ufeff{}")]) {
    fs.writeFileSync(f.manifest, bytes);
    const result = cli(["verify", f.root, f.manifest], 2, { evidence: true, preserve: f.temp });
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_MANIFEST");
  }
  fs.writeFileSync(f.manifest, JSON.stringify(manifest([entry("data", 3, ABC_HASH)])));
  for (const [args, code] of [
    [["verify", f.root, path.join(f.temp, "absent.json")], "ENOENT"],
    [["verify", f.root, f.root], "UNSUPPORTED_TYPE"],
    [["verify", path.join(f.temp, "absent-root"), f.manifest], "ENOENT"],
    [["verify", path.join(f.root, "data"), f.manifest], "INVALID_ROOT"],
    [["create", path.join(f.root, "data"), "data"], "INVALID_ROOT"],
  ]) {
    assert.equal(JSON.parse(cli(args, 2, { preserve: f.temp }).stderr).error.code, code);
  }
});

test("help and invalid CLI arities have explicit statuses", () => {
  const help = cli(["--help"], 0, { evidence: true }).stdout;
  assert.match(help, /create ROOT FILE/);
  assert.match(help, /hostile filesystem race/);
  for (const args of [[], ["unknown"], ["create"], ["create", "."], ["verify", "."],
    ["verify", ".", "one", "two"], ["--help", "extra"]]) {
    assert.equal(JSON.parse(cli(args, 2).stderr).error.code, "USAGE");
  }
});

test("output delivery failures are fatal for create, help, both verify outcomes, and stderr", (t) => {
  const f = fixture(t);
  put(f.root, "data", "abc");
  const created = cli(["create", f.root, "data"], 0).stdout;
  fs.writeFileSync(f.manifest, created);
  const mismatch = JSON.parse(created);
  mismatch.files[0].size += 1;
  const changedManifest = path.join(f.temp, "changed.json");
  fs.writeFileSync(changedManifest, JSON.stringify(mismatch));
  const sink = path.join(f.temp, "read-only-output");
  fs.writeFileSync(sink, "must not be overwritten");
  const before = snapshot(f.temp);
  // A real read-only descriptor gives a deterministic write failure without
  // mocks, sleeps, a platform pipe helper, or a new runtime/test dependency.
  const fd = fs.openSync(sink, "r");
  function failed(args, stdout, stderr) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", stdout, stderr],
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 2, result.stderr || "fatal status must survive diagnostic failure");
    return result;
  }
  try {
    for (const args of [["create", f.root, "data"], ["--help"],
      ["verify", f.root, f.manifest], ["verify", f.root, changedManifest]]) {
      const result = failed(args, fd, "pipe");
      assert.equal(result.stdout, null);
      // Parsing the entire stream rejects duplicate documents or an appended stack.
      const diagnostic = JSON.parse(result.stderr);
      assert.equal(typeof diagnostic.error.code, "string");
      assert.equal(typeof diagnostic.error.message, "string");
      assert.equal(result.stderr.split("\n").length, 2, "one diagnostic line only");
      assert.equal(failed(args, fd, fd).stderr, null);
    }
    for (const args of [[], ["create", f.root, "absent"]]) {
      const result = failed(args, "pipe", fd);
      assert.equal(result.stdout, "", "no stdout fallback when stderr fails");
      assert.equal(result.stderr, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  assert.deepEqual(snapshot(f.temp), before);
});

test("import and synchronous callers leave stdio listeners and exit status untouched", (t) => {
  const f = fixture(t);
  put(f.root, "data", "abc");
  const code = [
    'const assert = require("node:assert/strict");',
    'const streams = [process.stdout, process.stderr];',
    'const listeners = () => streams.map(s => s.eventNames().map(e => [e, s.rawListeners(e)]));',
    'const before = listeners();',
    'process.exitCode = 17;',
    'const { createManifest, verifyManifest } = require(process.argv[1]);',
    'assert.equal(process.exitCode, 17);',
    'assert.deepEqual(listeners(), before);',
    'const root = process.argv[2];',
    'const manifest = createManifest(root, ["data"]);',
    'assert.equal(manifest.version, 1);',
    'assert.equal(verifyManifest(root, manifest).ok, true);',
    'assert.throws(() => createManifest(root, ["absent"]), { code: "ENOENT" });',
    'assert.throws(() => verifyManifest(root, {}), { code: "INVALID_MANIFEST" });',
    'assert.equal(process.exitCode, 17);',
    'assert.deepEqual(listeners(), before);',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", code, CLI, f.root], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 17, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
