# Plan: B-1e1f Admit heavy certification only through a PRE_CERT CertificationWindow

## CHK-001: Represent CertificationWindow and the PRE_CERT receipt as signed gate-consumed process facts

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/certification-window.ts
- Create: packages/main/src/handlers/certification-window.ts
- Modify: packages/main/src/cli/command-catalog.ts
- Modify: packages/main/src/core/command-policy.ts
- Modify: packages/main/src/core/process-fact-registry.ts
- Modify: packages/main/src/core/process-fact-levels.ts
- Modify: scripts/verify-process-fact-contract.mjs
- Test: packages/main/src/tasks/certification-window-smoke.ts

**Verify**:
- `node bin/proof-or-stop.js certification_window_status --storyId=B-1e1f` prints `State:` and exactly one `Next:` line
- `npm run test:process-fact-contract` still passes

**DoneWhen**:
- Window states BLOCKED / ADMITTED / RUNNING / FINALIZED / INVALIDATED / CANCELLED exist as a signed artifact
- Commands begin/status/cancel are in the catalog and registry with gateConsumer
- Status never claims inventory completeness is certification

## CHK-002: Admit PRE_CERT only from existing inventory, merge, clean-tree, and coverage facts

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/certification-window.ts
- Modify: packages/main/src/handlers/certification-window.ts
- Modify: packages/main/src/core/done-prepare-validation-reuse.ts (read-only reuse of classifiers)
- Test: packages/main/src/tasks/certification-window-smoke.ts

**Verify**:
- `certification_window_begin` without a FINALIZED inventory refuses `[pre_cert_inventory_not_finalized]`
- Missing main ancestor refuses `[pre_cert_main_not_merged]`
- Open verified blocking findings refuse `[pre_cert_blocking_findings_open]`

**DoneWhen**:
- Admit consumes B-3f3d `finalizedUnconsumedReviewInventory` when present and fail-closes when the export is absent
- Merge/clean reuse done_prepare classifiers; no second freshness hash
- Whole-tree drift is not treated as fresh

## CHK-003: Refuse official heavy certification unless the current window is ADMITTED or RUNNING

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/handlers/done-required-validation.ts
- Modify: packages/main/src/handlers/verifier.ts
- Modify: packages/main/src/core/done-required-validation.ts
- Test: packages/main/src/tasks/certification-window-heavy-choke-smoke.ts

**Verify**:
- `done_required_validate --storyId=<id>` exits non-zero with `[pre_cert_window_required]` before spawning `npm test`
- `validate --channel --story=<id>` still runs
- `validate --full --story=<id>` is refused without an admitted window

**DoneWhen**:
- Heavy allowlist is only done_required_validate, validate --full, and doneRequiredCommands
- A started heavy run binds receipts to the frozen window identity

## CHK-004: Invalidate the window on source, test, or verifier mutation and keep old receipts fail-closed

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/certification-window.ts
- Modify: packages/main/src/handlers/transition-orchestrator.ts
- Modify: packages/main/src/core/runtime-artifact-registry.ts (only if the artifact is outside story metadata)
- Test: packages/main/src/tasks/certification-window-invalidation-smoke.ts

**Verify**:
- After a source commit, `certification_window_status` prints `State: INVALIDATED` and `Next: proof-or-stop story_advance --storyId=<id> --phase=REVIEW`
- Stored receipts keep their original hashes

**DoneWhen**:
- Story metadata and certification evidence writes remain allowed
- Other stories' DEV is not locked
- No extra HEAD-moving commit outside autoCommitStoryMetadata

## CHK-005: Prove a B-9812-shaped premature heavy run is refused and an admitted window runs at most once

**Owner**: lattice-implementer
**DependsOn**: CHK-002, CHK-003, CHK-004
**Files**:
- Create: packages/main/src/tasks/certification-window-replay-smoke.ts
- Modify: packages/main/package.json only if the smoke must join a listed script

**Verify**:
- Focused smoke prints `PRE_CERT replay: premature_heavy_runs=0 admitted_heavy_runs=1 post_cert_source_commits=0` and exits 0

**DoneWhen**:
- Premature heavy path spawns zero child suite processes
- Related story-owned drift requires a second admit
- Reviewer lane / host counts are unchanged
