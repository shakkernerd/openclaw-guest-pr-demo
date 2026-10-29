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

### Compare a saved review without replacing your work

Use **Compare saved review**, then choose a saved JSON file or paste its contents
and activate **Compare pasted review**. Comparison accepts the same version 1
Record Desk snapshot that Export produces, validated by the existing state
owner. Raw record arrays are deliberately not accepted for comparison; the
import/export contract and format/version are unchanged.

- The comparison is **read-only**. It does not import, merge, write storage,
  replace records/decisions/notes, change the selected record or search/filter,
  or reset the notes editor's native Undo history. There is no Apply action.
  Export/import remain separate, explicit actions.
- Summary counts show current and compared totals, added/removed IDs, and shared
  IDs that are changed or unchanged. Among shared IDs, record-field changes are
  counted separately from decision/note changes, with decision and note counts
  also shown. These categories can overlap; a record can change in both ways.
- IDs match exactly and case-sensitively. Changed/removed current IDs appear in
  current record order, followed by added IDs in the incoming snapshot's order.
  Records are aligned by ID, not position. Object key order is ignored, including
  nested objects; array-valued fields retain order and JSON value types matter.
- Expand each changed entry to see **Current working review (before)** and
  **Compared snapshot (after)**, with complete records and decision/note values.
  Values are rendered as JSON text, never HTML. Empty strings appear as `""`,
  missing records are explicitly marked, and Unicode/HTML-looking text is kept.
  The sides stack at narrow widths. Tab reaches native controls and entry
  summaries; Enter/Space activates buttons and opens/closes summaries.
- The current side follows subsequent working edits and imports, regardless of
  search/filter, while the compared snapshot stays fixed. Expanded changed
  entries stay expanded as you edit. Neither snapshot is merged into the other.
- **Close & clear comparison** clears the comparison and returns focus to its
  opening button. Collapsing the comparison panel also clears it. Nothing from
  comparison is stored or restored on reload.
- Starting another comparison clears the previous results while the file is
  read/JSON is validated. Invalid snapshots and unreadable files leave no stale
  comparison results and do not affect working data. Newer attempts (including
  rejected ones) and closing the panel supersede earlier pending reads. Import
  and comparison have independent read ordering.

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

- `review-state.js`: pure validation, identity-based state transitions, snapshot
  comparison, filtering, export, and guarded storage; also usable in Node tests.
- `review-app.js`: DOM events, independent async import/comparison ordering,
  rendering, and download UI.
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
corrupt/blocked storage, and freshness of the shipped preview. Comparison state
tests cover validation, exact IDs, semantic JSON equality, categories/counts,
ordering, empty snapshots, and immutable inputs. `review-app.test.js` runs the
actual DOM adapter against a small Node harness for complete text rendering,
working/editor/storage isolation, live updates, and deterministic file-read
success/failure/supersession races. This harness does not test browser layout or
native keyboard/Undo behavior.

The eleven optional real-browser scenarios in `review-browser.test.js` are
skipped unless `RECORD_REVIEW_BROWSER` points to an already installed Chromium.
Leave browser-launch opt-ins unset for the default Node checks; no browser
installation is required.
