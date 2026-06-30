# Parent Roadmap Intent Totality Gate Execution Plan

Status: implemented local read-only diagnostic/evaluator surface for the
parent-roadmap totality contract. The shipped boundary covers CLI status and
evaluation commands, a pure rollup evaluator, claim wording consumer,
ProofStory-binding diagnostics, process-fact registration, and focused smoke
coverage. It does not make parent-roadmap status a global lifecycle hard gate,
does not mark all M4-M12 runtime roadmap work complete, and does not mint
server-backed or production completion proof.

## Current Implementation Status

This table is the current status boundary for the document. ✅ means the local
CLI/read-only implementation exists in source and is covered by smoke or
process-fact contract checks. Partial/future rows remain explicit because the
runtime automation and original roadmap closure are broader than this local
diagnostic surface.

| Capability | Status | Source / evidence | Boundary |
|---|---|---|---|
| Red/repro and negative-control smoke coverage | Implemented ✅ | `packages/main/src/tasks/parent-roadmap-totality-smoke.ts` covers partial, blocked, invalid, stale, migration, B-43de, overclaim, and enforce-mode samples. | Smoke proves the local contract; it does not certify every original M4-M12 runtime milestone complete. |
| Parent roadmap ledger vocabulary and row-state model | Implemented ✅ | `packages/main/src/core/parent-roadmap-totality.ts` defines `ParentRoadmapLedger`, row statuses, closure effects, stale/missing/invalid evidence states, and schema versions. | It evaluates supplied or sample ledgers; it does not migrate every historical roadmap automatically. |
| Parent rollup evaluator | Implemented ✅ | `evaluateParentRoadmapLedger` computes `allRowsClosed`, `summaryClass`, `claimType`, row reasons, and next actions while ignoring caller-written rollup conclusions. | Pure local evaluator only; it is not a second lifecycle state machine. |
| Claim consumer / overclaim detector | Implemented ✅ | `evaluateParentRoadmapClaim` detects full-roadmap wording when the rollup requires `no-full-roadmap-claim`; `runtime:parent_roadmap_totality_claim_consumer` is registered as a process fact. | Blocks/throws only inside the local parent-roadmap evaluator surface or consumers that explicitly call it; it is not a global DONE hard gate. |
| ProofStory binding diagnostic | Implemented ✅ | `evaluateParentRoadmapProofStoryBinding` checks original intent snapshot, acceptance bindings, required row inventory, and summary overclaim gaps. | Diagnostic binding for parent totality; it does not replace ProofStory lifecycle gates or external receipt proof. |
| Read-only CLI commands | Implemented ✅ | `parent_roadmap_status` and `parent_roadmap_evaluate` are registered read-only commands in `command-policy.ts`, `command-catalog.ts`, `config.ts`, and `handlers/parent-roadmap.ts`. | Commands do not write story metadata, evidence, lifecycle phase, queue state, or production receipts. |
| Process-fact / registry drift checks | Implemented ✅ | `process-fact-levels.ts`, `process-fact-registry.ts`, and `scripts/verify-process-fact-contract.mjs` register command and claim-consumer semantics. | Registry coverage is a contract check, not proof that unrelated roadmap children are done. |
| Migration / rollout / repair automation | Partial / future | Built-in `migration` and `B-43de` samples expose partial parent governance and needed rows. | No bulk migration, repair command, or global enforce rollout is claimed here. |
| Cross-track certification for the original roadmap | Partial / future | Local smoke covers representative ledgers and B-43de-style regression behavior. | All M4-M12 runtime roadmap rows remain individually provable only by their own child implementation evidence. |

## Problem Statement

B-5082 protected story-local intent for B-43de: the scoped ProofStory parent
ledger work could not silently shrink away from the story it had agreed to do.
That was necessary, but it did not prove that every child roadmap milestone in
the original strengthening request was complete. B-43de could reach DONE with a
valid parent governance ledger while M4 was still partial and M5-M12 still
needed child implementation stories.

This is a cross-story parent-child totality gap, not a local story gate
failure. The missing product behavior is an operator-visible and
machine-checkable answer to: "Did this parent roadmap actually finish all of the
user's requested child milestones, or did it only finish a governance/planning
slice?"

The gate must prevent a final response, DONE summary, roadmap dashboard, or
handoff note from sounding complete when the parent story is only partially
done. A parent governance story may be honestly DONE for its own slice, but the
system must keep the larger user intent open until every required child row has
valid closure evidence.

## Non-Goals

- The implemented parent-roadmap commands remain read-only diagnostics, not a
  global lifecycle hard gate or automatic DONE gate.
- This document/status update does not edit the old strengthening roadmap
  document.
- This document/status update does not claim M4-M12 runtime completion.
- This plan does not mark B-43de, B-5082, or any child roadmap story
  as sufficient proof of full roadmap completion.
- This plan does not let prose, dispatch transcripts, reviewer summaries, or
  local confidence substitute for structured child-row closure evidence.

## Target Contract

Parent governance DONE and full roadmap completion are separate outcomes.

- A parent governance story may finish as `partial_parent_done` when it creates
  a valid parent ledger, preserves the original user intent, and maps unfinished
  rows to child stories or valid deferrals.
- Full roadmap completion requires `allRowsClosed === true`.
- When the evaluator sees `allRowsClosed=false`, every consumer must classify
  the parent as incomplete for the original roadmap, even if the parent story's
  local DONE gate passed.
- If any row is `child-story-needed`, `child-story-active`, `blocked`, stale,
  missing evidence, or an invalid deferral, summaries must make `no full-roadmap claim`.
- `deferred-with-human-approval` is closed only when it carries a human approval
  record, scope reason, expiry or revisit trigger, and explicit statement that
  the deferred row is not implemented runtime behavior.
- Full-completion claims are invalid unless the rollup can show every row is
  closed by implementation evidence, explicitly not applicable evidence, or a
  valid human-approved deferral.

The operator-facing result should say one of these clearly:

- "Parent governance complete; roadmap not complete."
- "Full roadmap complete."
- "Parent roadmap blocked."
- "Parent roadmap has invalid or stale closure evidence."

## Data Model

### ParentRoadmapLedger

`ParentRoadmapLedger` is the parent-child truth source for a user request that
spans multiple roadmap rows or stories.

Required fields:

- `ledgerId`: stable id for the parent roadmap.
- `parentStoryId`: story that owns the parent governance slice.
- `originalIntentSnapshot`: frozen statement of the user's whole request.
- `sourceRefs`: docs, issues, transcripts, or requirement refs that define the
  parent intent.
- `rows`: ordered roadmap rows.
- `createdByStoryId`: story that introduced the ledger.
- `updatedByStoryIds`: child stories that changed row state.
- `parentLedgerRollup`: latest computed `ParentRollupResult`.
- `proofstoryContract`: pointer to the ProofStory controls that make the ledger
  auditable.

### Parent Rows

Each row records one material child milestone, not a vague topic.

Required row fields:

- `rowId`: stable milestone id, such as `M4` or `M7`.
- `title`: user-readable milestone title.
- `intentText`: what user-visible outcome the row contributes.
- `status`: one value from the status vocabulary below.
- `childStoryId`: required for active, closed, blocked, or needed child work
  when a story exists.
- `closureEvidence`: commands, artifacts, receipt refs, review evidence, or
  human approval records.
- `materialRefs`: changed files, packages, docs, or runtime surfaces the row
  depends on.
- `updatedAt`, `headHash`, `materialHash`, and `storyFilesHash` where material
  evidence is involved.
- `claimBoundary`: what this row allows the parent to claim.

### Status Vocabulary

- `parent-governed`: the row is preserved by parent governance but not
  necessarily implemented.
- `child-story-needed`: the row still needs an implementation story.
- `child-story-active`: a child story is open and not terminal.
- `closed-by-implementation`: runtime/product behavior landed and has fresh
  closure evidence.
- `closed-by-existing-evidence`: the row was already shipped and fresh evidence
  proves it still satisfies the parent intent.
- `deferred-with-human-approval`: a human explicitly accepted deferral under a
  named reason and revisit condition.
- `blocked`: the row cannot close until a named blocker is resolved.
- `not-applicable`: the row was removed only through an auditable decision that
  explains why it no longer belongs to the original request.
- `invalid`: malformed, contradictory, stale, missing, or unsupported row state.

Only `closed-by-implementation`, `closed-by-existing-evidence`,
`deferred-with-human-approval`, and `not-applicable` can contribute to full
closure, and the latter two require stricter evidence because they do not prove
runtime implementation.

### ParentRollupResult

`ParentRollupResult` is a computed value, not a manually written conclusion.

Required fields:

- `ledgerId`
- `parentStoryId`
- `allRowsClosed`
- `openRows`
- `blockedRows`
- `invalidRows`
- `deferredRows`
- `staleEvidenceRows`
- `summaryClass`
- `claimType`
- `allowedSummaryText`
- `blockedSummaryText`
- `nextActions`
- `evaluatedAt`
- `headHash`
- `materialHash`

`summaryClass` values:

- `full_roadmap_complete`
- `partial_parent_done`
- `blocked_parent`
- `invalid_parent_rollup`

`claimType` values:

- `full-roadmap-claim`: allowed only when `allRowsClosed === true` and no row
  has stale or invalid closure evidence.
- `parent-governance-claim`: allowed when the parent governance slice is done
  but child rows remain open.
- `no-full-roadmap-claim`: required when `allRowsClosed=false`, including any
  `child-story-needed`, `child-story-active`, `blocked`, stale, or invalid row.
- `blocked-claim`: required when row state prevents even a clean partial
  governance summary.

## B-5082 Binding

The implementation must reuse the ProofStory controls from B-5082 rather than
inventing a separate prose-only parent contract.

Required usage:

- `originalIntentSnapshot`: freezes the user's complete parent-roadmap request.
- `milestoneLedger`: supplies the child-row inventory that must not shrink.
- `parentLedgerRollup`: stores the computed totality state consumed by summaries
  and gates.
- `slicePlan`: explains which story is implementing which row and which rows
  remain outside the current slice.
- `intentCollision`: detects when a child or parent story tries to claim a
  narrower intent as if it were the full parent request.
- `redEvidence`: captures failing repro cases before runtime changes.
- `proofstoryContract`: binds the ledger and rollup to structured ProofStory
  facts.
- `done_intent_equivalence_check`: verifies that DONE wording matches the
  original intent and the current parent rollup.

The parent-roadmap totality gate should treat B-5082 as the local-intent
foundation, then add cross-story rollup semantics on top of it.

## Milestones

### M1. Red/Repro Test Cases Before Full Implementation

Goal:

Define the failing tests and negative controls before the complete
Parent Roadmap Completion Gate implementation story changes runtime code. This
is the first implementation milestone. The next implementation story must start
here, produce redEvidence, and only then proceed to state model or evaluator
work.

Inputs:

- B-43de parent ledger behavior.
- B-5082 ProofStory contract behavior.
- The original strengthening roadmap rows M4-M12.
- A synthetic or fixture-backed parent story that is locally DONE while child
  rows remain open.
- Existing summary/DONE wording that can overclaim completion.

Outputs:

- Red/repro test specification.
- Negative-control matrix.
- Fixture names and expected failure reasons.
- `redEvidence` artifact references for the future implementation story.
- Target contract assertions that the later green implementation must satisfy.

Tests:

- Parent DONE with open child rows: a parent story reaches local DONE while M5
  or later rows are still `child-story-needed`; expected rollup has
  `allRowsClosed=false`.
- Explicit `allRowsClosed=false`: evaluator fixture refuses to produce a full
  roadmap claim when any row is open.
- `partial_parent_done` allowed but not complete: parent governance DONE is a
  valid partial outcome and must be reported as partial.
- `child-story-needed` blocks full completion claim: a single needed child row
  forces `claimType=no-full-roadmap-claim`.
- Stale child evidence: a closed row with stale head/material/story-file binding
  is treated as not closed for full completion.
- Missing child story: a row that names needed work without a child story or
  owner remains open.
- Invalid deferral: `deferred-with-human-approval` without human approval,
  reason, or revisit condition is invalid and cannot close the row.
- Summary overclaim: final summaries containing language equivalent to "roadmap
  complete" fail when the rollup requires `no full-roadmap claim`.
- B-43de regression fixture: reproduces the actual lesson where parent
  governance can be DONE while M4 is partial and M5-M12 remain open.

Exit criteria:

- Every required red test is named, expected to fail before implementation, and
  mapped to the target contract.
- Negative controls distinguish allowed partial parent DONE from forbidden full
  roadmap claims.
- The later implementation story cannot start runtime changes without first
  recording the red/repro evidence.

Rollback and compatibility notes:

- Red tests can land as skipped or expected-failing only if the test harness has
  an explicit expected-red convention.
- The tests must not mutate existing DONE stories or old roadmap docs by hand.
- Existing local story DONE behavior remains compatible; only parent-roadmap
  full-completion claims are the new target.

### M2. State Model and Vocabulary

Goal:

Create the canonical parent-roadmap state vocabulary and persistence shape that
all later evaluators, CLI commands, summaries, and reviewers consume.

Inputs:

- M1 red/repro matrix.
- B-5082 `originalIntentSnapshot`, `milestoneLedger`, `slicePlan`, and
  `proofstoryContract`.
- Existing story lifecycle and ProofStory data boundaries.

Outputs:

- `ParentRoadmapLedger` schema.
- Row schema and status vocabulary.
- Claim type vocabulary.
- Validation rules for `deferred-with-human-approval`, stale evidence, missing
  child refs, and invalid row combinations.

Tests:

- Valid ledger with closed implementation rows passes schema validation.
- Row with unknown status fails.
- Row with `deferred-with-human-approval` but no human approval fails.
- Row with `child-story-needed` is valid but not closed.
- Row with stale material evidence is valid as data but not closed for rollup.

Exit criteria:

- Every status has a single meaning and a documented closure effect.
- Persistence format can round-trip without losing intent or evidence bindings.
- Invalid states are rejected or classified as `invalid`, never silently closed.

Rollback and compatibility notes:

- Existing ProofStory ledger fields remain readable.
- Migration should add parent-roadmap fields without breaking old stories that
  do not have parent ledgers.
- The vocabulary should be versioned so old parent rows can be repaired rather
  than guessed.

### M3. Parent Rollup Evaluator

Goal:

Implement the pure evaluator that converts a `ParentRoadmapLedger` into a
`ParentRollupResult`.

Inputs:

- M2 data model.
- M1 test cases.
- Child story terminal states, evidence freshness, and deferral validity.

Outputs:

- Pure rollup function.
- `allRowsClosed` computation.
- Row classification details.
- `summaryClass`, `claimType`, and next-action output.

Tests:

- All rows closed by fresh implementation evidence yields
  `allRowsClosed === true`.
- Any `child-story-needed` row yields `allRowsClosed=false`.
- Any stale evidence row yields `allRowsClosed=false`.
- Valid partial parent governance yields `summaryClass=partial_parent_done`.
- Invalid deferral yields `summaryClass=invalid_parent_rollup`.

Exit criteria:

- The evaluator is deterministic and side-effect free.
- Every false condition gives a row-level reason and next action.
- No caller can manually override `allRowsClosed`.

Rollback and compatibility notes:

- The evaluator can initially run in advisory/shadow mode.
- Existing lifecycle progression should not be blocked until M4/M6 explicitly
  consume the result.
- Rollup version should be recorded for migration diagnostics.

### M4. Claim Consumer / DONE Summary Gate

Goal:

Make final responses, DONE summaries, roadmap dashboards, and handoff text
consume `ParentRollupResult` before making completion claims.

Inputs:

- M3 evaluator.
- Existing DONE summary and delivery-check surfaces.
- B-5082 `done_intent_equivalence_check`.

Outputs:

- Summary claim guard.
- Allowed and blocked wording templates.
- Overclaim detector for parent-roadmap completion language.
- Evidence path showing which rollup was consumed.

Tests:

- `claimType=no-full-roadmap-claim` blocks full-completion wording.
- `summaryClass=partial_parent_done` permits parent governance completion
  wording only.
- Full roadmap wording is allowed only with `allRowsClosed === true`.
- DONE response that omits open child rows fails the claim consumer.

Exit criteria:

- Operators can tell whether the parent story is locally done or the full
  roadmap is complete.
- The consumer names open rows and next actions.
- Summary language cannot outrun rollup evidence.

Rollback and compatibility notes:

- Begin in warning mode for historical parent stories.
- Enforce only for parent ledgers marked as totality-gated.
- Provide compatibility wording for old parent ledgers without full row data.

### M5. B-5082 ProofStory Binding

Goal:

Bind parent-roadmap totality to ProofStory mechanics so a child or parent story
cannot shrink the original user request while preserving a local pass.

Inputs:

- B-5082 ProofStory controls.
- M2 ledger model.
- M3 rollup result.
- M4 claim consumer.

Outputs:

- ProofStory contract extension for parent ledgers.
- Intent collision rules for parent-child totality.
- `parentLedgerRollup` material binding.
- `done_intent_equivalence_check` integration for parent claims.

Tests:

- Child story cannot mark a parent row complete when its slice plan excludes the
  row.
- Parent story cannot claim all roadmap rows when `milestoneLedger` has open
  rows.
- Intent collision is reported when final wording narrows the original request.
- Parent rollup is stale when underlying child evidence changes.

Exit criteria:

- ProofStory local-intent and parent-totality checks are both visible.
- All parent claim decisions reference the original intent snapshot.
- Cross-story rollup drift invalidates full-completion claims.

Rollback and compatibility notes:

- Do not weaken existing B-5082 gates.
- Parent totality should layer on top of local ProofStory checks.
- Historical ProofStory records without parent ledgers remain local-intent only.

### M6. CLI / Lifecycle Integration

Goal:

Expose parent-roadmap totality checks through CLI and lifecycle flows without
turning plan-only stories into runtime completion proof.

Inputs:

- M3 rollup evaluator.
- M4 claim consumer.
- M5 ProofStory binding.
- Existing lifecycle phase gates and session/status surfaces.

Outputs:

- CLI command or lifecycle check that evaluates parent totality.
- `session_brief`, validate, or DONE-prep projection of parent rollup state.
- Structured process event for consumed rollup.
- Human-readable next actions.

Tests:

- CLI reports `partial_parent_done` for parent governance DONE with open child
  rows.
- CLI exits non-zero or blocks only when enforcement mode requires it.
- Lifecycle output lists `child-story-needed` rows.
- Enforcement does not trigger for unrelated single-story work.

Exit criteria:

- Operators have one command to see parent roadmap completion state.
- Lifecycle consumers use the same evaluator result as summaries.
- Enforcement mode is configurable and auditable.

Rollback and compatibility notes:

- Ship shadow mode first.
- Add enforce mode only after M1-M5 are green.
- Allow emergency downgrade to advisory without deleting ledger evidence.

### M7. Migration / Rollout / Repair

Goal:

Safely introduce the parent-roadmap totality gate for existing parent ledgers and
future roadmap stories.

Inputs:

- M2 schema.
- M6 CLI diagnostics.
- Existing B-43de and strengthening roadmap evidence.
- Human-approved deferral policy.

Outputs:

- Migration scanner for parent roadmap candidates.
- Repair command or runbook for missing child rows.
- Rollout stages: disabled, shadow, warn, enforce.
- Compatibility policy for old parent stories.

Tests:

- Existing parent story without a ledger is reported as migration-needed, not
  silently complete.
- B-43de migrates to partial parent governance with open child rows.
- Invalid deferral repair requires human approval.
- Rollback from enforce to warn preserves evidence and audit trail.

Exit criteria:

- No historical parent story is force-classified as complete by missing data.
- Operators can repair or defer rows without direct JSON edits.
- Rollout state is visible in diagnostics.

Rollback and compatibility notes:

- Default old ledgers to advisory until migrated.
- Preserve old DONE records while correcting future claim wording.
- Do not rewrite old roadmap docs as part of migration unless a separate story
  owns that scope.

### M8. Cross-Track Certification

Goal:

Prove that the parent-roadmap totality gate works across planning, evidence,
ProofStory, lifecycle, summary, and migration surfaces.

Inputs:

- M1-M7 implementation and evidence.
- Parent ledgers with closed, partial, blocked, invalid, and deferred rows.
- B-43de regression scenario.

Outputs:

- Certification report.
- Cross-track test matrix.
- False-DONE and overclaim negative-control results.
- Final claim boundary for what the gate does and does not prove.

Tests:

- Full happy path: all rows closed, fresh evidence, full roadmap claim allowed.
- Partial path: parent governance done, rows open, no full-roadmap claim.
- Blocked path: blocked child row prevents completion claim and names next
  action.
- Invalid path: malformed deferral or stale evidence prevents full completion.
- Migration path: old parent story becomes visible as partial or migration
  needed.
- Summary path: final response wording follows `ParentRollupResult`.

Exit criteria:

- Certification names all participating stories and evidence refs.
- Negative controls prove overclaim prevention.
- Final documentation explains the remaining limits of the gate.

Rollback and compatibility notes:

- If certification fails, keep CLI in warn/shadow mode.
- Enforce mode requires a clean certification rerun.
- A later child-story fix must refresh certification if it changes parent
  closure semantics.

## Execution Order

The original B-9fc5 slice was plan-only. Subsequent local CLI work has now
implemented M1-M6 as a read-only diagnostic/evaluator surface with smoke and
process-fact coverage:

1. ✅ M1 proves the bug and target behavior through focused smoke and negative
   controls.
2. ✅ M2 defines the local ledger, row-state, and claim vocabulary.
3. ✅ M3 computes the rollup with a pure evaluator.
4. ✅ M4 consumes the rollup for parent-roadmap claim wording inside the local
   evaluator/diagnostic surface.
5. ✅ M5 binds the result to ProofStory intent and acceptance-binding checks.
6. ✅ M6 exposes the behavior through read-only CLI diagnostics.
7. Partial / future M7 work is migration, repair automation, and any wider
   rollout beyond the read-only samples.
8. Partial / future M8 work is cross-track certification that every original
   roadmap child row has its own fresh closure evidence.

The current implementation therefore gives operators a trustworthy local answer
to "is this parent roadmap complete or only partially governed?" It deliberately
does not claim all M4-M12 runtime work complete and does not install a global
lifecycle hard gate.

## Machine Verification Table

| Check | Purpose | Command |
|---|---|---|
| Marker sweep | Proves the plan contains the required contract markers. | `rg -n "M1\\. Red/Repro|allRowsClosed=false|partial_parent_done|no full-roadmap claim|ParentRoadmapLedger|ParentRollupResult|child-story-needed|deferred-with-human-approval|B-5082" docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md` |
| Read-only boundary | Proves the current status still names read-only diagnostic scope rather than a global lifecycle hard gate. | `rg -n "read-only diagnostic|not a global lifecycle hard gate|does not claim M4-M12 runtime completion|Partial / future" docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md` |
| Implementation marker sweep | Proves the status table names the shipped evaluator, claim consumer, ProofStory binding, CLI, process-fact, and smoke surfaces. | `rg -n "Implemented ✅|evaluateParentRoadmapLedger|evaluateParentRoadmapClaim|evaluateParentRoadmapProofStoryBinding|parent_roadmap_status|process-fact|parent-roadmap-totality-smoke" docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md` |
| Runtime non-touch check | Proves this document-only status update did not require package runtime edits. | `git diff --name-only -- packages/main/src packages/main/tests` |
| Old roadmap non-touch check | Proves the old strengthening roadmap doc was not edited by this story. | `git diff --name-only -- docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md` |
| Story-local M1 check | Proves the first milestone remains red/repro before implementation. | `rg -n "M1\\. Red/Repro Test Cases Before Full Implementation|redEvidence|before runtime changes" docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md` |

## Completion Boundary

The honest user-facing claim is:

"The parent roadmap intent-totality contract has a local read-only CLI
diagnostic/evaluator implementation with claim-consumer, ProofStory-binding,
process-fact, and smoke coverage. It tells operators when parent governance is
only partial and prevents local parent-roadmap overclaim wording in the
diagnostic surface. It is not a global lifecycle hard gate, and it does not
claim the original M4-M12 runtime roadmap complete."
