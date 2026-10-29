# openclaw-guest-pr-demo
Synthetic disposable fixtures for guest pull request continuation tests.

The parcelLabel helper lives in parcel-label.js and formats a count as an item label.

## Browser label preview and printable sheet

Open **parcel-preview.html** from Files, or download that single file and open it
locally in a browser. The delivered HTML contains its own styles, JavaScript and
formatter: no server, installation, network access or neighboring assets are
needed. JavaScript must be enabled. This is an in-memory authoring tool, not a
shipping service; it does not upload, create postage, store data or use an account.

1. Enter a **parcel identifier or name** and an **item count**. The live preview
   shows the actual label: your text and the canonical helper's item label.
   Unicode and HTML-looking names are literal text, never markup.
2. Use **Add to sheet** (or Enter from an input) to accept the current label.
   Accepted labels are independent snapshots; editing the draft cannot change
   them. The draft stays filled for further editing or adding another copy.
3. **Reset form** clears the draft, preview and input errors but keeps accepted
   labels. **Clear sheet** removes all accepted labels but keeps the draft. Use
   both to start over, or reload the page. Closing/reloading loses the sheet.
4. When ready, use the browser's normal **Print** command (Ctrl+P / ⌘P), including
   Save as PDF where available. Only accepted labels appear in the page's print
   content—not the form, draft preview, actions, status or empty-sheet message.
   Disable browser headers/footers in print settings for labels only. Labels wrap
   long text and request no page breaks inside a label; a single label taller
   than a printable page may still need to split. No fixed stock size is assumed.
   The page itself never opens a print dialog or sends anything to a printer.

Validation requires a nonblank name and an ASCII digits-only count from **0** to
**9007199254740991** (JavaScript's maximum safe integer). Surrounding whitespace
is trimmed; leading zeros are accepted. Signs, fractions, exponent notation,
separators, blank counts and unsafe integers are rejected with field-specific
errors. Any invalid draft immediately clears the valid preview; trying to add
it leaves the accepted sheet unchanged and focuses the first invalid field.
All controls use native keyboard-accessible form elements, with visible focus
indicators, associated error descriptions and live status announcements.

### Source and build

Edit `preview/parcel-preview.template.html` for markup/styles and
`preview/parcel-preview.js` for validation and browser behavior. The canonical
`parcel-label.js` remains unchanged and keeps its CommonJS export and existing
behavior. The builder embeds that actual source in a local CommonJS wrapper,
alongside the app, rather than maintaining a second formatter. It uses only
Node built-ins. The generated `parcel-preview.html` is the standalone deliverable;
do not edit it by hand. Rebuild after any source/helper change:

```sh
node build-parcel-preview.js
node build-parcel-preview.js --check
```

`--check` only compares output; it exits unsuccessfully if the HTML is missing or
stale. Source containing HTML script delimiters is rejected to prevent breaking
out of the inline bundle. The builder resolves source/output paths relative to
itself; pass the path to the script when running outside the repo directory.

## Tests

With Node.js 22 or newer, run this command from the repository root:

```sh
node --test
```

The tests use the built-in `node:test` runner and `node:assert/strict`; no dependency
installation is needed. They cover parcel counts 0, 1, and 3, expecting `0 items`,
`1 item`, and `3 items`, respectively. Those original tests are retained. Focused
preview checks cover count/name validation, shared-helper parity, bundle safety
and freshness, and generated-script state transitions using a small DOM contract
double (not a browser). No dependencies or package scripts are needed.

For a manual browser check, open the generated file directly and try zero, one,
the safe-integer boundary, invalid/blank counts, Unicode/HTML-looking names and
very long names. Confirm invalid edits clear the preview without changing the
sheet, both reset actions are independent, Tab/Enter work, and a narrow window
has no horizontal overflow. Inspect print media/preview for labels-only output,
wrapping and page-break behavior. Node checks do not verify browser layout,
assistive-technology announcements or pagination.
