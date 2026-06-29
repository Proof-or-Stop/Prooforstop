# B-f7b7 Execution Plan

## Objective

Implement ProofStory M0-M9 as a progressive intent-hardening lifecycle in the existing Proofbound CLI. The implementation must keep the Story lifecycle as the single state machine, add mechanical artifacts for intent proof, and keep ordinary low-risk work lightweight while allowing high-assurance stories to enforce gates.

## Shared Constraints

- Do not use or touch .omx.
- Keep all new user-facing command text and documentation in English.
- Do not add a second lifecycle state machine.
- Do not auto-create child stories or run a scheduler/autopilot from ProofStory gates.
- Keep observe and warn behavior available; enforce only when explicit mode or policy selects it.
- Red evidence and spike evidence are risk-triggered, not universal defaults.

## CHK-001

Freeze the ProofStory vocabulary and lifecycle documentation. Apply the approved lifecycle ordering fix so candidate milestone ledger creation happens before intent collision, confirmed ledger consumption happens after accepted intent interpretation, ledger sizing happens before checklist execution, and pre-DEV intent_coverage_check happens only after checklist, verificationIntent, and acceptance bindings exist. Keep DONE evidence and final delivery checks separate from pre-DEV coverage. Correct the progressive model rule count and keep the scheduler/autopilot boundary explicit.

Verification: run a docs check against docs/requirements/decisions/proofstory-intent-collision-execution-plan.md and confirm the document does not claim full coverage can pass before checklist/verificationIntent/binding exists.

## CHK-002

Extend original intent and milestone ledger artifacts. Preserve the current immutable original intent snapshot semantics, add candidate versus confirmed ledger state, add accepted-intent binding metadata, and ensure candidate ledgers are visible to diagnostics but not treated as gate-consumed contracts. Keep stable hashes for original intent and ledger evidence.

Verification: use CLI smoke coverage for original_intent_snapshot_set/get and milestone_ledger_set/add/get, including immutable snapshot rejection and candidate ledger diagnostics.

## CHK-003

Implement M2 dry-run hardening and ledger sizing diagnostics. Add risk-adaptive hardening classification details, milestone sizing thresholds, too_broad diagnostics, and suggested slicing groups. Do not create child stories automatically.

Verification: proofstory_gate_check --dryRun must report hardening level, triggers, ledger size, threshold state, too_broad/slice_required gaps, and must leave lifecycle state unchanged.

## CHK-004

Implement structured intent collision artifacts. Add intent_collision_set/get with pass, revise_intent, human_gate, and stop decisions. Only a pass decision with accepted interpretation can confirm a ledger for gate consumption.

Verification: CLI smoke must show pass clears the triggered collision gap and non-pass decisions remain diagnostic gaps.

## CHK-005

Implement ProofStory contract and pre-DEV gate enforcement. Add acceptance contract/binding commands or compatible aliases, expose proofstory_gate_check modes observe, warn, and enforce, and wire enforce-mode DEV admission into the existing lifecycle gates without replacing story_review.

Verification: enforce-mode diagnostics must block only when policy/mode selects enforcement and required artifacts are missing; observe and warn must stay non-blocking.

## CHK-006

Implement scope shrinkage and DONE intent equivalence. Add scope_shrinkage_decision_set/get and done_intent_equivalence_check so final delivery can be compared against original intent, confirmed ledger, checklist, evidence, and any explicit shrinkage decision. A shrinkage decision must be explicit and auditable.

Verification: smoke should demonstrate uncovered required milestones produce DONE equivalence gaps and explicit confirmed shrinkage changes the outcome without deleting the audit trail.

## CHK-007

Implement red evidence artifacts and policy triggers. Add red_evidence_create/get and diagnostics for bug, regression, behavior change, security/auth/session, and benchmark claims. Ensure docs-only and ordinary new-feature stories do not require red evidence by default.

Verification: smoke should prove risk-triggered stories report missing red evidence and low-risk stories do not; passing green evidence alone must not satisfy red evidence.

## CHK-008

Implement spike evidence artifacts and policy triggers. Add spike_start, spike_result_set, spike_discard, spike_promote, and spike_get. Spikes must remain investigation evidence and must not be counted as verificationEvidence or red evidence unless separately promoted through explicit semantics.

Verification: smoke should show unresolved spikes remain diagnostics, resolved/discarded/promoted spikes are represented clearly, and spike names cannot satisfy acceptance bindings by collision.

## CHK-009

Implement REVIEW completeness critic integration. Add proofstory_review_completeness_check and wire REVIEW diagnostics so reviewers can see confirmed ledger, acceptance binding, verificationIntent, and evidence completeness gaps. Enforce only when selected by mode/policy.

Verification: CLI smoke and REVIEW preflight should surface completeness gaps for triggered stories and avoid masking them behind generic reviewer passes.

## CHK-010

Implement risk-adaptive enforcement rollout. Update command catalog, command policy, process fact levels, process fact registry, config allowlists, tests, and docs so ProofStory artifacts are correctly classified as advisory, mutating, or gate evidence. Keep low-risk Intent MVP stories light, while high-assurance and oversized-ledger cases can enforce.

Verification: run the ProofStory smoke test, TypeScript build, relevant process-fact contract checks, and lattice validate. Record verificationEvidence per checklist item before REVIEW/TEST.

## Rollback Plan

If a ProofStory gate change blocks unrelated stories, revert the lifecycle gate integration while retaining read-only diagnostics and command artifacts. If a new command schema is too broad, keep the artifact reader and downgrade the writer to observe/warn until tests prove the enforcement semantics.
