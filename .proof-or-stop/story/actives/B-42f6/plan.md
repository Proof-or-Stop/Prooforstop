# Plan: B-42f6 integrate remote main

## CHK-001: Preserve both main histories and behaviors in one verified merge

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: package-lock.json, package.json, packages/main/package-lock.json, packages/main/package.json, packages/main/src/core/machine.ts, packages/main/src/core/process-fact-registry.ts, packages/main/src/core/proof-or-stop-brand.ts, packages/main/src/handlers/checklist.ts, packages/main/src/tasks/done-required-validation-smoke.ts, packages/main/src/tasks/english-early-check-smoke.ts, packages/main/src/tasks/verification-run-and-guard-smoke.ts
- Create: none
- Test: existing CLI surface, done-required validation, English artifact, and verification-run-and-guard smokes

**Execution**:
- Commit current CLI-owned planning metadata before starting the merge.
- Merge pinned origin/main c853ab5e63, retaining all nonconflicting remote changes as authorized integration input.
- Resolve version synchronization to remote0.3.278. Preserve remote stricter raw-execution context/provenance grouping and signed causal receipt semantics.
- For shared diagnostic/comment conflicts keep the meaning supported by current remote regressions. Retain the local standalone mixed-selector negative regression in addition to remote assertions.
- Inspect the integrated diff against each parent and verify both remain ancestors after the merge commit.
- Build the worktree main/utils/lab/graph artifacts; run targeted overlapping regressions before independent REVIEW and required full verification.

**Verify**:
- git merge-base --is-ancestor d5b00d0ff3 HEAD and git merge-base --is-ancestor c853ab5e63 HEAD both exit0.
- Current playback.js retains exact Proof-or-stop branding and is unchanged from the completed local branding implementation.
- Version consistency and targeted CLI/evidence regressions pass; configured validation and DONE-required commands pass with genuine receipts.
- After DONE, fetch origin/main, preserve any concurrent updates, and publish without force through canonical approval.

**DoneWhen**:
- No unresolved merge conflicts; both parent histories and the branded playback survive.
- Remote provenance/context isolation and local negative-selector coverage remain intact.
- The merged result passes required checks and is integrated into local main. Remote publication remains a separately verified effect under the user's existing authorization.
