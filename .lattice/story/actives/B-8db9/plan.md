# Plan: B-8db9 Fix declared-artifact gate bypass and uncommitted-artifact loss

## CHK-001: Reorder dirty classifier — declared check after material/fixture

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/dirty-worktree.ts (`classifyParsedRow`: move the `isDeclaredArtifactPath` branch to AFTER `isFixturePath` and `isMaterialSourcePath`, immediately before the `unexpected_dirty_files` fallthrough)
- Test: packages/main/src/tasks/flow-stability-smoke.ts

**Verify**:
- Dirty path under tests/output/ declared as artifact → `declared_artifact_changes`
- Dirty source file declared as artifact → `material_source_changes`
- Dirty fixture file declared as artifact → `fixture_changes`

**DoneWhen**:
- `classifyParsedRow` order is: koala_metadata → runtime_artifact → fixture → material → declared → unexpected
- A declared path can only rescue rows that would otherwise be `unexpected_dirty_files`
- Hand-injected declared-artifacts.json with a source path does NOT change that path's classification away from material_source_changes

## CHK-002: Reject material/fixture/config/metadata paths at artifact_declare entry

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/artifact-declare.ts (extend `assertSafePath` or add `assertDeclarablePath` that classifies the path and rejects material_source / fixture / koala_metadata / config categories)
- Test: packages/main/src/tasks/flow-stability-smoke.ts

**Verify**:
- `artifact_declare --path=packages/main/src/core/store.ts` → rejected with classification-named error
- `artifact_declare --path=<fixture path>` / `<config path>` / `<koala metadata path>` → rejected
- `artifact_declare --path=tests/output/foo.json` → succeeds

**DoneWhen**:
- Entry rejection uses the SAME classifier routine (`isMaterialSourcePath`/`isFixturePath`/`isStoryMetadataPath`/config detection) as dirty-worktree.ts — no divergent path logic
- Rejection error names the offending category and tells the user to declare only generated output paths
- Runtime check at handler entry (Handler 编码约定); the two layers (CHK-001 classifier + CHK-002 entry) agree for a sample of paths

## CHK-003: Block uncommitted declared artifacts at the DONE gate

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-advance.ts (`buildDoneChecklist`: add a `declared-artifacts-committed` row)
- Optionally create: packages/main/src/core/declared-artifact-commit-check.ts (pure fn for committed-state evaluation)
- Modify: packages/main/src/core/process-fact-registry.ts (register the new `declared-artifacts-committed` DONE gate row as a process fact — story-lifecycle.md「流程事实双层契约」requires registry + verifier sync when adding a gate)
- Test: packages/main/src/tasks/flow-stability-smoke.ts

**Verify**:
- All declared paths committed-and-clean → row `[✓] declared artifacts committed: N/N`
- A dirty/untracked declared path → row `[✗] ... (uncommitted: ...)` blocking, with commit/cleanup guidance
- An absent declared path → not blocking
- A git-ignored declared path → blocking with explicit "git-ignored paths must not be declared as deliverables" message
- `npm --prefix packages/main run test:process-fact-contract` passes (registry + contract verifier in sync)

**DoneWhen**:
- DONE-only check; `dirty-gate-policy.ts` DIRTY_GATE_POLICY table is NOT modified (REVIEW/TEST keep declared_artifact_changes non-blocking)
- Committed-state evaluation uses `git ls-files` + `git status --porcelain` to distinguish committed-clean / dirty / untracked / ignored / absent
- Blocker surfaces in the DONE gate error list
- The new gate row is registered in `process-fact-registry.ts` and `npm run test:process-fact-contract` confirms the process-fact inventory still proves the hard fallback exists

## CHK-004: Regression-cover the full attack chain

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (add `assertDeclaredArtifactGateHotfix` block)
- Modify: packages/main/src/tasks/validation-protocol-smoke.ts (attack-chain regression in side-effect-guard context)

**Verify**:
- `npm --prefix packages/main run test:flow-stability-smoke` → `✓ passed`
- `npm --prefix packages/main run test:validation-protocol` → `✓ passed`

**DoneWhen**:
- Smoke covers: declare-source-rejected, declare-fixture-rejected, source-dirty-stays-material (even when declared), fixture-dirty-stays-fixture (even when declared), hand-injected-json-source-stays-material, uncommitted-declared-blocks-DONE, committed-declared-passes-DONE, git-ignored-declared-blocks-DONE, declared-output-non-blocking-in-REVIEW/TEST
- Uses the literal attack path `packages/main/src/core/store.ts` and a `tests/output/` generated path

## Validation

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:validation-protocol`
- `npm --prefix packages/main run test:verification-freshness-smoke` (regression — B-a2f1/B-3506/B-cf60 must still pass)
- `koala validate --story=B-8db9 --json`

## Rollback

CHK-001 (classifier reorder) is a pure statement-order change; reverting restores prior behavior. CHK-002/CHK-003 are additive (new rejection branch + new DONE row); each can be reverted independently without affecting the others. The classifier reorder alone closes the CRITICAL bypass, so even a partial rollback keeps the security boundary intact.
