# Independent scheduling and keyboard review

Reviewed on 2026-10-28 using isolated source snapshots and already installed offline Chromium. The reviewer did not modify the contribution, repository branches, or PRs. This was a separate challenge of scheduling and keyboard behavior, not just a rerun of the supplied test suite.

## Findings and disposition

| Finding | Resolution and independent verification |
| --- | --- |
| P2: populated crew dialogs initially focused Remove; repeated Enter could immediately persist an unintended removal | Initial and post-mutation focus now targets the candidate selector or Done. Keyboard opening and auto-repeat Enter preserve assignments, including after assigning/removing crew. |
| P3: dates such as 9999-12-31 passed domain validation but crashed the weekly renderer | Domain and editor bounds now match: 1900-01-08 through 9999-12-20. All five 9999-12-27…31 snapshots recover to a visibly temporary demo, preserving original storage even after temporary edits. Both supported boundary weeks render and accept valid edits. |
| P2 follow-up: safe Done focus could be below the dialog clipping area because scrolling was suppressed | Native focus scrolling is enabled after status text updates. Verified at 320×600 and 1280×900, including after mutations. At 320px, Done was at y=522–566 inside the dialog bounds y=18–582. |

**Final independent recheck: passed. No remaining blocking findings in the reviewed scope.** Startup text also correctly distinguishes a usable saved rota from temporary recovery state.

## Independent checks actually run

- 8 domain groups, including 18,496 interval pairs compared with a separate numeric overlap oracle and actual assignment acceptance/rejection. Frozen-input atomicity; combined-field rejection; all seven weekday changes; exact availability boundaries; 20-place capacity; replacement into full shifts; duplicates and invalid references; cascade integrity.
- 5 rendered mutation groups: rejected capacity/title/notes changes; shift role/date rejection and correction; unavailable-day changes preserving saved name/notes; same-name volunteers remaining distinct; cancelled deletion preserving state.
- Initial keyboard challenge included 1,080 forward/reverse Tab events across editors, error states, disabled controls, full/no-candidate dialogs, and narrow layouts; native Space/arrow/Enter behavior and Escape focus restoration.
- Final snapshot: 10 independent keyboard/recovery groups plus 2 focused visibility/mutation checks passed. Zero page exceptions or nonlocal requests.
- Native dialog-close focus restoration was rechecked after rendering settled. An immediate assertion race was correctly treated as test timing, not an app defect.

These checks do not constitute a complete screen-reader audit or cross-browser certification. Companion import/export compatibility was not reviewed because that source is inaccessible in this session; see `INTEGRATION.md`.

## Exact final reviewed source

Parent SHA-256 verification matched the independent reviewer’s final snapshot:

```text
7db1fb8707354c677f0a8a7796df628e80f80a0026ec41b322e1a3260b5971d0  core.js
61bb472cb63d5dc967d4d2cb939fc622b9d9faf5d6358565fc39dd6efa60092d  app.js
3066d74a5b0aed47b852ff9fe243c0668229eca11b2654ee75bfae971b61d9f1  index.html
0c9621ddab65452928b033a7f80b7b0b325c6cf49272daddf9e5c46224795bf5  styles.css
```

The parent’s final full test run, source/package browser results, packaging check, and preservation evidence are recorded in `CHECKS.md`.
