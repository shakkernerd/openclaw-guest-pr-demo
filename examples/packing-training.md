# Mixed-readiness warehouse training handoff

**Synthetic training data only; none of these are real delivery destinations.**
Source: [dispatch-training.json](dispatch-training.json). Generated handoffs:
[CSV](packing-training.csv) · [printable HTML](packing-training.html).
The ready-only examples remain unchanged.

## Reproduce from the repository root

These POSIX-shell commands preserve the expected nonzero status, even with
`set -e`. Generate both exports from the JSON; do not edit the generated files.

```sh
status=0
node packing-quality.js examples/dispatch-training.json || status=$?
echo "checklist exit: $status"  # 1

status=0
node packing-quality.js --csv examples/dispatch-training.json > examples/packing-training.csv || status=$?
echo "CSV exit: $status"  # 1

status=0
node packing-quality.js --html examples/dispatch-training.json > examples/packing-training.html || status=$?
echo "HTML exit: $status"  # 1
```

Exit **1** means validation anomalies: all three reports are produced, with no
stderr diagnostic for this fixture. It is not an export failure or dispatch
approval. For other statuses and incomplete-output handling, use the
[exit-code essentials](../README.md#exit-codes) and
[safe-output reference](../packing-reference.md#error-examples-and-exit-codes).

## Read the handoff

```text
Parcels: 4 | Items: 10 | Ready: 1 | Needs attention: 3
Ready-to-dispatch items: 3
Anomalies (4)
Result: NEEDS ATTENTION
```

All four packed counts are valid: **3 + 2 + 1 + 4 = 10** counted items (not a
partial total). Only the first parcel contributes to the **3 ready items**.
Duplicate-ID entries remain in the totals and exports; 10 is a count of recorded
items, not proof of 10 distinct physical items. CSV has a header plus four rows
in JSON order, with no totals row. HTML shows the summary and each parcel's checks.
**HOLD** below means the tool's `NEEDS ATTENTION` result, not a separate CLI status.

| Parcel / JSON entry | Packed / ordered | Result and training action |
| --- | --- | --- |
| 1 / `parcels[0]`: `00042`, O'Neill, Zoë | 3 / 3 | READY: recorded checks pass; warehouse reviewer still verifies the physical parcel and signs off. |
| 2 / `parcels[1]`: `E10-TRAIN-02`, André D’Essai | 2 / 3 | HOLD: count mismatch and `sealed: false` are two separate anomalies. |
| 3 / `parcels[2]`: `E10-TRAIN-DUP`, 山田・サンプル | 1 / 1 | HOLD: first occurrence of the duplicate ID. |
| 4 / `parcels[3]`: `E10-TRAIN-DUP`, Mina Exemplo | 4 / 4 | HOLD: second occurrence of the same ID. |

**Both duplicate occurrences must be held**, even though all their packing/label
confirmations are true. Neither is the preferred or automatically accepted copy.
The four anomalies are the count mismatch, the unconfirmed seal, and one ID issue
on **each** duplicate entry.

## Next actions in the training exercise

1. **Packer:** hold parcel 2, recount against its order allocation, resolve the
   missing item or verified source-record error, then seal and recheck it. Update
   counts/confirmations only to reflect physical evidence, not to force a pass.
2. **Dispatch lead:** hold parcels 3 **and** 4. Compare physical labels, recipients
   and order records to establish whether these are two parcels with a reused ID
   or a duplicated record. Assign verified unique IDs to distinct physical parcels
   and correct any duplicate record only after reconciliation; do not blindly
   renumber or delete a row.
3. **Warehouse reviewer:** compare the corrected report with the parcels and
   orders, verify labels/checks, and record the physical sign-off. A single READY
   parcel does not approve this mixed batch. Work on a copy of the JSON so this
   failing training fixture stays reproducible; rerun the CLI and regenerate the
   handoffs after corrections. Require exit 0 and physical sign-off before release.

## Cleared follow-through: before and after

The separate [cleared JSON](dispatch-training-cleared.json) records the supplied
synthetic physical-check facts: parcel 2 now has all **3 ordered items** and is
sealed; parcels 3 and 4 are distinct physical parcels with verified IDs
`E10-TRAIN-03` and `E10-TRAIN-04`. These are exactly four field changes.
Recipients, addresses, every other count and every other confirmation are unchanged.
The original failing JSON and its CSV/HTML exports remain byte-for-byte intact.

| Snapshot | Parcels | Counted items | Ready parcels / items | Anomalies | CLI exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original failing | 4 | 10 | 1 / 3 | 4 | 1 |
| Cleared | 4 | 11 | 4 / 11 | 0 | 0 |

The added item raises the total to **3 + 3 + 1 + 4 = 11**. The mismatch, unconfirmed
seal and both duplicate-ID issues are now resolved, so no parcel needs attention.
All recorded checks pass under the **unchanged validation policy**; this is a
training record of the supplied checks, not automatic real-world dispatch approval.

Generated cleared handoffs: [CSV](packing-training-cleared.csv) ·
[printable HTML](packing-training-cleared.html). Reproduce from the repository root:

```sh
node packing-quality.js examples/dispatch-training-cleared.json
# Exit 0: READY, 4 parcels, 11 counted items and 11 ready-to-dispatch items.
node packing-quality.js --csv examples/dispatch-training-cleared.json > examples/packing-training-cleared.csv
# Exit 0; four READY rows, empty anomaly cells, original parcel order.
node packing-quality.js --html examples/dispatch-training-cleared.json > examples/packing-training-cleared.html
# Exit 0; all checks passed, no anomalies.
```

## Check text handling before handoff

The first street is ordinary address text, not markup:
`Via Esempio 12, <front desk> & "Scala B"`. The browser should display that literal
text. In the generated HTML source it is escaped as:

```html
Via Esempio 12, &lt;front desk&gt; &amp; &quot;Scala B&quot;
```

CSV keeps `<front desk>` and `&` as text, and doubles embedded quotes inside the
quoted street cell: `"Via Esempio 12, <front desk> & ""Scala B"""`. Confirm the
recipient `O'Neill, Zoë` stays in one cell and the Japanese/Portuguese text survives.
Import **ID and postcode as Text before loading**, preserving `00042` and `00123`;
CSV quoting is not type protection. Follow the canonical
[Text import guidance](../packing-reference.md#import-id-and-postcode-as-text-preserve-leading-zeros).
HTML escaping is distinct from [CSV formula protection](../packing-reference.md#formula-protection-separate-from-column-types);
neither replaces those import settings. Use the [print guidance](../packing-reference.md#printable-html-handoff)
to preview the HTML pages before printing, especially the duplicate-ID HOLD actions.
