# Copy-week local verification

2026-10-28. This follow-up is **local only**, awaiting the user’s inspection. No push, commit, publication, or PR update was performed for this feature. Companion integration is deferred until the colleague provides a readable transfer PR.

## Behavior

- Copy all shifts in the selected Monday–Sunday week exactly seven calendar days forward, including filtered-out shifts. The original records and unrelated destination work remain unchanged. Titles, roles, times, capacities and notes are preserved; copied shifts and assignments receive fresh IDs.
- Explicit choice: **Shifts only** by default, or **Shifts and assignments** with full-state eligibility/overlap validation. Exact back-to-back assignments remain valid.
- Matching work is destination date + start/end + role + title normalized for case, whitespace and Unicode NFC. Capacity or notes changes do not bypass detection. Persisted destination duplicates and duplicate source work have distinct, actionable errors.
- Build the full result before one storage write. Invalid dates, references, assignments or duplicate work reject the entire copy. Quota/stale/protected/unavailable storage also leaves the copy unapplied in memory and keeps its dialog open.
- The dialog shows source/destination dates and existing destination count. It starts on a safe heading, supports native radio arrow keys, contains forward/reverse Tab, restores focus on cancel/success, prevents auto-repeat Enter confirmation, and scrolls vertically at 320px.

## Checks actually run against final local source

| Command / inspection | Result |
| --- | --- |
| `node --test e6-harbor/tests/copy-week.test.js` | 12 passed; 0 failed/skipped |
| `node --test` | 41 passed: 38 app tests + 3 original tests; 0 failed/skipped |
| `node e6-harbor/scripts/build.cjs` | 5 local assets verified and packaged byte-for-byte; SHA-256 manifest generated |
| `node e6-harbor/scripts/browser-check.cjs` | 30/30 passed against source |
| `HARBOR_APP_DIR=e6-harbor/dist node e6-harbor/scripts/browser-check.cjs` | 30/30 passed against the packaged app |
| Browser network/error collection | Zero app network requests, console errors or page exceptions in final runs |
| SHA-256 preservation check | All 7 original repository files unchanged |

No dependencies or browsers were downloaded. Checks use the existing Node.js/Chromium and a disposable offline browser profile. The package remains a directly openable static folder.

## Real rendered scenarios

The shared browser runner invokes `scripts/copy-week-scenarios.cjs`; it uses the actual forms and native keyboard events, not a mock UI. Fixtures are installed only into disposable test profiles. Eight copy-specific groups supplement the existing 22 checks:

1. Whole-week copying despite a role filter; explicit safe default; opening, repeated Enter and cancellation do not save. Forward/reverse Tab and 1280px/360px/320px layouts.
2. Keyboard carry into a populated week: Maya’s copied 08:00–10:00 and 10:00–12:00 duties are back-to-back with the existing destination 12:00–13:00 handover. Original records remain exact. Reload preserves both weeks; revisiting the destination restores the identical rendered schedule.
3. Existing matching work late in the destination week rejects every proposed copy even with changed capacity/notes. Full stored bytes and source schedule remain unchanged after reload.
4. Destination 09:30–10:30 handover blocks carrying Maya; shifts-only retry succeeds from the same dialog. Nia remains unavailable for the copied Monday duty; forcing that disabled option still cannot create an invalid assignment. Availability is recurring weekly: moving a valid source assignment by seven days alone cannot make its weekday unavailable.
5. Empty weeks, a late invalid copied date, and the final supported source week cannot partially copy. The upper-bound message explains choosing an earlier week, says no changes were applied, and retains focus.
6. Quota failure leaves saved bytes, visible schedule and selected week unchanged; restoring storage allows one successful retry.
7. A newer saved snapshot and corrupt protected data cannot be overwritten by copying.
8. Duplicate source work in an empty destination reports the source conflict rather than claiming nonexistent destination work. Stored bytes and rendered schedule remain unchanged.

Actual desktop, narrow, duplicate, unavailable-volunteer and overlap screenshots were inspected. Screenshots remain local in ignored `artifacts/copy-week-*.png`. A full screen-reader audit and cross-browser certification are not claimed.

## Independent review

The independent reviewer challenged an isolated copy with **11 domain groups** and **17 copy-specific real-Chromium groups**, including fresh ID collisions, chained/retried copies, late rollback, Unicode normalization, seven interval arrangements, leap/year transitions, exact storage-write counts, storage failures, and narrow-screen native keyboard behavior. No blocking scheduling, atomicity, storage or keyboard defect was found.

One P3 finding was reproduced: source duplicates were incorrectly described as existing destination work. Separate persisted-work and tentative-copy maps now produce the correct source-specific guidance. A focused unit regression failed before the fix and passes afterwards. Parent follow-up also reproduced a generic date-overflow error when opening copy at the final supported week; it now gives actionable no-change guidance, covered by a formerly failing real-browser regression.

**Final independent recheck passed: P3 resolved, with no remaining findings in the bounded review.** The reviewer reran 11 domain groups, 6 additional diagnostic/repair cases, and 17 real Chromium scenarios; syntax checks also passed. Source-duplicate and actual destination-collision messages are distinct. The final supported-week activation preserves storage, rendered schedule, selected week and focus while explaining the date limit. Atomic copying, carry conflicts/success, fresh IDs, retries, filtered-out shifts, storage recovery and 320px keyboard behavior remain correct. No page exceptions or nonlocal requests were observed. The reviewer’s five final source hashes exactly match those below.

## Final local source SHA-256

```text
aa87da056758f368d0223a83cdf81a0bd35e14c7126441b8d8f3a73b7e298c6f  core.js
a242715e7965f330656e2282f9e68bdb539303a839c77095216d19ea0bfb30de  app.js
548bb7ecf7eb20b7a0559354cabe74c4b9a3ce7a0cae16e19475dc22c8b17bd5  index.html
399871d0b3d32f558e5e2c27e787d8c87d49dc8b18083de178eadfbf61ac184d  styles.css
031957939e65bddaaf14150df5f60d0b7452332e93fe1602f5f190b96b1494ea  storage.js
```
