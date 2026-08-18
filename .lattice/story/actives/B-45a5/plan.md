# Plan: B-45a5 Wire the existing item-level withdrawal helper into the two REVIEW-path gates

Decision: **A-wire-existing-helper** (see `decision.json`). The capability is built and tested; it was
never called from production. This story connects it, and proves the connection cannot be forged.

## Standing rules

1. **NEVER key a skip on `item.status`.** The only permitted route is
   `withdrawnChecklistItemIdsFrom(decision)` (`core/proofstory.ts:1622`), which calls
   `decisionAuthorizesWithdrawal` (`:1614`) requiring `decision === 'confirmed' && userConfirmed === true`.
   It takes the DECISION RECORD as input and never inspects a checklist item, so the backing is
   structural. A `status === 'withdrawn'` check ships a gate anyone bypasses by editing one JSON field —
   worse than the bug being fixed.
2. **`core/checklist-status.ts` is a BLOCKED path.** 11 consumers, zero `decisionRef` awareness in 41
   lines. It is the intuitive route and the dangerous one; the execution boundary blocks it mechanically.
3. **Neither gate loosens for anything that is not withdrawn.**
4. Build the unbacked states in CHK-004 by **writing JSON directly** — that is the actual threat model.
   Constructing them only through the validated CLI would make the anti-bypass proof theatre.
5. Serial. CHK-002 and CHK-003 both touch gate logic the RED artifact measures.

## CHK-001: Prove both gates ignore an item-level withdrawal, repro-first

**Owner**: lattice-implementer · **DependsOn**: none
**Files** — Create `packages/main/tests/red/red-b45a5-withdrawal-gates.mjs`; Modify `lattice.config.json`

**Verify**: fails (non-zero) on the pre-fix tree.
**DoneWhen**
- Fixture (mkdtemp, never a real story) taken to REVIEW with one item withdrawn that **shares an
  acceptance binding with a delivered item** — mirroring B-8df9's AB-002. A withdrawn item that shares
  no binding may be skipped for an unrelated reason and would go green on a fix that changes nothing.
- Both refusals OBSERVED: `review_completeness_missing_evidence` naming the withdrawn intents, and
  `has no dispatch/subagent_result evidence`.
- Controls both directions: a fully covered item still passes; a non-withdrawn item with genuinely
  missing evidence is still refused. A BROKEN control exits without drawing any conclusion.
- Registered in `lattice.config.json` so it runs on every validate.

## CHK-002: Wire evaluateReviewCompleteness to the decision-backed helper

**Owner**: lattice-implementer · **DependsOn**: CHK-001
**Files** — Modify `packages/main/src/core/proofstory.ts` (`evaluateReviewCompleteness`, :2084)

**Verify**: CHK-001's completeness rows flip to GREEN; non-withdrawn gaps still reported.
**DoneWhen**
- Intents whose owning item is withdrawn **and authorized by its decision** are not reported as gaps.
- Standing rule 1 holds — grep the diff for `'withdrawn'` string comparisons and show none guard the skip.

## CHK-003: Give the channel gate the same decision-backed skip

**Owner**: lattice-implementer · **DependsOn**: CHK-002
**Files** — Modify `packages/main/src/handlers/validate-channel.ts` (`checkDispatchEvidence`)

**Verify**: CHK-001's channel rows flip to GREEN; dispatch still required for every other item.
**DoneWhen**
- `checkDispatchEvidence` currently has zero status awareness — it needs the decision plumbed in. Do not
  take a shortcut through `item.status` because the decision is not already in scope; plumb it.
- An `exemptedItems` concept already exists (`validate-channel.ts:336-338`, rendered
  `plan.md Owner=main-agent exempted: ...`). Decide whether withdrawn joins it or renders as its own
  line — that is `understanding.json`'s open unknown. The operator transcript in `understanding.outcome`
  shows `withdrawn (SD-xxxxxxx): CHK-004`; match it or state why you diverged.

## CHK-004: Prove an unbacked withdrawal skips nothing

**Owner**: lattice-implementer · **DependsOn**: CHK-002, CHK-003
**Files** — Modify `packages/main/tests/red/red-b45a5-withdrawal-gates.mjs`

**DoneWhen** — each still REFUSED by **both** gates:
- `status: "withdrawn"` with no `decisionRef`
- a `decisionRef` naming a decision that does not exist
- a `decisionRef` naming a real decision that does **not list that item**
- a decision overwritten to `decision: "rejected"` / `userConfirmed: false` (CLI-reachable: a second
  `scope_shrinkage_decision_set` call overwrites those fields while the union logic preserves
  `withdrawnChecklistItemRefs`)

A naive `status === 'withdrawn'` implementation must FAIL this item. If it would pass, the cases are too weak.

## CHK-005: Delete the three obsolete B-8df9 waivers

**Owner**: main-agent · **DependsOn**: CHK-002, CHK-003
**Files** — B-8df9's `checklist.json` via CLI (worktree `.worktrees/B-8df9`)

**DoneWhen**
- B-8df9 `CHK-004:happy:0 / edge:0 / adversarial:0` carry zero `kind=waiver` rows.
- Both B-8df9 gates pass with none present.
- Run from **B-8df9's own worktree with its own session id** — the CLI enforces a per-story cwd gate and
  an owner lease. Expect a re-attestation round there regardless, since main will have moved.
- Nothing else in B-8df9's evidence is altered.

## Dependency graph

```
CHK-001 ── CHK-002 ── CHK-003 ── CHK-004
                 └────────┴───── CHK-005
```

## Parallelism

None. CHK-002/003 both change gate logic that CHK-001's artifact measures, and CHK-004 must run against
both fixes in place.
