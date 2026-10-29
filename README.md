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

## Delivery-address formatting

`delivery-address.js` exports the CommonJS helper `formatDeliveryAddress(lines)`.
Pass a nonempty array of nonblank, single-line strings in the exact order wanted
on the label, including the recipient. The helper joins them with LF (`\n`) and
adds no trailing newline. Accepted strings remain unchanged, including Unicode,
combining characters, capitalization, punctuation, surrounding whitespace, and
duplicate lines. It does not trim or normalize output or mutate the input.

Nonarrays, missing/sparse entries (including inherited-only entries), and
nonstring entries throw `TypeError`; an empty array, blank lines, or embedded
line breaks throw `RangeError`. Blank means empty or whitespace-only according to
JavaScript `String.prototype.trim()`; trimming is used only to check blankness.
Prohibited line breaks are LF (U+000A), CR (U+000D), vertical tab (U+000B), form
feed (U+000C), NEL (U+0085), line separator (U+2028), and paragraph separator
(U+2029). No values are coerced to strings.

Run this consumer example from the repository root:

```sh
node <<'NODE'
const { formatDeliveryAddress } = require("./delivery-address.js");

const label = formatDeliveryAddress([
  "Zoë Martin",
  "12 rue des Écoles",
  "75005 Paris",
  "France",
]);

console.log(label);
NODE
```

Output:

```text
Zoë Martin
12 rue des Écoles
75005 Paris
France
```

`console.log` adds a terminal newline; the returned label has none.

This formats plain caller-supplied text only, not verified or HTML-escaped
address data. It does not verify identity, completeness, postal correctness, or
deliverability, and does not authorize dispatch. Even one nonblank line is
accepted. Callers remain responsible for address verification, safe rendering
in their chosen output context, and dispatch decisions; the existing manual
checks still apply.

`delivery-address.test.js` covers this contract using the same `node --test`
command above.

## Offline line editor

Open `delivery-address.html` directly as a local file in a browser, keeping
`delivery-address.css`, `delivery-address.js`, and `delivery-address-editor.js`
beside it. No server, build, installation, or network connection is needed.
The page loads the canonical helper as a classic script, exposing the same
`formatDeliveryAddress` function globally; its CommonJS export is unchanged.

The editor starts with one empty draft textarea. Add line appends a blank row
and focuses it. Remove preserves the remaining values and order, focusing the
next row, the previous row if last, or Add line when none remain. Move up and
Move down relocate the existing row one position and focus its textarea,
preserving all draft values, controls, IDs, and text selections. Labels follow
the current order. Move up is disabled on the first row and Move down on the
last; both are disabled with one row. A boundary no-op changes nothing.
There is no required street/city/postcode schema.

Only Format address passes the browser-held textarea values, unchanged, to the
canonical formatter. Embedded line breaks remain draft data and cause its
normal errors, as do blank lines or removing every row. Errors preserve all
drafts and are announced in the status area. Any edit, addition, removal, or
real move immediately clears the old result and obsolete error without
revalidating. Moving never formats automatically: choose Format address to
format the current textarea order.
Draft controls are not rebuilt while typing. Browsers may normalize textarea
line endings; the editor does not transform the values they expose.

Successful output is read-only, selectable plain text, not HTML, with exact LF
separators and no final newline. Tab to the output and use the browser's normal
text-selection keys if needed. Formatting does not verify a postal address or
authorize dispatch. There is no printing, clipboard API, storage, import/export,
network request, postal verification, dispatch, or extra address field.

`delivery-address-editor.test.js` uses Node's built-in VM and a small DOM test
double to load the real HTML entry's scripts and exercise the event lifecycle.
It is not browser, rendering, accessibility, native Files, standalone, or narrow
viewport proof; those need separate checks in an approved browser. The PR43
base (`047eba34abd79b0af1f1d9caa0602d8f671b6bdd`) had only the helper and no
editor or browser UI. This new page's empty draft is not a pre-change UI.
