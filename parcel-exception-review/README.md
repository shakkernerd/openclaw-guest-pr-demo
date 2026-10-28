# Parcel exception review

A read-only dispatcher review page using the existing `parcel-event-audit` package
unchanged. No network assets, uploads, telemetry, persistent storage, shipment
actions, dependencies or package installation. Only synthetic example data is
included. **Review does not authorize shipment**, even with zero exceptions.

## Open and review

**Portable (recommended):** save `review.html` and open it directly in a current
browser. That single file embeds all scripts, styles, instructions and the example;
it needs neither a server nor sibling files. Choose a local events JSON file, or
try the synthetic example. Keep downloaded evidence as private as its source.

**Contained preview:** open `review.html`, not the modular `index.html`. Scripts
must be allowed by the containing host. A visible startup warning and disabled
chooser remain if scripting cannot start. A host can permit review but block
downloads: if an export click produces no download, save `review.html` and open it
directly. Do not change platform permissions to work around this. The page cannot
reliably confirm that a browser saved a requested download.

**Original modular edition:** with installed Node.js 22+ from the repository root:

```sh
node parcel-exception-review/serve.cjs
```

Open `http://127.0.0.1:4173`; stop with Ctrl+C. `index.html` uses local modules and
CSS, so it needs HTTP and its sibling files (not a direct file or isolated HTML
preview). The static server is loopback-only by default and accepts no uploads.

1. Choose exactly one UTF-8 JSON **array** of event records (not JSONL or a report).
2. Compare overall totals, then filter by parcel, issue type and/or search text.
   Filters combine; totals remain for the entire validated input.
3. Inspect a row to see all conflict variants, contradictory delivery/cancellation
   evidence, retry sources and affected-parcel timelines. No event wins.
4. Select individual checkboxes deliberately. Inspecting/filtering does not select
   rows. Selection survives filtering; the bar counts hidden selections. **Select
   all matches** adds all matching rows across pages; **Clear selection** clears
   visible and hidden selections.
5. **Download selected JSON** exports exactly the selected complete exceptions,
   including hidden selections, in deterministic audit order: a bare JSON array,
   no unselected matches, totals, filter state or generated timestamp. Zero selected
   disables export. **Original input** downloads the exact received bytes.

## Input and evidence contract

```json
[
  {"eventId":"e1","parcelId":"PKG-1","type":"created","occurredAt":"2026-10-28T08:00:00Z"}
]
```

Each record has exactly these four string fields. Types: `created`, `in_transit`,
`delivered`, `cancelled`. The [upstream contract](../parcel-event-audit/README.md)
defines identity, timestamps and reconciliation. Audit IDs are case-sensitive;
search is not. Benign retries are counted but are not exceptions. Parcel filtering
keeps the whole cross-parcel conflict, not just the matching variant.

Maximum 5 MiB / 10,000 records; larger files are rejected, never truncated. Invalid
UTF-8, BOMs, duplicate keys (including escaped keys), extra fields, bad dates,
malformed JSON or any invalid later record reject the entire review visibly. New
loads immediately clear old totals and selection; no partial or stale valid report
is shown. `[]` is valid; an empty file is not. Latest load wins; Clear review cancels
pending reads. This is an in-memory batch tool, not a large-export streaming tool.

The adapter preserves raw JSON element slices and passes records to the unchanged
package without parse/reserialize loss of duplicate keys. Exported sources include
`filename`, physical one-based `line`, one-based `recordIndex`, zero-based UTF-8
`byteStart`/`byteEnd` range **[start, end)**, exact `rawJSON` and original timestamp
spelling. The entire original-byte download also retains separators and whitespace.
Input is held only in tab memory, rendered as text and never overwritten. Within
the size limit, original bytes remain available after validation rejection too.
Clearing releases application references; it is not secure memory erasure.

## Reproducible build and checks — no installation

Run from the repository root with installed Node.js 22+ (verified with Node 24):

```sh
node parcel-exception-review/build.cjs --check
node parcel-exception-review/portable/build.cjs --check
node --test parcel-exception-review/review.test.mjs parcel-exception-review/server.test.cjs parcel-exception-review/tests/portable-build.test.cjs
node parcel-exception-review/browser-check.mjs
node parcel-exception-review/tests/portable-browser.mjs
```

To regenerate intentionally: run the two build commands without `--check`, in that
order. Only `audit.browser.mjs` and `review.html` are generated. The first wraps the
exact upstream CommonJS source; the second embeds it and the modular page, example
and help with hash-based CSP. Neither changes the upstream package or its rules.

Browser checks use installed Chromium and Node built-ins (WebSocket/CDP). Set
`CHROMIUM_PATH=/path/to/chromium` if necessary; nothing is downloaded. They use
temporary synthetic fixtures, profiles and downloads, then clean them up. The
portable check copies only `review.html` into an otherwise empty directory and
checks offline file opening, opaque sandbox previews, blocked scripts/CSP/downloads,
actual downloaded JSON and original bytes, hidden selection, source ranges, invalid
input, racing loads, pagination, injection safety and narrow layout.

## Proof limits

Automated browser coverage is installed Chromium, including simulated iframe
policies—not the real Files host. A separate user verification of the **actual
Files preview** confirmed styles/import/totals/search/filtering/evidence/invalid
rejection, but selected export did not start there. Saving and opening the portable
file directly worked for a deliberate subset with a hidden selection; the user
reported exact source byte ranges and an identical original-byte download. This is
user-reported verification, not an independently rechecked copy of their download.
The specific containing-frame restriction was not diagnosed or changed. Safari,
Firefox and comprehensive assistive-technology coverage are not claimed.

Received exports, private review reports, screenshots and earlier proof remain
outside this reusable contribution. Tests require no such task material.
