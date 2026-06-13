# B-4e06 Execution Plan

## Execution Boundary

Do:
- Implement an explicit audited command for legacy stories with passing verificationEvidence but missing verificationIntent.
- Improve story_review and validate diagnostics for evidence-without-intent cases.
- Fix INIT_CHECK worktree bootstrap so configured gitRoot and signed workspace material root are used consistently.
- Add focused smokes for repair, diagnostics, bootstrap, invalid gitRoot, and current checklist_update help health.
- Update requirements docs and built runtime output only where the implementation requires it.

Do not:
- Do not change sourceManifestDigest implementation unless the help import failure reproduces separately.
- Do not modify ClawCreek application code or edit ClawCreek story metadata directly.
- Do not allow verificationEvidence to silently satisfy missing verificationIntent for normal stories.
- Do not add automatic mutation for DONE or DISCARDED stories.
- Do not broaden this story into unrelated adapter or production readiness work.

Stop conditions:
- Stop if evidence refs cannot be mapped deterministically to checklist item, lane, and index.
- Stop if existing authored intent conflicts with reconstructed evidence intent.
- Stop if gitRoot policy would require paths outside the configured metadata root.
- Stop if process fact registry requirements are unclear after adding a new gate-consumed artifact.

## CHK-001

Add the canonical command verification_intent_repair with mode fromEvidence. The command reads checklist state through the normal store, parses existing verificationEvidence intentRef values, and fills only missing verificationIntent lanes for passing evidence. It requires legacyRepair plus a substantial reason outside PLAN, refuses INIT/INIT_CHECK and terminal phases, and does not overwrite existing authored intent unless a future explicit replace flow is designed.

Likely touchpoints:
- packages/main/src/handlers/checklist.ts
- packages/main/src/core/intent-coverage.ts
- packages/main/src/core/command-policy.ts
- packages/main/src/core/process-fact-levels.ts
- packages/main/src/core/process-fact-registry.ts

Verification focus:
- Dry run shows generated entries without writing.
- Real run writes missing lanes from passing evidence.
- Existing authored verificationIntent remains unchanged.
- Malformed refs and failing evidence fail closed with actionable output.

## CHK-002

Update story_review and validate diagnostics while keeping the gate strict. Missing verificationIntent remains a blocker. When matching evidence refs exist, the issue should say this is a legacy evidence-without-intent state and should show verification_intent_repair as the next command. validate should expose the same hint when coverage is blocked by absent intent despite evidence refs.

Likely touchpoints:
- packages/main/src/handlers/story-review.ts
- packages/main/src/core/verification.ts
- scripts/verify-story-review-structured-output.mjs

Verification focus:
- No-evidence missing intent keeps the existing generic blocker behavior.
- Evidence-without-intent adds structured fields or an equivalent stable diagnostic.
- The diagnostic is a hint, not a pass condition.

## CHK-003

Route INIT_CHECK worktree bootstrap through the same signed workspace material root that session_brief already reports. Preserve metadata storage under the configured story root, but run branch and worktree git operations from the actual git repository root. Keep invalid gitRoot failures aligned with signed workspace resolution reasons.

Likely touchpoints:
- packages/main/src/handlers/worktree.ts
- packages/main/src/core/story-signed-workspace-resolution.ts
- packages/main/src/handlers/context.ts
- scripts/verify-init-check-bootstrap.mjs

Verification focus:
- Metadata root can be non-git while gitRoot points to a nested repository.
- story_advance INIT_CHECK creates story branch and worktree without manual setup.
- Invalid gitRoot remains a clear failure.

## CHK-004

Add focused smoke coverage. Prefer one new dedicated smoke for legacy verificationIntent repair and extend existing bootstrap coverage for nested gitRoot if that keeps the test surface smaller. Include a read-only checklist_update --help health check only as a regression guard for the verified P3 state.

Likely touchpoints:
- packages/main/src/tasks/*smoke.ts
- scripts/verify-init-check-bootstrap.mjs
- scripts/verify-process-fact-contract.mjs

Verification focus:
- Repair command happy path, dry run, non-overwrite, malformed refs, protected phase reason.
- Nested gitRoot bootstrap success and invalid gitRoot failure.
- checklist_update --help exits zero without sourceManifestDigest work.

## CHK-005

Sync documentation and runtime output after implementation. Update the execution plan or story lifecycle docs only when the implemented behavior differs from the current plan. Run the package build so the global CLI runtime can expose the new command after main updates.

Likely touchpoints:
- docs/requirements/decisions/lattice-midflight-story-repair-and-gitroot-worktree-plan.md
- docs/requirements/decisions/story-lifecycle.md
- packages/main/dist

Verification focus:
- npm --prefix packages/main run build succeeds.
- node scripts/verify-process-fact-contract.mjs succeeds if process facts changed.
- node scripts/verify-story-review-structured-output.mjs succeeds.
- node scripts/verify-init-check-bootstrap.mjs succeeds.
- lattice checklist_update --help succeeds.
