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
Comparison tests reuse the validation cases and cover both input positions,
real differences and controls, UTF-16 ordering, byte preservation, and native
commands with absent and permission-denied declared files.

## File manifest CLI

Dependency-free; uses only Node.js 22+ built-ins. From the repository root:

```sh
node file-manifest.js --help
node file-manifest.js create . README.md parcel-label.js > /tmp/declared-files.json
node file-manifest.js verify . /tmp/declared-files.json
node file-manifest.js compare /tmp/before.json /tmp/after.json
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
Avoid redirecting onto an existing file you need to keep. No command opens
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
Comparison reuses this same version-1 validation and path policy for both inputs.

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

Exit **0**: create/help succeeded, all declared files verified, or comparison
found identical declarations.
Exit **1**: verification found any missing, changed, or unreadable declared file,
or comparison found any added, removed, or changed entry.
Exit **2**: bad usage, malformed/unsafe manifest, inaccessible manifest, invalid
or inaccessible root, or any creation failure. Fatal errors are JSON on stderr
(`error.code`, `error.message`, and a declared `error.path` when available), with
no stdout manifest/report. OS error messages can vary by platform.

### Comparing two manifests (no declared-file access)

`compare BEFORE AFTER` compares the declarations in two version-1 manifests,
not the filesystem. There is no ROOT argument. BEFORE and AFTER are literal
paths relative to the working directory (or absolute); names beginning with `-`
need no `--`. Each must be a regular, non-symlink file, just like MANIFEST for
verification; symlinks in their parent directories are allowed. Both inputs
are decoded and fully validated before any comparison report is written. An
invalid or inaccessible input on either side yields exit 2, JSON stderr, and
empty stdout; no partial comparison is emitted.

The JSON report is `{ "ok": boolean, "files": [...] }`. `ok` is true only when
both manifests declare exactly the same paths, sizes, and digests. Each union
path appears once, sorted by locale-independent UTF-16 code-unit order, with:

- `path`: the exact declared path; no normalization or case folding.
- `status`: `added` (only in AFTER), `removed` (only in BEFORE), `changed`
  (present in both but size or SHA-256 differs), or `unchanged` (both match).
- `before` and `after`: each is `{ "size": number, "sha256": string }`, or
  `null` when that side has no entry. Both values are included even for
  unchanged entries. A size-only or digest-only difference is still changed.

For example, the `files` array can contain this same-size content difference:

```json
{
  "path": "data.txt",
  "status": "changed",
  "before": {
    "size": 3,
    "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  },
  "after": {
    "size": 3,
    "sha256": "a52d159f262b2c6ddb724a61840befc36eb30c88877a4030b65cbe86298449c9"
  }
}
```

Output uses two-space indentation and a final LF. Input entry order, JSON key
order, and whitespace do not affect the report. A path rename is a removal
plus an addition, not inferred identity. Inputs are never rewritten; comparing
a manifest to itself is allowed. Memory use scales with both input documents
and their union; comparison is not streaming.

Declared paths are only validated strings used as comparison keys. They are
never resolved, statted, opened, or hashed by comparison; the declared files
need not exist or be readable. `unchanged` means equal declarations, **not**
verified bytes. Use `verify` separately when actual file verification is needed.
Comparison does not establish authenticity, a filesystem snapshot, or directory
completeness, and does not protect against concurrent replacement of manifests.

### Limits of the claim

This is a **declared-file byte comparison**, not proof of directory completeness:
extra files are ignored. It does not prove authenticity (an attacker can change
both data and manifest), provide a filesystem snapshot, or guarantee safety
against hostile filesystem races. Files are read sequentially; concurrent writes
can produce a mixed-time view. Component checks and no-follow/nonblocking flags
where available are defense in depth, not race-proof traversal. Use a trusted,
quiescent root; do not treat this CLI as a sandbox for a hostile writable tree.
