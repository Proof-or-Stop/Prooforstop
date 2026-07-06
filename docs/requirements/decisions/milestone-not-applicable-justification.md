# Decision: gate milestone `not_applicable` behind an auditable justification

- Story: B-f7b3 (milestone-observability hardening), checklist item CHK-007
- Status: decided
- Closes: findings M4 caveat (zero-evidence self-exemption via `not_applicable`)

## Problem

`normalizeMilestone` in `packages/main/src/core/proofstory.ts` validates a
milestone `status` against `VALID_MILESTONE_STATUSES` only. Any row can be written with
`status: 'not_applicable'` with no rule asserting the row is genuinely inapplicable.
That status then:

- short-circuits the uncovered-required-milestone gate check in
  `evaluateDoneIntentEquivalence` (in `proofstory.ts`, which skips `not_applicable` rows
  from the uncovered-required check), and
- is treated as `complete` and rendered in the completed group by the milestone-status
  report (`packages/main/src/core/milestone-status.ts`).

So `not_applicable` is a **zero-evidence self-exemption**: an agent can silently exempt a
required milestone from DONE-intent-equivalence with no auditable reason and no human record.

## Decision

Require an auditable `notApplicableDecision` on every `not_applicable` milestone row,
mirroring the existing, already-shipped precedent for parent-roadmap rows
(`packages/main/src/core/parent-roadmap-totality.ts`: `ParentRoadmapNotApplicableDecision`
+ `validNotApplicable`).

The decision operates at **two altitudes**: a structural field on the row, plus a
DONE-gate policy diagnostic. It is deliberately **not** a hard throw on absence — an
absent decision is a diagnostic gap, so the read/build path never throws for a
missing (only a *malformed present*) decision.

New shared field on `MilestoneLedgerItem` (`packages/main/src/core/types.ts`):

```ts
export interface MilestoneNotApplicableDecision {
  reason: string;     // non-empty scope reason
  decidedBy: string;  // human / agent identity of record
  decidedAt: string;  // ISO timestamp
}
// on MilestoneLedgerItem:
notApplicableDecision?: MilestoneNotApplicableDecision;
```

Rules:

1. **Structural (normalize altitude).** In `normalizeMilestone`, `notApplicableDecision`
   is **optional**. When the field is **present** it must be an object with non-empty
   `reason`, `decidedBy`, and `decidedAt`; a malformed present shape throws a structural
   error (via `normalizeNotApplicableDecision`). When the field is **absent** it is left
   off the row and **nothing is thrown** — for any status, including `not_applicable`.
   This keeps existing ledgers readable and makes the policy (below) the single place a
   missing exemption is surfaced.
2. **Hash backward-compatibility.** `notApplicableDecision` is attached to the row object
   **only when present**, so a row without a decision keeps the exact same object shape —
   and therefore the exact same `computeMilestoneLedgerHash` output — as before this field
   existed. Existing confirmed ledgers (e.g. B-f7b3's own
   `sha256:68173e86…`) remain valid and unchanged. When a decision *is* present it
   participates in the hash like every other row field, so changing a justification changes
   the ledger hash and drops a `confirmed` ledger back to `candidate` (existing behavior in
   `buildMilestoneLedger`) — the exemption cannot be back-edited under a frozen confirmed
   ledger without re-confirmation.
3. **Policy (DONE-gate altitude).** In `evaluateDoneIntentEquivalence`, a `not_applicable`
   row still self-exempts from the uncovered-required-milestone set, but a row that lacks a
   **valid** `notApplicableDecision` (checked by `validMilestoneNotApplicable`) emits a
   `not_applicable_missing_decision` diagnostic gap (severity `fail`). Under `enforce` mode
   this blocks DONE. This is where an unjustified exemption is caught — a diagnostic gap,
   never a hard throw in the read path.

## Contract preservation (explicitly not weakened)

- **PLAN-only write path**: the field is set through the same `milestone_ledger_add` /
  `buildMilestoneLedger` PLAN-phase path; no new write surface, no runtime/DONE-phase write.
- **Hash-bound**: field participates in `computeMilestoneLedgerHash`; confirmed→candidate
  demotion on any change is preserved.
- **Intent-collision-confirmed**: `acceptedIntentBinding` is retained only while
  `existingHash === ledgerHash` (in `confirmMilestoneLedger`); adding/altering a justification changes the hash and
  therefore requires re-binding, exactly as for any other row edit.

## Rejected alternatives

- **Free-form policy flag with no fields** — rejected: still zero-evidence; nothing to audit.
- **Human-only approval (approvedBy/approvedAt/revisitTrigger like `deferral`)** — heavier
  than needed for CHK-007; the parent-roadmap `notApplicableDecision` triad
  (reason/decidedBy/decidedAt) is the established, lighter precedent and is sufficient to
  remove the self-exemption. Revisit if a human-gate requirement is later added.
- **Reason on a separate side-file** — rejected: would not be hash-bound to the row and could
  drift from the ledger.

## Backward compatibility

Existing ledgers stay readable. Because the field is optional at normalize time and is only
attached to the row when present, a ledger with `not_applicable` rows that carry **no**
decision still parses and — critically — hashes **identically** to before this change (a row
without the field is byte-for-byte the same object it was, so `computeMilestoneLedgerHash` is
unchanged). Confirmed ledgers such as B-f7b3's
`sha256:68173e86acd0f275fc8788a7ee1f577a5446e922904285147db66aeed7fd5c8e` remain valid.

The unjustified exemptions this item closes are surfaced not as a read-path throw but as a
DONE-gate `not_applicable_missing_decision` diagnostic gap (severity `fail`, blocking under
`enforce`). Migration for an author who wants such a row to pass DONE = add the justification
triad (`reason` / `decidedBy` / `decidedAt`) to each such row; doing so changes the ledger
hash and requires re-confirmation, exactly as for any other row edit.
