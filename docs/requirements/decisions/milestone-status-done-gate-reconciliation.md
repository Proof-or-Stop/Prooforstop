# Decision: Reconcile milestone_status with the designed DONE gate

Status: decided
Story: B-f7b3 (CHK-010)
Source finding: docs/requirements/decisions/milestone-ledger-status-review-findings.md — B-b550 M7 completeness-critic divergences (a) stale-evidence disagreement and (b) closeout second-gate
Date: 2026-07-05

## The two holes

B-b550's completeness critic found two places where the milestone observability
surface and the *designed* DONE gate (`evaluateDoneIntentEquivalence`,
`packages/main/src/core/proofstory.ts`, consumed by the DONE transition at
`packages/main/src/handlers/phase-gates.ts`) gave **contradictory verdicts on the
same ledger**:

- **(a) STALE-EVIDENCE DISAGREEMENT.** `milestone_status` demotes a milestone row
  to `groups.current` with `statusDetail=…; evidence=stale` when its verification
  evidence hash no longer matches the current binding (via `evidenceIsCovering` →
  `evidenceFreshnessRisks`, `packages/main/src/core/milestone-status.ts`). But
  `evaluateDoneIntentEquivalence` resolved milestone coverage through
  `evidenceCoversIntent`, which checked only `result === 'pass'` (or a permanent
  non-failing waiver) and was **completely freshness-blind**. So the same stale
  ledger that `milestone_status` demoted could still PASS the DONE gate — two
  surfaces, opposite verdicts on identical evidence.

- **(b) CLOSEOUT SECOND-GATE.** `captureMilestoneCloseoutSnapshotFromStore`
  (`packages/main/src/handlers/milestone-status.ts`) is invoked from
  `packages/main/src/handlers/transition-orchestrator.ts` inside
  `if (args.phase === 'DONE')` — **after** `actor.send` has already moved the story
  to DONE. It called `buildMilestoneCloseoutSnapshot`, which THROWS on incomplete
  rows or any risk. Because a stale/incomplete ledger throws, closeout acted as an
  **undesigned second DONE gate with throw-semantics** that diverged from
  `evaluateDoneIntentEquivalence`: it could abort a DONE the designed gate had
  already permitted, and it did so *after* the state transition was committed.

## Decision

Strictness lives in the single designed gate; default behavior must NOT newly block.

### (a) Make the DONE gate honor milestone evidence freshness — as a gated, non-blocking diagnostic

- `evaluateDoneIntentEquivalence` now detects milestones whose base coverage
  passes but whose **only** covering evidence is stale, and emits a new
  `stale_milestone_evidence` diagnostic gap (severity `warn`, in
  `packages/main/src/core/proofstory.ts`). Because the report's `blocking`
  is `mode === 'enforce' && gaps.length > 0`, this gap — exactly like every other
  milestone gap — is a **NON-BLOCKING diagnostic under the default `observe` mode
  and only blocks under `enforce`**. No new hard block was added to observe mode.
- Agreement is **by construction**: both surfaces call the same exported predicate
  `evidenceIsStaleCovering` (`packages/main/src/core/milestone-status.ts`).
  `milestone_status` keeps its full-risk demotion; the DONE gate calls the
  predicate with `mismatchOnly = true`.
- **Staleness = mismatch, not absence.** The gate flags a milestone only when a
  *bound* hash genuinely disagrees with the current binding (a `stale <hash> …`
  risk), never when evidence simply *lacks* a binding (a `missing … binding`
  risk). This matches the finding's wording ("evidence hash no longer matches")
  and is the conservative choice: evidence recorded before binding capture is
  unbound, not stale, so it is not newly blocked.
- The current binding is plumbed via a new optional
  `ProofStoryDiagnosticInput.currentEvidenceBinding` computed with the *same*
  `currentMilestoneStatusEvidenceBinding` + `resolveGitCwd` that `milestone_status`
  uses (`packages/main/src/handlers/proofstory.ts`,
  `packages/main/src/handlers/phase-gates.ts`). When absent, freshness is not
  evaluated and base coverage semantics are preserved — the change is opt-in and
  backward-compatible.

### (b) Make closeout a pure snapshot capture, not a second gate

- `captureMilestoneCloseoutSnapshotFromStore` no longer propagates the strict
  builder throw. It now **degrades to a non-throwing `{ status: 'skipped', reason:
  'closeout_snapshot_unbuildable' }`** when `buildMilestoneCloseoutSnapshot` cannot
  build a snapshot (`packages/main/src/handlers/milestone-status.ts`):
  capture what exists, and when the report is incomplete/risky/stale simply record
  that no auditable snapshot was written. The single designed gate
  (`evaluateDoneIntentEquivalence`, which already ran *before* the DONE transition)
  remains the sole authority on whether DONE is allowed.
- **The pure builder stays strict.** `buildMilestoneCloseoutSnapshot`
  (`packages/main/src/core/milestone-status.ts`) is unchanged: it still
  rejects an incomplete/risky report, so CHK-005's "a stale-only status report is
  rejected by buildMilestoneCloseoutSnapshot" negative control still holds. Only
  the DONE-time capture *wrapper* is made non-blocking.

## Why this does not weaken the contract or block existing DONE flows

- **Read-only / PLAN-only milestone contract is untouched.** `milestone_status` /
  `milestone_closeout` remain read-only observers; their args-boundary asserts and
  read shape are unchanged. The reconciliation touches only (a) the DONE gate's
  coverage predicate and (b) the DONE-time capture wrapper.
- **Default (`observe`) behavior does not newly block.** The new gap is severity
  `warn`; under `observe`, `blocking` stays `false`. A DONE that passed before this
  change with the same inputs still passes under `observe`.
- **Currently-passing DONE flows are preserved.** B-b550's confirmed-ledger
  closeout worked; closeout can now only *skip* (never throw), so it cannot abort a
  DONE the designed gate allowed. The intent-hardening smoke's
  `enforce`-mode milestone DONE — whose evidence carries no binding hashes — still
  PASSES, because absent bindings are unbound, not stale (`mismatchOnly` +
  mismatch-vs-missing distinction).
- **Self-referential safety (B-f7b3 uses these same functions at its own DONE).**
  B-f7b3's `doneGateMode` is the default `observe`, so any freshness tightening is
  non-blocking for it. Verified in this worktree:
  `done_intent_equivalence_check --storyId=B-f7b3` → `Blocking: no`; the confirmed
  ledger hash is unchanged (`sha256:68173e86…`). B-f7b3's own milestones are
  *uncovered* (no evidence yet), not *stale*, so no new `stale_milestone_evidence`
  gap is introduced.

## Verification

- New smoke `packages/main/src/tasks/milestone-done-gate-reconciliation-smoke.ts`
  (auto-discovered by `run-all-smokes`) asserts: milestone_status stale-row
  demotion and the DONE gate `stale_milestone_evidence` diagnostic AGREE on the
  same milestone; the diagnostic is non-blocking under `observe` and blocking under
  `enforce`; closeout capture does not throw on a DONE the designed gate allows
  (writes a clean snapshot, skips an unbuildable one); and (regression) a
  genuinely uncovered milestone still blocks under `enforce`.
- `packages/main/tests/milestone-status.test.mjs` updated to assert the reconciled
  contract: the DONE-time capture degrades to a non-throwing `skipped` result on an
  incomplete report while the pure builder stays strict.
- Full suite: `npm --prefix packages/main run build`;
  `node packages/main/dist/tasks/milestone-done-gate-reconciliation-smoke.js`;
  `node packages/main/dist/tasks/proofstory-intent-hardening-smoke.js`;
  `node packages/main/tests/milestone-status.test.mjs`.
