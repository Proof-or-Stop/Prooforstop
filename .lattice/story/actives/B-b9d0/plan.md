# B-b9d0 Implementation Plan

## Scope Principles

- This story fixes Koala workflow self-locks without weakening product source scope enforcement.
- Lifecycle metadata is allowed only when it is story-scoped, command-generated, and tied to Koala process provenance.
- TEST must not gain broad scope acknowledgement. The only TEST convenience is the exact delivery and summary artifacts produced by their dedicated Koala commands.
- Derived/runtime build trees may be skipped by convergence scanning, but docs/story and requirements paths must remain visible.
- session_brief must surface blocking scope failures before any phase-advance recommendation.

## CHK-001 Define Koala-owned lifecycle artifact policy

**Owner**: Claude Code CLI implementer; Codex supervisor verifies.
**DependsOn**: none.
**Allowed Files**:
- packages/main/src/core/scope-contract.ts
- packages/main/src/handlers/scope-contract.ts
- packages/main/src/core/dirty-worktree.ts
- packages/main/src/core/process-fact-registry.ts
- packages/main/src/core/lifecycle-registry.ts
- packages/main/src/core/types.ts
- docs/requirements/decisions/story-lifecycle.md
- docs/requirements/decisions/truth-source.md
- docs/requirements/decisions/lifecycle-artifact-scope.md
- scripts/verify-process-fact-contract.mjs

**Implementation**:
- Add or reuse a central helper/registry that identifies narrow Koala lifecycle artifacts by story id, path, producing command, and process artifact contract.
- Make scope/dirty classification label those files as Koala lifecycle metadata only when command provenance is available or mechanically derivable from Koala process facts.
- Keep arbitrary JSON, product source, and unknown paths classified as normal scope changes.
- Document the boundary in lifecycle-artifact-scope.md and cross-reference existing truth docs only where needed.

**Verify**:
- Add logic assertions to scripts/verify-process-fact-contract.mjs for allowed delivery/summary artifacts and adversarial arbitrary/product paths.
- Expected user text includes "Koala lifecycle artifact (command-generated metadata)" and arbitrary files still include "OUT_OF_SCOPE".

**DoneWhen**:
- CHK-001 happy, edge, and adversarial verificationIntent entries have passing evidence.
- The new policy is narrow, story-scoped, and command-provenance based.

## CHK-002 Stop TEST-phase delivery and summary artifacts from blocking DONE

**Owner**: Claude Code CLI implementer; Codex supervisor verifies.
**DependsOn**: CHK-001.
**Allowed Files**:
- packages/main/src/handlers/delivery-check.ts
- packages/main/src/handlers/summary.ts
- packages/main/src/handlers/scope-contract.ts
- packages/main/src/core/scope-contract.ts
- packages/main/src/core/done-oracle.ts
- packages/main/src/core/process-fact-registry.ts
- packages/main/src/core/types.ts
- scripts/verify-process-fact-contract.mjs
- scripts/verify-main-branch-runtime-health.mjs

**Implementation**:
- When delivery_check_set and summary_set write their required artifacts, record/emit enough provenance for the lifecycle artifact policy to recognize those exact files.
- Ensure DONE pre-check and scope_contract_check consume the same policy so delivery-check.json and summary.json do not create a TEST self-lock.
- Do not allow scope_contract_acknowledge in TEST and do not allow unrelated files through this path.

**Verify**:
- A TEST story with delivery_check_set and summary_set no longer reports "OUT_OF_SCOPE delivery-check.json" or "OUT_OF_SCOPE summary.json".
- A TEST story with an unrelated file still fails the scope/DONE gate.

**DoneWhen**:
- Required TEST metadata can be generated and consumed without rollback repair.
- Product source and arbitrary file scope protection remains enforced.

## CHK-003 Make convergence_check ignore derived builds and survive symlink loops

**Owner**: Claude Code CLI implementer; Codex supervisor verifies.
**DependsOn**: none.
**Allowed Files**:
- packages/main/src/tasks/gap-analyze.ts
- packages/main/src/handlers/gap.ts
- packages/main/src/core/runtime-artifact-registry.ts
- docs/requirements/decisions/truth-source.md
- scripts/verify-gap-convergence.mjs

**Implementation**:
- Harden convergence scanning so common derived folders such as .build, node_modules, dist/build outputs, and runtime caches are skipped with anchored path rules.
- Use symlink-aware traversal and/or safe stat behavior so ELOOP cannot crash convergence_check.
- Keep docs/story and docs/requirements visible even if derived-directory ignores exist elsewhere.

**Verify**:
- scripts/verify-gap-convergence.mjs creates or simulates a .build symlink loop and asserts convergence_check returns JSON containing "converged" rather than throwing "ELOOP".
- The same test confirms real docs/story drift is still detected.

**DoneWhen**:
- convergence_check gives a normal report in repos containing SwiftPM .build symlink loops.
- Ignore patterns are anchored to derived/runtime dirs and not broad truth-source exclusions.

## CHK-004 Make session_brief next-step respect blocking scope failures

**Owner**: Claude Code CLI implementer; Codex supervisor verifies.
**DependsOn**: CHK-001 and CHK-002.
**Allowed Files**:
- packages/main/src/handlers/session.ts
- packages/main/src/core/done-oracle.ts
- packages/main/src/core/review-scope-binding.ts
- docs/requirements/decisions/story-lifecycle.md
- scripts/verify-session-brief-command-center.mjs
- packages/main/src/tasks/flow-stability-smoke.ts

**Implementation**:
- Make session_brief compute the strongest blocking gate before rendering the next step.
- If scope is blocking, render "Scope gate: blocking" and "DONE is not recommended while scope is blocking" before any DONE hint.
- Preserve existing hints for missing delivery check, missing summary, and fully passing DONE pre-check.

**Verify**:
- A scope-blocking TEST story does not receive a DONE recommendation.
- A story missing only delivery/summary still receives the specific existing reviewer/summary command hint.
- A fully passing story may recommend DONE only after no blocking scope row remains.

**DoneWhen**:
- session_brief and DONE oracle stay consistent, with scope blockers prioritized.

## CHK-005 Prove the full Koala workflow regression path

**Owner**: Claude Code CLI implementer writes tests/evidence; Codex supervisor runs independent verification.
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004.
**Allowed Files**:
- scripts/verify-process-fact-contract.mjs
- scripts/verify-gap-convergence.mjs
- scripts/verify-session-brief-command-center.mjs
- scripts/verify-main-branch-runtime-health.mjs
- docs/requirements/decisions/story-lifecycle.md
- docs/requirements/decisions/truth-source.md

**Implementation**:
- Add regression coverage that ties the policy, TEST lifecycle artifact behavior, convergence scanner hardening, and session_brief next-step behavior together.
- Record verificationEvidence for every verificationIntent entry after real commands pass.
- Final notes must state "does not weaken product source scope enforcement".

**Verify**:
- Run npm --prefix packages/main run build.
- Run node scripts/verify-process-fact-contract.mjs.
- Run node scripts/verify-gap-convergence.mjs.
- Run node scripts/verify-session-brief-command-center.mjs.
- Run node scripts/verify-main-branch-runtime-health.mjs if affected.
- Run koala validate --story B-b9d0, koala check, and koala convergence_check before final phase advancement.

**DoneWhen**:
- All checklist verificationIntent entries are covered by passing verificationEvidence.
- story_review, REVIEW, TEST, delivery_check_set, summary_set, and DONE gates pass without manual rollback solely for Koala lifecycle metadata.
