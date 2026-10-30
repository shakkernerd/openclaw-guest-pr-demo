# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. The existing parcel tests cover counts 0, 1, and 3.
Manifest tests cover real CLI commands, byte preservation, deterministic output,
validation, containment, symlinks, and missing/changed/unreadable results. Their
bounded fixtures live in temporary directories and are removed after each test.

## File manifest CLI

Dependency-free; uses only Node.js 22+ built-ins. From the repository root:

```sh
node file-manifest.js --help
node file-manifest.js create . README.md parcel-label.js > /tmp/declared-files.json
node file-manifest.js verify . /tmp/declared-files.json
node --test file-manifest.test.js parcel-label.test.js
node --check file-manifest.js
```

`create ROOT FILE [FILE ...]` hashes an explicit, nonempty set of regular files.
It writes JSON to stdout only after all files have been read successfully.
There is no recursion, glob expansion, directory enumeration, stdin mode, or
output-file option. Quote paths with spaces or shell metacharacters. Arguments
after ROOT are literal paths, including names beginning with `-`; no `--` is
needed. ROOT is relative to the working directory (or absolute). FILE is always
relative to ROOT. Shells may expand unquoted globs before the CLI sees them.

**Redirect output only to a separate, non-input file.** The shell opens/truncates
a redirection before Node runs; the CLI cannot protect an input from `> input`.
Avoid redirecting onto an existing file you need to keep. Neither command opens
inputs for writing or normalizes their bytes. Reads can update filesystem access
times; read-only here means no intentional filesystem writes, not zero metadata
effects. Hashing uses bounded 64 KiB chunks, including for binary and empty files.

### Manifest format and determinism

```json
{
  "version": 1,
  "algorithm": "sha256",
  "files": [
    {
      "path": "empty.txt",
      "size": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

The format has exactly these keys. Sizes are nonnegative safe integers, digests
are 64 lowercase hex characters, and file paths are unique. Imported manifests
may list entries in any order; the entire schema and every path are validated
before declared files are inspected. Manifests must be UTF-8 JSON without a BOM.
Manifest JSON is read into memory; use reasonably sized manifests.

Creation sorts paths by JavaScript UTF-16 code-unit order (not locale order),
uses two-space JSON indentation and a final LF, and includes no timestamps or
absolute root paths. Identical declared paths and bytes produce identical output
regardless of argument order, working directory, root location, or file mtime.
No Unicode normalization or filesystem case folding is performed; distinct
spellings may refer to the same file on case-insensitive/normalizing filesystems.

### Paths, symlinks, and unsupported inputs

Paths use `/` separators and well-formed Unicode. Reject absolute paths, empty
components, `.` or `..` components, backslashes, ASCII controls (U+0000–001F and
U+007F), and `< > : " | ? *`. Components must not end in a dot or space. Windows
device names CON, PRN, AUX, NUL, COM1–9, and LPT1–9 (including the Windows-recognized
superscript ¹, ², ³ variants) are rejected case-insensitively, with or without an
extension. This deliberately strict grammar also rejects drive paths, UNC paths,
and alternate data streams rather than rewriting ambiguous names.

ROOT is resolved once with `realpath` and must be a directory; a symlink selecting
ROOT (or in its ancestors) is allowed. Below that resolved root, **all symlinks
are rejected**, whether internal, external, dangling, or in a parent component.
Only regular files are hashed: directories, sockets, FIFOs, and devices are not
supported. Hard links are regular files and are accepted.

MANIFEST is an explicit path relative to the working directory (or absolute),
not to ROOT, and may be outside ROOT. It must itself be a regular, non-symlink
file; its parent directories may resolve through symlinks. Root selection and
manifest location are caller-trusted inputs; entries imported from a manifest
cannot lexically escape ROOT or traverse a detected symlink beneath it.

### Verification and exits

`verify ROOT MANIFEST` emits JSON `{ "ok": boolean, "files": [...] }`, sorted by
path, and attempts every declared file after validation:

- `ok`: byte size and SHA-256 both match. Includes `expected` and `actual`.
- `changed`: either differs, including same-size content changes. Includes both
  `{ "size", "sha256" }` values for diagnosis.
- `missing`: a file or parent component is absent (`ENOENT`). Includes `expected`
  and `code`. A dangling symlink is instead `unreadable` / `SYMLINK`.
- `unreadable`: a read/access failure or unsupported filesystem input. Includes
  `expected` and a stable CLI or OS `code`: for example `EACCES`, `SYMLINK`,
  `UNSUPPORTED_TYPE`, or `NOT_DIRECTORY` (a non-directory parent). It is not
  mislabeled as a content mismatch.

Exit **0**: create/help succeeded, or all declared files verified.
Exit **1**: verification found any missing, changed, or unreadable declared file.
Exit **2**: bad usage, malformed/unsafe manifest, inaccessible manifest, invalid
or inaccessible root, or any creation failure. Fatal errors are JSON on stderr
(`error.code`, `error.message`, and a declared `error.path` when available), with
no stdout manifest/report. OS error messages can vary by platform.

### Limits of the claim

This is a **declared-file byte comparison**, not proof of directory completeness:
extra files are ignored. It does not prove authenticity (an attacker can change
both data and manifest), provide a filesystem snapshot, or guarantee safety
against hostile filesystem races. Files are read sequentially; concurrent writes
can produce a mixed-time view. Component checks and no-follow/nonblocking flags
where available are defense in depth, not race-proof traversal. Use a trusted,
quiescent root; do not treat this CLI as a sandbox for a hostile writable tree.
