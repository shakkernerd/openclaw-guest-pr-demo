# directory-manifest

A small CommonJS library and CLI for versioned, portable directory inventories.
Node.js **22+**, using only built-in `fs`, `path`, `crypto`, and the Node test runner.
No installation, dependencies, network access, services, or configuration needed.

## CLI

Run from the repository root:

```sh
node directory-manifest/cli.js create "./my folder"
node directory-manifest/cli.js verify "./my folder"
node directory-manifest/cli.js verify "./my folder" --json

# Optional explicit manifest location (relative to the working directory):
node directory-manifest/cli.js create "./my folder" ./snapshot.json
node directory-manifest/cli.js verify "./my folder" ./snapshot.json
node directory-manifest/cli.js --help
```

- Default: `ROOT/.directory-manifest.json`. Creating an in-tree manifest records
  its exact root-relative path in `excludes`, so it never inventories itself.
  An explicit nested location works too; its parent directory must already exist.
- `create` writes **only the new manifest**, after a successful scan. It refuses
  to overwrite any existing file, directory, or symlink, including a dangling
  link. There is no force, repair, or delete command. A write failure may leave
  an incomplete new manifest; the command exits with an error.
- To replace a baseline, deliberately move the old manifest **outside the tree**
  yourself, then create again. A backup left inside the tree is ordinary data.
- `verify` is read-only. Normal output starts with changed/missing/extra entry
  counts, followed by one differing path per line in deterministic path order.
  Paths use JSON quoting so spaces, Unicode, and line breaks are safe.
  `--json` still emits **only** the unchanged library result described below:
  no summary or reason fields are added. Errors go to stderr, not JSON.
- Exit codes: **0** created/matches/help; **1** verification differences;
  **2** malformed input, unsafe paths, unsupported entries, or I/O failure.
- `--` ends option parsing, e.g. `create -- -folder -manifest.json`.
- Exclusions are stored in the manifest, not guessed during verification. Moving
  the whole tree with its default manifest works. Moving/renaming the manifest
  *within* the tree, or moving an external manifest inside it, can make it an
  extra entry unless its new path was explicitly excluded when creating it.

### Reading the report

```text
Summary: 1 changed, 1 missing, 1 extra.
changed "README.md" (size: 9431 -> 9458 bytes; SHA-256 changed)
missing "incoming"
extra "追加 メモ.txt"
```

Counts measure **entries**, not bytes or individual reasons. A file with both
a size and digest change counts once. Directories count too, including empty
ones; a missing directory and each of its missing descendants count separately.
Changed-entry reasons show expected -> actual values where applicable:

- `size: OLD -> NEW bytes`: byte length differs.
- `SHA-256 changed`: content digest differs, even if the size is unchanged.
- `type: directory -> file` (or another type pair): entry kind differs.
- `symlink target changed`: the opaque target text differs; neither target is
  followed. Full old/new entries remain available in `--json`.

An intact folder prints `Summary: 0 changed, 0 missing, 0 extra.` followed by
`OK: directory matches manifest.` and exits 0. Differences exit 1. A failed
inspection or invalid manifest exits 2 without a potentially misleading partial
summary. The JSON shape and all exit codes are unchanged.

### Handing a release folder to a colleague

1. Assemble a release folder with its actual source and documentation. Include
   any required empty directories (for example `incoming`) before inventorying.
   Spaces and Unicode are fine, such as `docs/Usage café 世界.md`.
2. Create a `metadata` directory **before** creating the manifest. Choose its
   filename explicitly; only that file is excluded, not the metadata directory
   or its other contents. From this repository root:

   ```sh
   node directory-manifest/cli.js create "./Release café 世界" "./Release café 世界/metadata/manifest.json"
   ```

3. Copy the **whole directory**, preserving empty directories and the relative
   metadata location. Rename or relocate the outer folder freely. The recipient
   uses the copied manifest, without regenerating a baseline:

   ```sh
   node directory-manifest/cli.js verify "./colleague drop/Release café 世界" "./colleague drop/Release café 世界/metadata/manifest.json"
   ```

   When this package's `cli.js` and `index.js` are included at the release root,
   the colleague can instead run `node cli.js verify . metadata/manifest.json`
   from inside that folder; no checkout of this repository is needed.

4. For a damage demonstration, make a **separate directory copy**, not hard
   links, of the verified consumer folder. Edit its README, remove only its empty
   `incoming` directory, and add a file such as `追加 メモ.txt`. Verify that copy
   against its unchanged copied manifest. Leave the original consumer folder
   and its manifest intact; reverify them afterward.

The focused handoff test exercises these steps with copies of this package's
real `index.js`, `cli.js`, `package.json`, and README. It also checks an initially
empty destination (all eight inventoried entries missing), fills it, relocates
it, and confirms that only the disposable copy has the three intended changes:

```sh
node --test --test-name-pattern="release handoff" directory-manifest/test/cli.test.js
```

Tests clean up their disposable fixtures; generated manifests and release copies
are not contribution files. Byte sizes in the example report depend on the release.

## Library

```js
const fs = require('node:fs/promises');
const {
  createManifest, verifyManifest, parseManifest, serializeManifest,
} = require('./directory-manifest');

async function example() {
  const root = './my folder';
  const manifest = await createManifest(root, {
    excludes: ['.directory-manifest.json'],
  });
  // Saving is explicit; the library itself does not write anything.
  await fs.writeFile(root + '/.directory-manifest.json',
    serializeManifest(manifest), { flag: 'wx' });

  const saved = parseManifest(
    await fs.readFile(root + '/.directory-manifest.json', 'utf8'));
  const result = await verifyManifest(root, saved);
  console.log(result.ok, result.changes);
}
```

- `createManifest(root, { excludes = [] } = {}) -> Promise<Manifest>`
- `verifyManifest(root, manifest) -> Promise<{ ok, changes }>`
- `validateManifest(manifest) -> Manifest`: strict validation and a detached,
  canonically sorted copy. Also called by create, verify, parse, and serialize.
- `parseManifest(jsonText) -> Manifest`: parses a JSON string and validates it.
- `serializeManifest(manifest) -> string`: validated, stable two-space JSON
  with a final newline. These three synchronous functions throw on invalid input.

Roots are nonempty native path strings. Async functions reject on invalid input
or I/O errors; a difference is not an exception. Caller objects are not mutated.
`changes` is globally sorted by path, and contains:

```js
{ path: 'a.txt', status: 'changed', expected: /* entry */, actual: /* entry */ }
{ path: 'gone', status: 'missing', expected: /* entry */ }
{ path: 'new', status: 'extra', actual: /* entry */ }
```

A type change is `changed` at that path. Descendants are independently missing
or extra. File size **or** SHA-256 differences count, including same-size edits.
Link target text changes count. Permissions, ownership, timestamps, and inode
identity are not part of the portable comparison.

## Format and path rules

Version 1 has exactly these fields (example is an empty file and directory):

```json
{
  "version": 1,
  "algorithm": "sha256",
  "excludes": [".directory-manifest.json"],
  "entries": [
    { "path": "empty directory", "type": "directory" },
    {
      "path": "empty.txt",
      "type": "file",
      "size": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

A link entry has exactly `{ "path": "link", "type": "symlink",
"target": "../elsewhere" }`. Files have safe nonnegative integer byte sizes and
64-character lowercase SHA-256 digests. Empty directories are explicit; the root
is implicit. Hidden files are included. Hard links are independent file entries.

Paths are **relative `/`-separated strings**, not URLs or native absolute paths.
Empty paths/components, `.`, `..`, leading/trailing slashes, backslashes, colons
(including drive paths and alternate streams), NUL, and unpaired Unicode
surrogates are rejected. Duplicate paths, conflicting types, unknown fields,
unsupported versions, and missing/non-directory parents are errors. There is
no path cleanup, Unicode normalization, case folding, or percent decoding.

Exclusions use the same path rules, are exact non-directory paths (no globs),
and cannot duplicate/overlap one another or entries. Their parent directories
must be explicit in the manifest. An excluded path may be absent, a file, or a
link; encountering a directory at that exact path is an error, not permission
to hide its subtree. Verification walks the actual tree and compares inventories;
it never opens a pathname taken from a manifest entry. Trust the saved baseline,
including its exclusions: SHA-256 provides integrity comparison, not authenticity.

All ordering is JavaScript string ordering (UTF-16 code units), independent of
locale and enumeration order. Unicode and spaces are preserved exactly as the
filesystem exposes them. Non-UTF-8 filesystem names/link targets are rejected
rather than decoded lossily. The format is portable; a particular filesystem
may still forbid names or collapse case/Unicode distinctions another allows.

## Symlinks, read-only behavior, and limits

**Never follow symlinks during inventory or verification**, even when their
target is inside the root. Record only `readlink` target text. Absolute, outside,
dangling, and cyclic targets are safe opaque data and are never opened or hashed.
A link to a directory is a link, not a directory to recurse into. The final root
component must be a real directory, not a symlink; aliases in its ancestors are
canonicalized before inspection. The CLI also rejects a symlink manifest file
and symlink parent components inside the selected tree, even through an external
alias to that tree. External aliases are resolved component by component (with
a 40-link limit), not used to bypass this rule. An explicitly selected external
manifest location is supported.

The library only reads. Verification never writes. The CLI's only write is the
requested new manifest (which naturally changes its parent directory metadata).
It does not chmod, touch, repair, delete, extract, or start anything. Reading may
update **access times** according to the OS/mount policy; no portable Node API
guarantees atime preservation. Contents, modes, and modification times are not
changed by inspection.

Use a **quiescent tree**. File identity/size/mtime/ctime and directory metadata
are checked for common concurrent changes; file opens use no-follow flags where
available. This is not an atomic snapshot or a security boundary against a
hostile process racing ancestor-directory replacements: Node's portable API
does not provide descriptor-relative traversal. Use a filesystem snapshot or
external isolation when other processes can mutate the tree adversarially.
Mount points are directories; hard-link relationships are not tracked.

Regular files, directories, and symlinks are supported. Devices, sockets, FIFOs,
unreadable entries, invalid names, and detected concurrent changes fail the
operation instead of producing an apparently complete partial result. Hashing
uses one file handle and a 64 KiB buffer at a time; inventories and reports are
held in memory. There is no watcher, cache, signature scheme, or restore engine.

## Tests and local review

```sh
# All repository tests, including the pre-existing parcel-label tests:
node --test
# This package only, no install step:
npm --prefix directory-manifest test
```

Tests use disposable real directories and child Node CLI processes. They cover
content/structure differences, deterministic JSON and output, Unicode/spaces,
read-only inspection, strict validation, self-exclusion, relocation, refusal to
overwrite, outside/dangling/cyclic links, alias-path bypasses, entry summaries,
change reasons, the real-source handoff workflow, and error exit codes. Built-in
test mocks inject read failures, unsupported stat types, and a stat/open mutation.
Symlink tests skip only where Windows denies link creation; raw-byte filename
tests are Linux-specific. No test starts a service or requires another program.

The pre-change revision is recorded in [STARTING_REVISION](STARTING_REVISION).
All contribution files are confined to this package. No dependencies or
repository-wide settings were added.
