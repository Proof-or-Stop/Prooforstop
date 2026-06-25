# B-1731 Repro-First Lifecycle Gate Plan

## Scope

This story turns Repro-First from a convention into a lifecycle gate for code-touched stories. The delivered slice enforces the rule at IDEA->PLAN and DEV ingress using the existing story-evidence-binding artifacts. It does not yet implement global story_create enforce mode; that broader intake policy remains a follow-up because it changes story creation semantics.

## CHK-001

**Goal:** Classify code-touched stories by checklist file declarations.

**Implementation:** Add a shared helper that treats any checklist item with files.modify, files.create, or files.test as requiring repro-first evidence. A checklist without file declarations stays bypass-eligible so documentation and management work can continue.

**Verify:** The smoke must show file-touched stories are blocked without binding, and no-file stories are not blocked.

## CHK-002

**Goal:** Enforce the gate at IDEA->PLAN, PLAN->DEV, and INIT_CHECK->DEV express.

**Implementation:** Reuse story-evidence-binding candidate artifacts. The guard must verify artifact digest, storyId binding, probe digest, review digest, and repro-review verdict red-reviewed + reviewedFailureClass target-bug. Failure messages must name missing_story_evidence_binding or stale_story_evidence_binding and point to story_create_from_repro.

**Verify:** The smoke must cover missing binding blocks, valid binding passes, and stale binding blocks for PLAN and DEV paths.

## CHK-003

**Goal:** Keep evidence semantics narrow and honest.

**Implementation:** Gate-consumed evidence remains candidate-scoped and lifecycle-local. The guard must not claim Authority receipt, productionDone, or proof-of-fix. It only proves that a reviewed red repro is bound to the story before PLAN/DEV.

**Verify:** Smoke and review confirm that non-code stories bypass, malformed evidence fails, and reason text is specific without production/Authority wording.

## CHK-004

**Goal:** Add a hermetic smoke for the gate matrix.

**Implementation:** Add packages/main/src/tasks/repro-evidence-binding-dev-gate-smoke.ts. The smoke builds temporary repos, writes repro artifacts through the evidence store, and calls the real guards and guard-failure renderer.

**Verify:** Run npm --prefix packages/main run build and node packages/main/dist/tasks/repro-evidence-binding-dev-gate-smoke.js. Existing repro-first and proof-admissibility smokes should remain green.

## Rollback

If this blocks legitimate flows, revert the machine guard wiring and keep the smoke as failing repro evidence for a follow-up policy story. No stored artifact schema is changed in this slice.
