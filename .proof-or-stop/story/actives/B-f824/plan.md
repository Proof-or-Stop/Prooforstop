# Plan: B-f824 Stop reviewer independent validates from poisoning done_prepare convergence

Design chosen in decision.json: **A-phase-anchored-split** — inside
`deriveDonePreparePassConvergence`, split suite-execution counting the same way
reviewer re-attestation is already split (observable vs blocking, boundary =
`facts.testEntryAt`, comparison `>=`):

- `unchangedSuiteExecutions` (blocking, asserted to 0): per identity group
  `max(0, postTestExecutedCount - 1)` where postTest = executed terminals with
  `timestamp >= facts.testEntryAt` and `commandExecutions > 0`, **plus** every
  reused terminal with `commandExecutions > 0` in any phase (contradictory record).
- `reviewWindowSuiteExecutions` (observable, never asserted): per identity group
  `max(0, totalExecutedCount - 1)` across the whole window — today's number,
  demoted to telemetry.

## CHK-001: Add smoke repro of review-window execution poisoning and the new pass/fail boundary

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts
- Test: packages/main/src/tasks/flow-stability-smoke.ts (self)

**Verify**:
- Before the CHK-002 fix: the new B-956f-shaped case FAILS (convergence assert throws on
  pre-TEST reviewer executed + one post-TEST closeout executed in same group).
- After CHK-002: `npm --prefix packages/main run build && node bin/lattice.js validate --json`
  green; the case passes.

**DoneWhen**:
- A test case replays the B-956f window shape with synthetic validation_terminal facts:
  (1) executed cmdSet=X pre-TEST (REVIEW phase), (2) executed cmdSet=Y pre-TEST,
  (3) executed cmdSet=X post-TEST, (4) reused exec=0 post-TEST → derive must yield
  blocking `unchangedSuiteExecutions=0`, observable `reviewWindowSuiteExecutions=1`,
  and `assertDonePreparePassConvergence` must NOT throw.
- A companion case with TWO post-TEST executed terminals in one group asserts
  blocking=1 and assert throws.
- A companion case with reused + commandExecutions>0 (pre-TEST phase) asserts assert throws.
- Timestamps are derived relative to the case's `testEntryAt`, not wall clock.

## CHK-002: Split convergence counting into blocking post-TEST duplicates and observable review-window telemetry

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/done-prepare.ts

**Verify**:
- `npm --prefix packages/main run build` clean.
- CHK-001 cases pass; existing flow-stability convergence cases updated where semantics
  intentionally changed (each such change annotated with a comment naming B-f824).

**DoneWhen**:
- `DonePrepareConvergence` type (done-prepare.ts:205 area) gains
  `reviewWindowSuiteExecutions: number`.
- `deriveDonePreparePassConvergence` computes both counters per the design above,
  using `facts.testEntryAt` with `>=` (same convention as postTestReviewerIdentityIds).
- `assertDonePreparePassConvergence` still asserts `unchangedSuiteExecutions !== 0`
  (blocking semantics) and does NOT assert the observable field.
- Render line (:1666 area) appends `reviewWindowSuiteExecutions=N`.
- Transcript JSON parser regex (:1077-:1097) parses the new line shape and emits the
  new field; older transcripts without the field must not crash the parser
  (backward-tolerant match or explicit versioned regex).

## CHK-003: Update downstream smoke assertions and process-fact documentation to the split semantics

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/tasks/done-prepare-merge-rerun-smoke.ts (:333, :496)
- Modify: packages/main/src/tasks/done-prepare-auto-closeout-smoke.ts (:367, :1211)
- Modify: packages/main/src/tasks/done-prepare-closure-heartbeat-smoke.ts (:672, :687)
- Modify: packages/main/src/core/process-fact-registry.ts (runtime:closeout_validation_terminal
  entry, only if its prose describes the old counting)
- Verify-only: scripts/verify-process-fact-contract.mjs

**Verify**:
- `rg -n "convergence: metadataRollbacks=" packages/main/src` shows every strict regex
  updated to the new line shape (no stale matcher silently non-matching).
- `npm run test:process-fact-contract` green.
- `node bin/lattice.js validate --json` green from the story worktree.

**DoneWhen**:
- Every enumerated regex matches the new render line including
  `reviewWindowSuiteExecutions=`.
- No smoke asserts the observable field to 0 in scenarios where reviewer-driven
  executions are part of the fixture (they assert the blocking field instead).
- Registry prose (if touched) describes phase-anchored split counting.

## CHK-004: Update the B-c163 convergence contract prose in the three decisions docs to the phase-anchored split

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Scope note (OQ-1 resolution, PLAN round 3)**: the scope reviewer verified the stale
sentence ("...repeated unchanged-suite execution, and unsuccessful-closeout constraints
remain independently blocking") exists ONLY in
`done-prepare-automation-execution-plan.md:734`. The other two docs named in the frozen
CHK-004 context (`workflow-convergence-failure-remediation-execution-plan.md`,
`done-prepare-heartbeat-review-assurance-ux-execution-plan.md`) carry a
"B-c163 convergence contract (implemented)" section that never mentions suite-execution
counting — they need NO edits, and injecting new `reviewWindowSuiteExecutions` prose into
them would be scope creep. The item title says "three decisions docs": satisfy it by
verifying all three (rg audit) while rewriting only the one doc that is actually stale.

**Files**:
- Modify: docs/requirements/decisions/done-prepare-automation-execution-plan.md
- Verify-only (no edits): docs/requirements/decisions/workflow-convergence-failure-remediation-execution-plan.md,
  docs/requirements/decisions/done-prepare-heartbeat-review-assurance-ux-execution-plan.md

**Verify**:
- `rg -n "remain independently blocking" docs/requirements/decisions/` shows only prose
  consistent with the phase-anchored split (or updated wording).
- `rg -ln "unchangedSuiteExecutions|reviewWindowSuiteExecutions" docs/requirements/decisions/`
  lists only done-prepare-automation-execution-plan.md (the other two stay silent on
  suite-execution counting).
- docs-drift preflight stays green.

**DoneWhen**:
- done-prepare-automation-execution-plan.md states: `unchangedSuiteExecutions` blocks only
  on per-group duplicate executed terminals at or after the current TEST entry plus
  contradictory reused terminals with `commandExecutions > 0`;
  `reviewWindowSuiteExecutions` records whole-window per-group duplicates as observable,
  non-blocking telemetry.
- The rewritten prose stays consistent with the sibling
  reviewerReattestations/postTestReviewerReattestations split documentation in that doc.
- The other two docs are verified untouched by `git diff` (no injected prose).
