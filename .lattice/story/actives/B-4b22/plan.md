# Plan: B-4b22 Re-shape TEST and DONE blocking around dirty ownership categories

## CHK-001: Define dirty-gate-policy table + evaluateDirtyGate

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/dirty-gate-policy.ts (DIRTY_GATE_POLICY const + evaluateDirtyGate fn + AuditEvent type)

**Verify**:
- Logic test: evaluateDirtyGate with synthetic classifications produces deterministic shape
- Logic test: exhaustive table contract (DIRTY_GATE_POLICY size === DIRTY_WORKTREE_CATEGORIES length)

**DoneWhen**:
- packages/main/src/core/dirty-gate-policy.ts exists and exports DIRTY_GATE_POLICY (const Record<DirtyWorktreeCategory, {blocking: boolean; auditReason: string}>) + evaluateDirtyGate(classification, ctx): EvaluateDirtyGateResult + type AuditEvent
- evaluateDirtyGate throws when DIRTY_WORKTREE_CATEGORIES contains a value not present in DIRTY_GATE_POLICY (preMortem #1)
- DIRTY_GATE_POLICY entries: material_source_changes / fixture_changes / unexpected_dirty_files have blocking:true; the other 3 have blocking:false with human auditReason

## CHK-002: Consume policy from story-advance + validation-executor

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-advance.ts (buildDoneChecklist git-working-tree row now uses evaluateDirtyGate; status follows allPass; detail/hint follow uniform format)
- Modify: packages/main/src/core/validation-executor.ts (formatWorktreePollutionDetails uses evaluateDirtyGate; pollution.allPass adjusts ValidationCommandResult.allPass)
- Modify: packages/main/src/handlers/verifier.ts (if needed to thread allPass through)

**Verify**:
- `koala story_advance --phase=TEST` (and DONE) on worktree with only passing categories → row passes
- Same with at least one blocking category present → row fails, detail names blocking categories
- Validation side-effect guard mirrors same format for allPass and detail wording

**DoneWhen**:
- story-advance.ts no longer hardcodes status:fail for ANY dirty (line 421); calls evaluateDirtyGate via imported policy
- validation-executor.ts pollution detail formatting calls evaluateDirtyGate and respects allPass
- Both consumers import from dirty-gate-policy.ts; grep proof in smoke

## CHK-003: Audit log when category passes

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/dirty-gate-policy.ts (evaluateDirtyGate accepts a writer fn; default writer appends to process-events.jsonl)
- Modify: packages/main/src/core/store.ts (if needed: existing process-events append helper)
- Modify: packages/main/src/handlers/story-advance.ts + validation-executor.ts (pass storyId + gate name into evaluateDirtyGate)

**Verify**:
- Per allowed category, one line in `.koala/story/actives/<storyId>/process-events.jsonl` with type=dirty_gate_audit and required fields
- If writer fn throws (fs error), evaluateDirtyGate degrades to allPass=false and surfaces AUDIT WRITE FAILED in result.hint

**DoneWhen**:
- AuditEvent schema: { type:'dirty_gate_audit', storyId, gate, category, pathCount, paths (≤5), reason, timestamp }
- Writer injection via dependency parameter to support smoke fixture stubbing (preMortem #2 anchor)
- evaluateDirtyGate fallback path explicitly tested (write throws → allPass:false + AUDIT WRITE FAILED)

## CHK-004: Regression smoke + invariants

**Owner**: koala-implementer
**DependsOn**: CHK-001..003
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (assertDirtyGatePolicyBlocking + assertDirtyGatePolicyPassing + assertDirtyGatePolicyRegistry + assertDirtyGateAuditFailure + assertDirtyGateImportIsolation)
- Modify: packages/main/src/tasks/validation-protocol-smoke.ts (assert validation-executor side-effect path uses same evaluator output)

**Verify**:
- `npm --prefix packages/main run test:flow-stability-smoke` passes
- `npm --prefix packages/main run test:validation-protocol` passes
- Both print `✓ passed`

**DoneWhen**:
- Smoke covers: blocking (3 categories coexist), passing (3 categories coexist), B-3506 + B-cf60 scenarios, registry/policy invariant, audit-write-failure fallback, import-isolation grep
- assertDirtyGateImportIsolation: grep packages/main/src/handlers/story-advance.ts AND packages/main/src/core/validation-executor.ts; assert all DIRTY_WORKTREE_CATEGORIES literal mentions come from dirty-gate-policy import (preMortem #3 anchor)

## Validation

After evidence is recorded:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:validation-protocol`
- `npm --prefix packages/main run test:verification-freshness-smoke` (regression — B-a2f1 must not break)
- `koala validate --story=B-4b22 --json`

## Rollback

If gate policy needs to revert to B-6326 behavior, swap DIRTY_GATE_POLICY entries to all-blocking:true; evaluateDirtyGate then reproduces any-dirty-blocks output and audit log naturally falls to empty. Smoke tests for blocking categories still pass; tests for passing categories should be skipped or marked xfail during rollback window.
