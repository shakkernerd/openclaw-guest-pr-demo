const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const dir = 'contribution-review/notes-search';
const commit = git('rev-parse', 'HEAD');
const parent = git('rev-parse', 'HEAD^');
const base = '9f7fffaebaf79a99862136a32d93d7521d97c869';
const tree = git('rev-parse', 'HEAD^{tree}');
if (commit !== 'c4703c5f842d58678fc14b465121fd6fa10c6ca3') throw new Error('Unexpected candidate');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-search-patch-'));
try {
  const env = {...process.env, GIT_INDEX_FILE: path.join(temp, 'index')};
  const isolatedGit = (...args) => execFileSync('git', args, {env, encoding:'utf8'}).trim();
  isolatedGit('read-tree', base);
  isolatedGit('apply', '--cached', '--check', dir + '/notes-search.patch');
  isolatedGit('apply', '--cached', dir + '/notes-search.patch');
  if (isolatedGit('write-tree') !== tree) throw new Error('Patch does not reproduce candidate');
} finally {
  fs.rmSync(temp, {recursive:true, force:true});
}
fs.writeFileSync(dir + '/PR_TITLE.txt', 'feat: add offline JSON record review\n');
const paths = git('diff', '--name-only', base, commit).split('\n');
const expected = ['README.md','index.html','review-app.js','review-browser.test.js','review-state.js','review-state.test.js','review-template.html'];
if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error('Unexpected changed paths');
const hashes = ['notes-search.patch','PR_TITLE.txt','PR_BODY.md','node-tests.log','browser-tests.log'].map(file => '- `' + file + '`: `' + crypto.createHash('sha256').update(fs.readFileSync(dir + '/' + file)).digest('hex') + '`');
const manifest = [
 '# Combined notes-search refinement candidate', '',
 '- Commit: `' + commit + '`',
 '- Correction parent (preceding local candidate): `' + parent + '`',
 '- Combined patch base (checked app before all notes-search refinements): `' + base + '`',
 '- Tree: `' + tree + '`',
 '- Branch: `' + git('branch','--show-current') + '`',
 '- Existing PR: https://github.com/shakkernerd/openclaw-guest-pr-demo/pull/18',
 '- Publication status: local candidate only; no push, PR edit, merge, or other PR mutation performed.',
 '- Last recorded public snapshot head: `9f993f29b6136bdecbff3d2849ebf5a36605addd`; this work makes no publication request.',
 '- Proposed PR title is unchanged. Body expands search, note-completion, and pointer-ordering wording, updates actual check counts, and adds focused regression evidence; required publication tracking is preserved.',
 '- `contribution-review/` remains untracked and is not part of the commit.', '',
 '## Combined changed paths', '', ...paths.map(file => '- `' + file + '`'), '',
 '## Verification', '',
 '- `node --test`: 33 passed; 10 optional browser scenarios explicitly skipped; 0 failures.',
 '- `RECORD_REVIEW_BROWSER=/opt/ms-playwright/chromium-1248/chrome-linux-arm64/chrome RECORD_REVIEW_BROWSER_NO_SANDBOX=1 node --test`: all 43 passed, no skips. Uses the already-installed browser and the existing process-only container option; no environment configuration or Files sandbox policy was changed.',
 '- `node build-review.js --check`: standalone preview matches its sources.',
 '- `node --check review-app.js`, `node --check review-state.js`, `node --check review-state.test.js`, and `node --check review-browser.test.js`: passed.',
 '- Whitespace checks passed for the correction and combined refinement.',
 '- Combined patch applies to the checked app base in an isolated temporary Git index and reproduces the exact candidate tree; reverse-apply check also passed.',
 '- Regression-first tests reproduced the stale list/count before the fix in both the standalone page and restrictive iframe. The standalone test requires actual page focus and blur; the iframe uses real blur where allowed, otherwise a synthetic blur event.',
 '- Regression covers zero/other matches, caret and focus stability while typing, saved notes/full export preservation, re-entering results, explicit record selection, and a decision after blur targeting the original record.',
 '- Earlier trusted-pointer regressions reproduced missed first-click record selection and Reject targeting. Both remain passing with fixed press/release coordinates, no retargeting, and verified trusted pointerdown/pointerup/click events.',
 '- Four added trusted-pointer regressions failed before this correction: Select JSON did not focus/select the export, download made no request, and record/export disclosures stayed closed. All now pass at their original visible coordinates, including full snapshot export selection and download-blob verification. The download check proves a request with the correct JSON, not a confirmed disk save.',
 '- Pointer checks also assert stable target coordinates and no action on press, drag-away cancellation, preserved notes/caret, correct decision ID, and immediate keyboard-blur refresh afterward.',
 '- All enabled buttons and native disclosure summaries now share one path: pointerdown prevents early focus while notes are focused; capture-phase native click finishes notes after hit testing but before action handlers/default disclosure actions. No timing delay, replayed click, or early pointerdown action was introduced. Native text-input/select and keyboard focus paths remain unchanged.',
 '- Clicking the currently selected row after its note stops matching keeps that same record selected rather than silently switching to another result.',
 '- Independent re-review remains paused pending direction and was not restarted. Actual Files/downloaded-app interaction for this newest correction remains for the requester to check; no new manual browser evidence is claimed.',
 '- Original parcel helper/API/tests and import/persistence/export logic are unchanged. Only note-search/list rendering, associated UI/docs, focused tests, and the rebuilt standalone HTML change.', '',
 '## Try the rebuilt preview', '',
 'Open the rebuilt `index.html` in Files or download/open it again. Import four records, approve one, add `Inventory matches the signed count.` as its note, search `signed count`, and select Approved. Change the note to `Inventory confirmed.` and leave the field: the list/count should become 0 of 4 without changing the search. The same record stays open with a notice; subsequent notes still belong to it. Another matching record must be explicitly selected to edit it. Selectable export still includes every accepted record regardless of filtering.', '',
 'For the exact pointer regression, import two records A and B with notes containing `shared query`; search it, edit A so it no longer matches while keeping notes focused, then make one normal mouse click on B. It must select B and preserve A’s note. Repeat from the initial fixture and click Reject: A must become rejected, not B. Dragging off either control must not activate it.', '',
 'For export controls, first open Portable review JSON, use the same A/B fixture and search, and change A’s note to `Changed A note.` without leaving notes. One normal click on Select JSON to copy must focus/select the complete current export. Repeat with Download JSON and verify the request feedback (the browser may block saving), or a record-details summary and verify it opens. Also try opening the Portable review JSON summary from its closed state. Matching count becomes 1 of 2; A stays open with its notice and B remains unchanged. Dragging away before release must not activate any of these controls; keyboard Tab still refreshes the count immediately.', '',
 '## Artifact SHA-256', '', ...hashes, ''
].join('\n');
fs.writeFileSync(dir + '/CANDIDATE.md', manifest);
console.log('Patch reproduces candidate tree ' + tree);
console.log(manifest);
