# Transfer companion alignment — inspection status

The requested companion is `openclaw/e6-g2-harbor-transfer`, path `e6-harbor/transfer/`. **Its schema has not been inspected in this session. Compatibility is unverified.**

Read-only attempts on 2026-10-28 established:

- This isolated checkout has only `openclaw/e6-g1-harbor-rota`; the companion ref is absent and no remote is configured.
- Reading or contacting the supplied colleague chat is denied by session-tree visibility.
- The available GitHub reader accepts issue/PR/commit/job URLs, not branch-directory URLs. A read-only repository PR search for `harbor` returned no result at inspection time.

No companion checkout, branch, file, commit, or PR was modified. A source snapshot of its schema/validator and example export (or a readable published commit/PR URL) is needed to replace this blocker with an observed field-by-field comparison. Do not infer schema equality from the shared folder name.

## Scheduling-side contract to compare

These are **alignment questions**, not findings about the unseen companion:

| Area | Rota contract / required alignment |
| --- | --- |
| Envelope | Numeric `version: 1`; arrays `volunteers`, `shifts`, `assignments`. Is the companion using this envelope or its own format/version? |
| IDs and references | Stable string IDs unique within collections; explicit assignment `id`, `shiftId`, `volunteerId`. Preserve identity and reject missing references. |
| Roles | Exact strings `Dock lead`, `Launch crew`, `Shore support`; volunteer `roles` array and one shift `role`. Confirm mappings rather than silently inventing qualifications. |
| Availability | Repeating weekday windows `{day,start,end}`, 0=Monday through 6=Sunday, at most one continuous window per day. Empty means unavailable. Determine whether the companion uses dates, Sunday-based indices, split windows, or an unrestricted default. |
| Shift fields | `{id,title,date,start,end,role,required,notes}`. `required` is integer crew capacity 1–20; not an assignment list or role-count map. |
| Time meaning | Calendar `YYYY-MM-DD` within 1900-01-08 through 9999-12-20, same-day zero-padded `HH:mm`, harbor-local wall clock. No UTC conversion or overnight shifts. |
| Overlap | Strict half-open intersection, same date: `a.start < b.end && b.start < a.end`; exact back-to-back boundaries allowed. |
| Validation | Validate the entire mapped snapshot before replacing data. Enforce qualification, full-window availability, no duplicate/overlapping assignments, and no overcapacity. Rejected imports must leave both memory and persistent state intact. |
| Text and unknown fields | Names/titles max 80; notes required as strings max 500. `validateState` does not strip unknown fields; an adapter should deliberately select supported fields. |
| Storage and ownership | Rota owns `e6-harbor.rota.v1`. Do not assume the companion uses the same key or may overwrite it directly. Define one save boundary and recoverable preview/confirmation flow. |
| Modules | Rota core is a browser global/CommonJS module, no dependencies. Determine whether the companion expects ESM, a different global, or direct localStorage access. |

## Before integrating

Agree on one versioned canonical contract or a loss-aware adapter; do not overwrite either implementation. Add round-trip fixtures, version rejection, role/day mappings, exact-boundary cases, duplicate/missing references, overcapacity, and whole-snapshot rollback tests. Confirm that any data the companion supports but the rota cannot represent is explicitly rejected or reported, never silently dropped. Integration is intentionally deferred; this contribution adds no transfer code.
