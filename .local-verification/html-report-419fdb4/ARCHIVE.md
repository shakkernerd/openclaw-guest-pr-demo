# Local HTML verification archive

This ignored directory is for local inspection only, not maintained project tooling
and not part of the committed contribution. It is excluded through local
`.git/info/exclude`; no project ignore rules were added.

Archived from local report commit `419fdb41a46093e6a45d6037c923f355330deb46`:

- Original browser smoke helper in `scripts/`, plus its report-source dependencies.
- Three Chromium screenshots in `screenshots/`: desktop, narrow layout, keyboard focus.
- Previously committed proof screenshot and generated HTML in `examples/`.
- `original-contribution.patch`: exact binary-capable diff from local baseline `d422500`.

Verification already performed on Node 24.22.1 and Chromium 156.0.8078.4:
53 project tests passed; Tab/Enter/Space toggles, accessible disclosure labels and
states, visible focus, narrow/desktop layout, and hostile text checks passed.
Independent read-only snapshot review found no concrete correctness findings.
The archived helper is retained as evidence, not a supported project command.

Browser font-cache artifacts from that verification remain separately at
`/tmp/packing-font-cache-html-report`; no browser cache handling is shipped.
