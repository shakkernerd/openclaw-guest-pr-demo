# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively.

## Decision export audit

The isolated [decision-export-audit](decision-export-audit/README.md) directory
contains a dependency-free, read-only Node CLI/library for validating and
comparing discrepancy-review decision exports. It includes the documented
attachment-derived contract, byte-preserved baseline, and native library/CLI
checks. It reports differences and evidence identity changes; it never merges
exports or applies decisions.
