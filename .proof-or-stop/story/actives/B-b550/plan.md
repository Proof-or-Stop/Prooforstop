# Plan: Execute the milestone ledger status review and hardening plan (M0-M7)

Source plan: docs/requirements/decisions/milestone-ledger-status-review-and-hardening-plan.md (merged by B-9051, commit 5ecaa55ed).

Execution order is strictly M0 -> M7. Every milestone ends in an explicit
finding-or-pass outcome recorded in a new findings report at
docs/requirements/decisions/milestone-ledger-status-review-findings.md.
The plan document Status columns are updated from "planned" to the executed
outcome, and docs/requirements/NAV.md gains an entry for the findings report.

Non-goals are binding (plan "Non-Goals" section): no new commands, no ProofStory
contract rewrites, no lifecycle gate changes, no advancing unrelated stories,
no claim that milestone status replaces lifecycle_check/review/validation/DONE
gates. Source and test directories stay read-only for this story.

Dogfooding note: this story writes its own milestone ledger (M0-M7 rows) via
milestone_ledger_set during PLAN, which both exercises the surface under review
and gives M1/M3 live status snapshots to cite as evidence.

## CHK-001 M0: Review scope and source inventory recorded

- Confirm canonical root: capture `lattice session_brief` header from
  /Users/jek/Documents/Work/proofbound (already verified: Proofbound CLI 0.3.159,
  dashboard + dev-memory render).
- Inventory command surfaces: `rg` for milestone_ledger_set/add/get,
  milestone_status, milestone_closeout across packages/ — record the file list
  (cli-engine, command-catalog, command-policy, config, milestone-status core +
  handler, proofstory handler, process-fact-{levels,registry}, activity-policy,
  proofstory-intent-hardening-smoke task, milestone-status.test.mjs).
- Inventory source docs: proofstory-intent-collision-execution-plan.md,
  milestone-ledger-status-review-and-hardening-plan.md, NAV.md entries.
- Inventory tests/smokes: packages/main/tests/milestone-status.test.mjs (1906
  lines), proofstory-intent-hardening-smoke task; record npm script bindings.
- Record stale/retired-root docs: retired Orchestrate root planning prose must
  not drive truth; note B-9051 summary + dev-memory 9890b83 lesson.
- Output: "Trusted source map" section in the findings report.

## CHK-002 M1: Read-only status boundary review completed

- Review assertMilestoneStatusReadOnlyBoundary +
  assertMilestoneCloseoutReadOnlyBoundary in
  packages/main/src/handlers/milestone-status.ts: whitelist {storyId, format,
  json}, throws before any store read (M1.a, M1.b).
- Verify missing ledger path returns a built report, no writes (M1.c).
- Verify no command/reviewer launches and no evidence/summary/review-pass/
  lifecycle writes anywhere in the status path (M1.d, M1.e) — check
  core/milestone-status.ts render path and command-policy readOnly class.
- Verify output never claims DONE or production readiness (M1.f) — inspect
  renderMilestoneStatusReport strings + tests.
- Evidence: source citations + live `lattice milestone_status` runs against
  B-b550 (negative: unexpected key rejection; missing-ledger report before the
  ledger exists; normal report after).
- Output: boundary finding or pass in the findings report.

## CHK-003 M2: Ledger write contract review completed

- Review command-policy.ts rows for milestone_ledger_set/add: gateEvidence,
  storyScopedMutating, allowedPhases ['PLAN'] (M2.a-M2.c).
- Review buildMilestoneLedger/addMilestoneToLedger + ledgerHash and
  candidate/confirmed state transitions in core/proofstory.ts; confirm only
  intent_collision_set decision=pass confirms a candidate ledger (M2.d, M2.e).
- Review overwrite semantics of milestone_ledger_set over an existing ledger
  (M2.f): does set replace rows silently, is the hash rebound, does confirmed
  state survive or reset — record as finding if unsafe.
- Evidence: source citations + live dogfood writes on B-b550 during PLAN.
- Output: write-surface finding or pass.

## CHK-004 M3: Missing-ledger policy review completed

- Ordinary story with no ledger: milestone_status missing-ledger report,
  milestone_ledger_get not_configured message, no DEV admission block (M3.a).
- Structural/semantic triggers: evaluateProofStoryDiagnostics milestone
  trigger codes -> requires 'milestone-ledger'/'confirmed-milestone-ledger'
  (core/proofstory.ts ~line 847+) (M3.b).
- Candidate vs confirmed requirements (M3.c); DEV admission behavior via
  intent_coverage_check wouldBlockFutureDevAdmission (M3.d); REVIEW/DONE
  behavior for stale/incomplete milestone facts via done_intent_equivalence
  (M3.e).
- Verify missing-ledger nextActions strings are specific and non-mutating
  (M3.f) — test asserts nextActions match milestone_ledger_set suggestion.
- Output: missing-state matrix (ordinary / triggered / candidate / confirmed).

## CHK-005 M4: Schema and progress-model review completed

- Review MilestoneLedgerItem/MilestoneLedgerData in core/types.ts:1783-1816
  against M4.a required fields (id, sourceRequirementId, claim, doneMeans,
  requiredEvidence) — all present.
- checklistRefs + verificationIntentRefs binding fields (M4.b); MilestoneStatus
  values planned/covered/done/not_applicable vs progress-table needs (M4.c);
  parentLedgerId + assignedStory support (M4.d).
- Prose-only text cannot mint hidden milestone claims (M4.e): ledger rows come
  only from explicit set/add calls; status report projects rows only.
- Identify schema additions needed for grouped status reports (M4.f) — pass or
  concrete finding.
- Output: schema adequacy finding or pass.

## CHK-006 M5: Test and negative-control review completed

- Map tests in packages/main/tests/milestone-status.test.mjs to M5.a-M5.e:
  read-only arg rejection, missing-ledger report, set/add/get schema behavior,
  milestone-triggered gates, "status cannot satisfy DONE".
- Check proofstory-intent-hardening-smoke coverage and npm script wiring so
  the tests actually run in the suite.
- Record any missing negative controls as findings (M5.f).
- Output: test-gap list (possibly empty).

## CHK-007 M6: Agent capability impact review completed

- Verify plan "Agent Development Capability Impact" claims against verified
  M1-M5 facts: structured rows improve progress reporting (M6.a);
  missing-ledger gates fail closed for unattended execution (M6.b); ledger
  refs support host handoff (M6.c); claims stop short of lifecycle DONE /
  Authority (M6.d) — cross-check command-policy reason strings.
- Output: capability claim boundary statement in the findings report.

## CHK-008 M7: Review outcome recorded and next story decided

- Summarize all M0-M6 pass/finding outcomes in a closure table (M7.a).
- Decide: implementation follow-up needed or current implementation
  sufficient (M7.b); if gaps exist, draft a narrow follow-up story scope
  inside the findings report (M7.c); else record documentation-only
  completion (M7.d).
- Update the plan document milestone Status columns planned -> executed
  outcome; update NAV.md with the findings report entry.
- Output: findings report closure section + updated plan/NAV docs.
