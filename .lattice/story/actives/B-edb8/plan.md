# B-edb8 Execution Plan

Goal: implement the parent-roadmap intent-totality gate described by B-9fc5. The runtime must distinguish parent governance DONE from full roadmap completion and must prevent full-roadmap claims while any child milestone row is open, stale, blocked, invalid, or only planned.

Non-goals:
- Do not revive Authority Server, productionDone, fullAuthorityDone, or server-backed completion semantics.
- Do not claim lattice-strengthening-roadmap M4-M12 implementation is complete unless the row is actually closed by implementation evidence.
- Do not bypass existing B-5082 ProofStory gates or weaken current story lifecycle guards.

Execution order:
1. Land M1 Red/Repro smoke first, before runtime evaluator implementation.
2. Implement the pure model/evaluator.
3. Add claim consumer and CLI/status projection.
4. Bind to ProofStory/process fact surfaces.
5. Add migration diagnostics and final certification matrix.

## CHK-001

M1 Red/Repro tests before full implementation.

Steps:
- Create parent-roadmap-totality smoke with expected-red modes for parent overclaim and test-first proof.
- The red mode must demonstrate the current missing/insufficient implementation cannot certify a parent roadmap as full when child rows remain open.
- Include negative cases for allRowsClosed=false, partial_parent_done, child-story-needed, stale evidence, missing child story, invalid deferred human approval, summary overclaim, and B-43de-shaped historical parent data.
- Run the expected-red commands and record their output before adding the evaluator implementation.

Verification:
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --expected-red=parent-overclaim
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --expected-red=test-first

Rollback:
- If the smoke cannot prove a red condition without implementation, stop and revise the test design before touching runtime code.

## CHK-002

M2 State model and vocabulary.

Steps:
- Implement ParentRoadmapLedger, ParentRoadmapRow, ParentRollupResult, row statuses, claim types, and summary classes.
- Validate strict shape, unknown statuses, invalid deferrals, and required closure evidence.
- Keep the model local and independent from server-backed Authority semantics.

Verification:
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --case=state-model

Rollback:
- If strict validation breaks existing ProofStory records, add a compatibility projection instead of changing old record semantics.

## CHK-003

M3 Parent rollup evaluator.

Steps:
- Implement deterministic evaluation from row facts only.
- Compute allRowsClosed, row reasons, open/stale/blocked/invalid buckets, next actions, summaryClass, and claimType.
- Ignore caller-provided allRowsClosed or claimType overrides.

Verification:
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --case=evaluator

Rollback:
- If row facts cannot explain the result, fail closed with invalid_parent_rollup rather than guessing.

## CHK-004

M4 Claim consumer and summary guard.

Steps:
- Add a claim consumer that checks full-roadmap wording against ParentRollupResult.
- Allow honest partial_parent_done wording with open rows and next actions.
- Block full-roadmap wording unless allRowsClosed is true and claimType is full-roadmap-claim.

Verification:
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --case=claim-consumer

Rollback:
- If claim text detection is ambiguous, make it advisory only for ambiguous terms and hard-block only explicit full-roadmap completion claims.

## CHK-005

M5 B-5082 ProofStory binding.

Steps:
- Bind parent totality to originalIntentSnapshot, milestoneLedger, slicePlan, parent rollup, intentCollision, redEvidence, proofstoryContract, and done_intent_equivalence_check.
- Keep existing ProofStory diagnostics passing.
- Prevent a local narrow acceptance claim from hiding child-story-needed rows.

Verification:
- node packages/main/dist/tasks/proofstory-intent-hardening-smoke.js
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --case=proofstory-binding

Rollback:
- Do not modify B-5082 core gates incompatibly. If needed, add adapter functions around the new parent-roadmap evaluator.

## CHK-006

M6 CLI and lifecycle integration.

Steps:
- Add a local CLI/status surface for parent-roadmap totality.
- Show full, partial, blocked, invalid, and migration-needed states with next actions.
- Keep unrelated single-story work out of parent-roadmap classification.

Verification:
- lattice parent_roadmap_status --help
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --case=cli

Rollback:
- If command integration is unstable, keep evaluator code and make CLI read-only shadow mode until fixed.

## CHK-007

M7 Migration rollout and repair.

Steps:
- Add diagnostics for historical parent roadmap candidates such as B-43de shape.
- Default legacy unknowns to partial or migration-needed, never full complete.
- Preserve evidence and provide repair/next-action text.

Verification:
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js --case=migration

Rollback:
- If legacy data is insufficient, report migration_needed and require explicit human or child-story closure evidence.

## CHK-008

M8 Cross-track certification.

Steps:
- Run a certification matrix covering full, partial, blocked, invalid, stale, migration, summary, and negative controls.
- Run build, ProofStory smoke, process fact contract verifier, lattice validate, and done_required_validate.
- Update docs only to state implemented behavior and remaining limits.

Verification:
- npm --prefix packages/main run build
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js
- node packages/main/dist/tasks/proofstory-intent-hardening-smoke.js
- node scripts/verify-process-fact-contract.mjs
- lattice validate --story=B-edb8
- lattice done_required_validate --storyId=B-edb8

Rollback:
- If any certification row fails, do not claim full implementation; leave the parent ledger row open with the failing reason.
