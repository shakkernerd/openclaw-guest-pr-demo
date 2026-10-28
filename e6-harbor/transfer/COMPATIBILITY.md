# Scheduling compatibility review

Reviewed target: [PR #23](https://github.com/shakkernerd/openclaw-guest-pr-demo/pull/23), exact head **5cf53e2dbeffc45727577f4fe653b1404098dd90**. All challenges use synthetic data. No colleague source, PR, comment or earlier repository file is modified.

## Verdict

**The standalone transfer workflow works; end-to-end scheduler interoperability does not exist yet.** Equal numeric version values are not a compatibility guarantee. The ten executable compatibility checks establish the gaps below; their passing result must not be reported as successful integration.

## Concrete findings

1. **Native JSON is incompatible in both directions (integration blocker).** Scheduler `core.js:76–78` requires top-level `assignments`. Companion `rota.mjs:20–22` accepts exactly `version/volunteers/shifts` and embeds crew in `shift.volunteerIds`. Feeding the scheduler's actual `demo()` snapshot to the companion yields an unsupported `assignments` error; feeding the companion's actual JSON export to the scheduler validator yields “Unrecognized rota data”. Rejection leaves an unexported companion correction unchanged. Scheduler storage also rejects a companion-shaped replacement before writing.
2. **A shared-field projection is not a safe round trip (integration blocker).** Names/IDs, dates/times, shift roles and volunteer-to-shift links can be represented in both. A test-only projection of the scheduler demo round-trips those common values through actual companion CSV and JSON. It necessarily omits volunteer `roles/availability/notes`; shift `title/required/notes`; and assignment IDs. Companion v1 has nowhere to retain them, and unknown fields are rejected. Availability means recurring weekday windows, Monday=0 through Sunday=6, one continuous window per day; an empty list means unavailable, not unrestricted. No adapter is shipped.
3. **Scheduler safety constraints cannot be reconstructed from companion data (integration blocker).** `core.js:60–74,86–94` checks eligibility, full-window availability, crew capacity, duplicate links and strict overlap. Companion transfers structurally valid links but does not implement those safety rules. Tests prove removing a used qualification or availability from a real scheduler fixture is rejected. A bridge must require truthful missing information, not invent universal availability/qualifications or infer capacity from currently assigned crew. Back-to-back shifts remain allowed.
4. **Accepted value ranges differ (explicit mapping/rejection needed).** Scheduler names/titles are limited to 80 characters, roles are exactly Dock lead / Launch crew / Shore support, capacity is 1–20, and dates are bounded to 1900-01-08…9999-12-20. Companion names/roles may be longer, roles are free text, and dates span 0001…9999. Scheduler accepts IDs such as `crew 青井` that companion IDs reject. Actual validator calls reproduce these differences. Both use same-day harbor-local HH:mm, which is a useful alignment to keep.
5. **Naively combining envelopes can hide conflicting assignment representations.** Scheduler `validateState` allows unknown keys; a valid scheduler snapshot with an added contradictory `shift.volunteerIds: ["missing-person"]` still validates. Its actual `assignments` remain authoritative. This is a future bridge hazard, not a claim of an existing UI import bug: there is currently no such bridge. Choose one explicit versioned representation and reject ambiguous dual payloads.
6. **Persistence and launch routes are separate.** Scheduler `storage.js:6,24–37` owns `e6-harbor.rota.v1` and protects stale/corrupt saved data. Companion uses tab memory and explicit downloads; its allowlisted loopback server serves only `transfer/`. Serving both on one origin would not connect their data. Never overwrite the scheduler's storage key with a companion archive.
7. **One predictable integration conflict is documentation.** Both branches add `e6-harbor/README.md`. Resolve that add/add conflict by combining useful coordinator instructions, not selecting an entire side. This branch does not copy or replace the scheduler's core, UI, storage, build or tests.

8. **There is no scheduling-side file transfer surface.** The independent reviewer inspected and ran the full pinned app. `index.html:10–12` loads only core/storage/app; `app.js:107–169` provides scheduling CRUD, not file handlers. There is no CSV parser/serializer, JSON import/export UI or live-state replacement entry point. The tested companion upload is safe rejection, not working integration.
9. **Unknown-field acceptance is not reliable metadata preservation.** The scheduler accepts and persists extension fields, but upsert replaces edited records (`core.js:110–115`), and the UI reconstructs known volunteer/shift fields (`app.js:153,159–160`). An actual known-field replacement drops that record’s extension metadata while retaining root and untouched-record extensions. Hiding missing interchange fields inside arbitrary extras would therefore be unsafe. This is a future bridge constraint, not a request to change the colleague’s PR.

## Evidence and reproduction

The public PR read confirms the exact head above and includes complete added-file patches for `core.js` (166 lines) and `storage.js` (43 lines). Those complete hunks were extracted without modifying code, with line-count checks. The checked script refuses mismatched source bytes:

- `core.js` SHA-256: `7db1fb8707354c677f0a8a7796df628e80f80a0026ec41b322e1a3260b5971d0`
- `storage.js` SHA-256: `031957939e65bddaaf14150df5f60d0b7452332e93fe1602f5f190b96b1494ea`

Run against an independently obtained checkout at that commit (do not copy scheduler files into the companion's runtime):

```sh
node e6-harbor/transfer/compatibility-check.mjs /path/to/pinned-scheduler/e6-harbor
```

Result: **10/10 passed**. This includes both native-schema rejections, atomic rejection, common-field lossless encoding versus metadata loss, unsupported metadata rejection, ID/text limits, role/date differences, required scheduling constraints, ignored hybrid links, protected scheduler persistence and extension loss on record replacement.

For a real companion-browser upload of an actual scheduler snapshot, generate `JSON.stringify(Core.demo())` from that pinned core and pass its file path:

```sh
SCHEDULER_SNAPSHOT=/path/to/synthetic-scheduler-snapshot.json node e6-harbor/transfer/browser-check.mjs
```

The extra check requires an unsupported-assignment error, error focus, no replacement preview, and unchanged exported data after unsaved corrections. The following checks exercise the previous undo checkpoint too. It is a safe-rejection check, not an import bridge.

### Full-app independent review

A separate reviewer obtained a managed checkout of the **full actual scheduler**, not reconstructed UI code. HEAD was `5cf53e2dbeffc45727577f4fe653b1404098dd90` before and after; tracked and staged trees remained clean. The parent’s public PR read also confirmed that exact head. Parent direct Git fetch was unavailable because sandbox DNS could not resolve GitHub; the full-app findings below come from the reviewer’s prepared checkout, while parent compatibility checks execute the complete pinned core/storage modules described above.

On Node v24.22.1 and installed Chrome for Testing 156.0.8078.4, the independent reviewer executed:

| Command in scheduler checkout | Actual result |
| --- | --- |
| `node --test e6-harbor/tests/core.test.js e6-harbor/tests/storage.test.js` | 26/26 passed |
| `node --test` | 29/29 passed, including 3 original repository tests |
| `node e6-harbor/scripts/build.cjs` | Passed; 5 assets packaged byte-for-byte |
| `node e6-harbor/scripts/browser-check.cjs` | 22/22 source-app checks passed |
| `HARBOR_APP_DIR=e6-harbor/dist node e6-harbor/scripts/browser-check.cjs` | 22/22 built-app checks passed |
| `node e6-harbor/artifacts/compatibility-review.cjs` | 11 diagnostic checks passed (reviewer-local artifact, not shipped here) |

Browser runs exercised actual forms, rejected/accepted changes, assignment changes, reload persistence, protected storage, keyboard behavior, 320/360px layouts and offline operation; no page exceptions, console errors or network requests were reported. The reviewer inspected desktop/mobile/conflict/editor screenshots. This is not a full accessibility or cross-browser audit.

The parent also ran the complete companion browser suite with the actual pinned scheduler demo snapshot: focused unsupported-field rejection preserved unsaved corrections and the previous undo checkpoint. Companion `node --test` separately passed 29/29; `validate.mjs` passed syntax, documentation-link, example and live HTTP checks. These are separate checkouts, not a combined-suite integration pass.

### Earlier independent transfer review

The transfer reviewer approved the exact runtime now retained in this branch after reproducing and rechecking two fixes: no-op saves/imports no longer replace meaningful undo, and oversized JSON/CSV exports no longer create archives above the reimport limit. Independent checks included exact 2,097,152-byte boundaries, the original large CSV-to-JSON case, the reverse JSON-only case, invalid edits, dirty/cancelled imports, delayed-read races and native keyboard edit/remove/undo. No remaining reproducible blocker was found in that bounded transfer scope. The coordinator guide and compatibility diagnostics were added afterward without changing that app/core runtime.

## Preserve these scheduling strengths in a future combination

Keep copied-state whole-snapshot validation, recurring availability, explicit qualifications/capacity, strict overlaps with back-to-back allowance, actionable rejection messages, stable assignment identity, and storage protection. Retain the weekly/coverage UI and its keyboard-safe workflow rather than replacing the scheduler with a file editor. Agree a full-fidelity versioned contract first; add a previewed, transactional adapter with deliberate unsupported-field handling; then independently test both directions, original scheduling invariants, memory/storage atomicity, empty/unassigned entities and archive capacity. No integration implementation or publication is authorized by this review.
