# Execution Plan: B-85ba Scope Anti-Expansion Gate

## Boundary

Do:
- Add a semantic INIT anti-expansion gate before INIT_CHECK/worktree creation.
- Persist user-confirmed scope boundary, execution boundary, freeze check, and extension proposals as typed Lattice artifacts.
- Fail closed when required boundary artifacts are missing, stale, failed, or pending.
- Keep this distinct from later scope_contract diff/file enforcement.

Do not:
- Build a generic semantic classifier platform.
- Change Authority, Layer4, customerKeyRef, or repair UX behavior beyond keyword blocking examples.
- Treat host dispatch output, prompts, or transcripts as gate evidence.
- Register .omx as a runtime artifact or evidence path.

STOP conditions:
- Any proposed design makes missing scope mean allow-all.
- Any reviewer can directly mutate checklist scope through the proposal command.
- INIT_CHECK can create a worktree after a failed/missing/stale freeze check.
- Process-fact registry or contract verifier cannot represent the new gate facts.

Allowed implementation files:
- packages/main/src/core/types.ts
- packages/main/src/core/store.ts
- packages/main/src/core/scope-anti-expansion.ts
- packages/main/src/core/machine.ts
- packages/main/src/core/command-policy.ts
- packages/main/src/core/process-fact-levels.ts
- packages/main/src/core/process-fact-registry.ts
- packages/main/src/core/lifecycle-registry.ts
- packages/main/src/handlers/scope-anti-expansion.ts
- packages/main/src/handlers/story-create.ts
- packages/main/src/handlers/checklist.ts
- packages/main/src/handlers/worktree.ts
- packages/main/src/handlers/transition-orchestrator.ts
- packages/main/src/handlers/session.ts
- packages/main/src/cli-engine.ts
- packages/main/src/registry.ts
- packages/main/src/tasks/scope-anti-expansion-smoke.ts
- packages/main/templates/agents/koala-review-story-init.md
- docs/requirements/decisions/story-lifecycle.md
- docs/requirements/decisions/lifecycle-artifact-scope.md
- package.json
- packages/main/package.json
- scripts/verify-process-fact-contract.mjs

## CHK-001

Implement typed artifact models and store accessors.

Steps:
1. Add ScopeBoundaryData, ExecutionBoundaryData, ScopeFreezeCheckData, ScopeExtensionProposalData, and DiscardReasonDigestData to core types.
2. Add read/write helpers in StoryStore for scope-boundary.json, execution-boundary.json, scope-freeze-check.json, scope-extension-proposals.json, and discard-digest.json.
3. Add core/scope-anti-expansion.ts with validation helpers and deterministic digest/signature helpers.

Non-goals:
- Do not enforce file diff scope here.
- Do not infer absent fields as allow-all.

Verification:
- Logic smoke proves persisted artifacts round-trip.
- Edge smoke proves missing boundary is represented as a hard blocker.
- Adversarial smoke proves malformed arrays/blank terms/unsafe paths are rejected.

## CHK-002

Implement INIT-only command surface.

Steps:
1. Add handlers for scope_boundary_set, execution_boundary_set, scope_freeze_check, scope_extension_proposal, and scope_extension_decide.
2. Register handlers and CLI schemas.
3. Add command policies with correct ownership classes and INIT-only allowed phases.
4. Keep proposal and decision separate: proposal cannot accept itself and cannot mutate checklist.

Non-goals:
- Do not add a broad reviewer workflow engine.
- Do not permit proposal writes after INIT.

Verification:
- CLI smoke shows commands are registered and phase-gated.
- Edge smoke shows accepted extension invalidates freeze-check.
- Adversarial smoke shows proposal cannot directly accept expansion.

## CHK-003

Wire INIT_CHECK gate and pre-worktree ordering.

Steps:
1. Extend canEnterInitCheck to require passing anti-expansion evidence in addition to init-check reviewer evidence.
2. Extend getGuardFailureReason with distinct reason codes for missing boundary, missing execution boundary, failed/stale freeze check, pending proposal, and repeat digest blocker.
3. Ensure the guard runs before worktree creation or phase mutation.
4. Update session/next hints so users see exact repair commands.

Non-goals:
- Do not weaken existing init-check hash, required reviewer, or blocking issue semantics.
- Do not let old init-check pass substitute for anti-expansion evidence.

Verification:
- CLI smoke proves success path and each blocker path.
- Adversarial smoke confirms story stays INIT and no worktree path is created on failure.

## CHK-004

Enforce excluded keyword and discard digest protections.

Steps:
1. Extend story_create input to accept scopeBoundary, executionBoundary, and repeatMitigation.
2. Run freeze-check candidate validation before writing a new story where possible; after story materialization, write canonical artifacts.
3. Apply default future denylist only to correctness_fix mode: repair UX, Authority, Layer4, customerKeyRef.
4. Add bounded discard digest generation in story_discard and duplicate-pitfall detection in story_create.
5. Update checklist mutation paths so new scope that hits excluded terms requires proposal/decision flow rather than silent broadening.

Non-goals:
- Do not scan arbitrary repo content for semantic keywords.
- Do not build fuzzy product taxonomy beyond bounded source fields.

Verification:
- Happy smoke blocks default future keywords in correctness_fix stories.
- Edge smoke allows feature/refactor stories unless user-confirmed excludes apply.
- Adversarial smoke blocks repeat discard direction unless repeatMitigation is recorded.

## CHK-005

Register process facts, update prompts/docs, and add tests.

Steps:
1. Add process-fact-level entries, artifact refs, required semantics, command policies, and lifecycle artifact filenames.
2. Update verify-process-fact-contract for new commands/artifacts.
3. Update INIT reviewer prompt and lifecycle docs: reviewer proposes scope expansion; main/user decides.
4. Add scope-anti-expansion smoke script and package scripts.
5. Record verificationEvidence for every verificationIntent after commands pass.

Non-goals:
- Do not claim Host Overflow or multi-host transcripts are authority evidence.
- Do not alter unrelated Authority/Layer4 semantics.

Verification:
- npm run build.
- npm --prefix packages/main run test:scope-anti-expansion-smoke.
- npm run test:process-fact-contract.
- npm --prefix packages/main run test:scope-contract-smoke.
- lattice validate --story=B-85ba in TEST.
