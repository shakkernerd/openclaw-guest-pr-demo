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

## Record Desk: offline JSON review

Open **index.html** in the repository's Files preview, or open the file directly
in a modern browser. It is self-contained: no server, installation, network,
account, or build step is required to use it. Click **Try sample records** for a
four-record walkthrough.

1. Choose a JSON file or paste an array and click **Import & replace**:

   ```json
   [
     { "id": "R-101", "title": "Verify delivery address", "postcode": "Missing" },
     { "id": "R-102", "title": "Confirm parcel count", "items": 3 }
   ]
   ```

2. Select a record; mark it **Approve**, **Reject**, **Needs follow-up**, or return
   it to **Unreviewed**. Notes apply as you type. Expand **Original record** to see
   every field. Search titles, IDs, and review notes (case-insensitive), combined
   with the selected decision filter. For example, `signed count` finds a record
   with the review note `Inventory matches the signed count.`. Leaving the notes
   field refreshes the matching list/count without interrupting typing. If that
   note no longer matches, the same record stays open with a notice; subsequent
   edits still belong to it, not another matching record. All buttons and
   disclosure summaries share one note-exit path: the completed click finishes
   the note before the action, so targets cannot shift away between pointer
   press and release. This includes record selection, decisions, export/copy,
   download, and record details. Dragging off cancels the action; keyboard focus
   changes still refresh immediately.
3. Use **Export review** for a versioned JSON snapshot containing **all** records,
   decisions, and notes, regardless of filters. Download it or select/copy the
   JSON into a UTF-8 text file. Import that export to restore the exact snapshot.

### Import and saving rules

- IDs and titles must be non-empty strings; IDs must be unique. Convert numeric
  IDs to strings. IDs are exact and case-sensitive, with no trimming/coercion.
  Use stable IDs for the same entities, not row numbers. Additional fields stay
  in the original records and exports; review metadata is stored separately.
- Every import action, including sample data, **replaces the record list**.
  Arrays retain reviews for matching IDs, even if titles change. New IDs start
  unreviewed; omitted IDs and their reviews are removed. An empty array clears
  the list. Export before replacing data you may want later.
- A Record Desk export has `format: "record-review"`, `version: 1`, `records`,
  and `reviews` keyed by ID. It restores its own reviews, not a merge. Unsupported
  versions, missing/extra reviews, invalid decisions, duplicate IDs, malformed
  JSON, and unreadable files are rejected without changing accepted data,
  decisions, notes, or storage. A newer import supersedes an earlier pending
  file read, even if the newer import is rejected.
- When available, localStorage holds one review under `record-review:v1`.
  Reloading the same browser location restores it. Access/write failures leave
  the app usable in memory and display a warning. Corrupt/unsupported saved data
  is not overwritten on startup or rejected imports; the next accepted change
  replaces it. Browser storage is not encrypted, shared across tabs at the same
  origin, and last write wins; use one review tab and export important work.
- The embedded **Files preview may block browser storage and downloads**. Its
  sandbox is unchanged. A download click cannot prove that a file was saved, so
  the app says “requested, not confirmed.” If nothing downloads, use **Select JSON
  to copy**, then Ctrl/Cmd+C, and save the text yourself. Export **before closing
  or reloading** a memory-only preview. Direct-file storage also varies by browser;
  moving the HTML file may change its storage location.
- Intended for modest datasets that fit in browser memory; the entire JSON is
  parsed/rendered locally. No data is uploaded. JSON numbers use JavaScript's
  normal numeric precision; keep exact large identifiers/values as strings.

### Small source layout

- `review-state.js`: pure validation, identity-based state transitions, filtering,
  export, and guarded storage functions; also usable through CommonJS in tests.
- `review-app.js`: DOM events, async import ordering, rendering, and download UI.
- `review-template.html`: accessible, responsive markup and inline CSS.
- `build-review.js`: built-in Node APIs only; inlines those sources into the
  delivered `index.html` so restrictive previews need no relative asset access.

After editing those sources, run:

```sh
node build-review.js
node build-review.js --check
node --test
git diff --check
```

The existing parcel helper and its three tests are unchanged. The additional
Node checks cover atomic rejection, stable-ID reconciliation, special object-key
IDs, decisions, title/ID/notes search with decision filters, export round trips,
corrupt/blocked storage, and freshness of the shipped preview.

Optional real-browser checks use an **already installed** Chromium, with no test
framework or downloads:

```sh
RECORD_REVIEW_BROWSER=/path/to/chromium node --test
```

Without that variable, ten browser scenarios are explicitly skipped. With it,
they exercise the actual HTML in an opaque-origin `sandbox="allow-scripts"`
iframe, actual file input, overlapping/read-failed imports, safe text rendering,
note-finish list/count refresh without changing the edited record or caret,
actual pointer down/up on record, decision, export/copy, download, and disclosure
controls (including drag-away cancellation and subsequent keyboard blur), manual
export, silent/throwing download limitations, storage restoration across a real
reload, corrupt saves, and quota failures. The pointer download check inspects
the requested JSON blob, not a confirmed disk save. Only in an already-isolated
container without Chromium OS-sandbox support, add
`RECORD_REVIEW_BROWSER_NO_SANDBOX=1` to the test command. This affects the test
browser process only, never the Files preview or iframe permissions.
