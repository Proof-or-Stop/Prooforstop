# B-47cd Plan — Lattice unattended host-to-host autopilot execution modes

## User Intent

The user wants Lattice CLI to support unattended host-to-host development modes that can coordinate Codex, Claude Code, Gemini, and local/fake runners while keeping Lattice as the policy, evidence, receipt, and merge authority. This story must make the modes executable, observable, and testable, but it must not turn local diagnostic receipts into production authority.

## Product Shape

Lattice will expose three explicit autopilot modes:

| Mode | Default Authority | Automation Allowed | Required Stop Point |
|---|---|---|---|
| Conservative | Local diagnostic only | policy-bound dispatch, watch/review, validation classification, manual merge plan | always stops at manual review / manual merge plan |
| Authority-Verified | Server-authority constrained | conservative steps plus story integration only when server authority receipt, scope, validation, and review gates pass | stops when authority receipt or any gate is missing |
| Full Autopilot | Explicit high-autonomy policy | bounded dispatch/review/validate/fix loop plus optional integration when all gates pass | stops on maxIterations, timeout, budget, conflict, scope violation, failed authority, or missing receipt |

The implementation will prefer the existing dispatch_auto / dispatch_watch / dispatch_review / dispatch_merge_plan flow. Host-native delegation stays evidence-first: Lattice can generate handoff/receipt/transcript instructions for a host to call another host, while Lattice-controlled dispatch remains the only path that starts subprocess work.

## Safety Contract

Autopilot output must carry explicit authority fields and avoid overclaiming:

- Conservative mode keeps authorityChanged=false, receiptVerified=false, productionDone=false.
- Authority-Verified mode may classify a fake/test server receipt as authorityVerified in deterministic tests, but local diagnostic receipts alone must not satisfy that gate.
- Full Autopilot must be bounded by maxIterations, runtime, budget, conflict, and scope stop conditions.
- Main merge remains manual unless allowMainMerge is true and the authority gate is satisfied; this story should not silently merge main in normal smoke tests.
- Resume must fail closed when policy, material evidence, run state, or authority posture is stale/unsafe.

## Implementation Milestones

## CHK-001 Define execution mode contract and story scope

Files:

- Modify README.md
- Modify docs/requirements/decisions/host-overflow.md
- Modify docs/requirements/decisions/story-lifecycle.md only if the lifecycle merge/authority boundary needs a short cross-reference

Work:

- Add a three-mode autopilot matrix with user-facing language.
- Make Conservative the default and state that it stops at manual review/merge plan.
- Add non-goals: no local receipt => server authority, no hidden main merge, no productionDone overclaim.

Verification:

- Docs review checks mode matrix and no-overclaim language.

## CHK-002 Add autopilot policy schema and mode permission matrix

Files:

- Create packages/main/src/core/autopilot-policy.ts
- Modify packages/main/src/cli-engine.ts
- Modify packages/main/src/core/command-policy.ts
- Modify packages/main/src/core/process-fact-levels.ts

Work:

- Define AutopilotMode, AutopilotPolicy, AutopilotPolicyCheckResult, and normalized permission matrix.
- Add policy create/get/check surfaces: autopilot_policy_create, autopilot_policy_get, autopilot_policy_check.
- Validate bounded fields: maxIterations, maxRuntimeMinutes, maxBudgetUSD, stopOnConflict, stopOnScopeViolation, server receipt requirement, main merge requirement.

Verification:

- Logic smoke asserts conservative defaults, authority receipt requirement, and full-autopilot refusal for unbounded policies.

## CHK-003 Implement conservative autopilot_run

Files:

- Create packages/main/src/core/lattice-autopilot.ts
- Create packages/main/src/handlers/lattice-autopilot.ts
- Modify packages/main/src/registry.ts
- Modify packages/main/src/cli-engine.ts
- Modify packages/main/src/core/command-policy.ts
- Modify packages/main/src/core/process-fact-levels.ts

Work:

- Add autopilot_run --mode=conservative.
- Persist run records under .koala/autopilot-runs/<runId>/run.json.
- Reuse dispatch_auto, dispatch_watch, dispatch_review, and dispatch_merge_plan for evidence and manual merge guidance.
- Return status=manual_review_ready when dispatch/review/validation classification passes.

Verification:

- CLI smoke creates a fake policy/run and asserts manualOnly=true with authority fields false.

## CHK-004 Define host-native delegation evidence contract

Files:

- Modify packages/main/src/core/lattice-autopilot.ts
- Modify docs/requirements/decisions/host-overflow.md
- Modify README.md

Work:

- Add hostNativeDelegation block to autopilot run/plan output: handoff pack, prompt path, receipt path, transcript path, review command, and nextAction.
- Keep it a proof/evidence contract rather than a hidden runner.

Verification:

- Smoke asserts missing receipt remains needs_receipt / manual_review_ready rather than completed.

## CHK-005 Integrate Lattice-controlled dispatch path

Files:

- Modify packages/main/src/core/lattice-autopilot.ts
- Modify packages/main/src/core/autopilot-policy.ts
- Modify packages/main/src/handlers/lattice-autopilot.ts
- Test packages/main/src/tasks/autopilot-run-smoke.ts

Work:

- Connect autopilot to dispatch_auto using a named dispatch policy.
- Preserve dispatch policy allowedHosts, allowedPaths, commandAllowlist, parallel cap, and real-host subprocess opt-in.
- Surface dispatchId, watch summary, review summary, and merge plan in the run record.

Verification:

- Smoke covers authorized fake path and real-host subprocess refusal when policy is missing opt-in.

## CHK-006 Implement authority-verified mode gate

Files:

- Modify packages/main/src/core/lattice-autopilot.ts
- Modify packages/main/src/core/autopilot-policy.ts
- Modify docs/requirements/decisions/authority-client-role.md only if a short cross-reference is needed

Work:

- Add AuthorityGateResult that distinguishes local diagnostic receipt from server-authority receipt.
- Allow deterministic fake-authority input for tests without pretending it came from the production server.
- Stop with missing_authority_receipt before auto DONE/main merge when authority proof is missing.

Verification:

- Smoke covers success with fake server-authority receipt and refusal with only a local diagnostic receipt.

## CHK-007 Implement full-autopilot loop with stop conditions

Files:

- Modify packages/main/src/core/lattice-autopilot.ts
- Modify packages/main/src/core/autopilot-policy.ts
- Test packages/main/src/tasks/autopilot-run-smoke.ts

Work:

- Add bounded iteration loop: dispatch -> watch -> review -> validation classification -> optional fix retry -> integration decision.
- Implement stop reasons: max_iterations, timeout, budget_exhausted, conflict, scope_violation, validation_failed, missing_receipt, missing_authority.
- Keep loop deterministic in tests; no uncontrolled subprocess recursion.

Verification:

- Smoke covers bounded success, validation retry classification, and maxIterations stop.

## CHK-008 Add merge and conflict manager boundaries

Files:

- Modify packages/main/src/core/lattice-autopilot.ts
- Modify docs/requirements/decisions/story-lifecycle.md if needed
- Modify README.md

Work:

- Add mergeDecision fields: manualOnly, storyIntegrationAllowed, storyIntegrated, mainMergeAllowed, mainMerged, conflictState, nextAction.
- Conservative always manualOnly.
- Authority/full can only set integrationAllowed when policy and authority gates pass; actual main merge remains off in smoke unless all explicit gates are true.

Verification:

- Smoke asserts no mode merges main without allowMainMerge plus authority gate.

## CHK-009 Add autopilot observability commands

Files:

- Modify packages/main/src/handlers/lattice-autopilot.ts
- Modify packages/main/src/core/lattice-autopilot.ts
- Modify packages/main/src/cli-engine.ts
- Modify packages/main/src/core/command-policy.ts
- Modify packages/main/src/core/process-fact-levels.ts

Work:

- Add autopilot_status, autopilot_watch, autopilot_cancel, autopilot_review, autopilot_resume.
- status/watch/review are read-only; cancel/resume are policy-gated metadata writes.
- Cancel preserves evidence and prevents more steps.
- Resume fails closed unless run state is safe and policy hash still matches.

Verification:

- Smoke asserts status/watch/review shape, cancel persistence, and resume refusal for unsafe/stale state.

## CHK-010 Add deterministic autopilot smoke test suite

Files:

- Create packages/main/src/tasks/autopilot-run-smoke.ts
- Modify packages/main/package.json

Work:

- Add a temp-repo smoke using the main registry, matching dispatch-run-smoke style.
- Check five-way registration: MAIN_TOOLS, registry, COMMAND_POLICIES, PROCESS_FACT_LEVEL_BY_NAME, read-only set where applicable.
- Test conservative, authority-verified, full-autopilot, host-native delegation, stop conditions, observability, and authority invariants.

Verification:

- npm --prefix packages/main run build
- npm --prefix packages/main run test:autopilot-run-smoke
- Existing dispatch smoke remains a regression comparison.

## CHK-011 Complete docs, review, delivery, and DONE gate

Files:

- Modify README.md
- Modify docs/requirements/decisions/host-overflow.md
- Modify story metadata through Lattice CLI only

Work:

- Add final usage examples:
  - lattice autopilot policy create/check
  - lattice autopilot run --mode=conservative
  - lattice autopilot status/watch/review/cancel/resume
- Record verification evidence per checklist after commits.
- Run concept, quality, test-coverage, docs reviewers and delivery reviewer.
- Advance DEV -> REVIEW -> TEST -> DONE when gates pass.

Verification:

- Build/tests/scope/review/delivery gates pass.
- Final report states exact commands, results, and remaining authority boundaries.

## Agent Execution Plan

After PLAN review passes, split work into bounded lanes:

1. Agent Policy Lane: implement autopilot-policy core, CLI schema fragments, and policy docs. Avoid touching run engine except exported types.
2. Agent Run Engine Lane: implement lattice-autopilot core around dispatch_auto/watch/review/merge plan, persisted run records, authority gate, merge decision, and bounded loop.
3. Agent Handler/Registration Lane: wire handlers, registry, command policy, process fact levels, aliases, text renderers, and read-only command classification.
4. Agent Test/Docs Lane: write autopilot-run-smoke and update README/host-overflow examples.

The main agent will integrate overlapping files, resolve conflicts, run verification, record evidence, and keep the user updated after each milestone.
