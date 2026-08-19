# Plan: B-9dcb Thread metadataRoot through review-run snapshot + freshness (wrapper-root custom-storyDir false-stale)

## Execution note (DEV cohesion)

CHK-001..003 are **compile-coupled and same-file**: the durable smoke (CHK-001)
references the post-fix `captureReviewRunSnapshot(projectRoot, context, metadataRoot?)`
signature and the fixed consumer behavior, so the test will not compile until the
production/consumer edits (CHK-002/003 in `core/review-run.ts` + `handlers/review-run.ts`)
land. They are therefore implemented as ONE cohesive change by a single fresh
`lattice-implementer` (fresh-worker-per-item would produce broken intermediate
compiles and re-derived context on the same file region — the parallel/split
condition is not met). CHK-004 registration is part of the same dispatch; the final
`lattice validate` confirmation is main-agent verification.

Reference implementation to mirror: `packages/main/src/tasks/done-oracle-wrapper-root-smoke.ts`
(its B-6666 F-001 section already builds the wrapper-root + custom-storyDir fixture).

## CHK-001: Port the confirmed-failing repro into a durable red/regression test

**Owner**: lattice-implementer
**DependsOn**: none (co-implemented with CHK-002/003 — compile-coupled)
**Files**:
- Create: packages/main/src/tasks/review-run-metadataroot-wrapper-root-smoke.ts
**Verify**:
- `npm --prefix packages/main run build` compiles the new smoke
- `node packages/main/dist/tasks/review-run-metadataroot-wrapper-root-smoke.js` prints `review-run metadataRoot wrapper-root smoke passed`
**DoneWhen**:
- Fixture: metadataRoot (non-git) with `lattice.config.json` declaring a CUSTOM `storyDir`; inner `repo/` gitRoot (branch main) with a material file + a custom-storyDir metadata file, plus a story branch ahead of main.
- Proof A (production snapshot): the fixed `captureReviewRunSnapshot(gitRoot, ctx, metadataRoot)` produces material/story hashes that EXCLUDE the custom-storyDir file; passing metadataRoot=gitRoot (old behavior) INCLUDES it — the two MUST differ.
- Proof B (consumer freshness): after a metadata-only commit to the custom storyDir, the consumer freshness path stays FRESH when metadataRoot is threaded (via `run.workspaceBinding.metadataRoot`) and is FALSE-STALE when signedRoot is used as metadataRoot — the two MUST differ.
- Proof C (legacy fallback): a run with NO workspaceBinding falls back to projectRoot (unchanged behavior).
- Proof D (plain-repo byte-identity): metadataRoot==gitRoot → snapshot + freshness byte-identical whether metadataRoot is defaulted or explicit.
- Uses real-disk fixtures + `resetConfigCache()` in finally, mirroring done-oracle-wrapper-root-smoke.

## CHK-002: Production fix — thread metadataRoot through captureReviewRunSnapshot + diagnoseReviewRunSnapshot

**Owner**: lattice-implementer
**DependsOn**: none (co-implemented)
**Files**:
- Modify: packages/main/src/core/review-run.ts
- Modify: packages/main/src/handlers/review-run.ts
**Verify**:
- `npm --prefix packages/main run build` (tsc clean)
- Smoke Proof A passes
**DoneWhen**:
- `captureReviewRunSnapshot(projectRoot, context?, metadataRoot: string = projectRoot)` computes `currentMaterialHash(projectRoot, 'HEAD', metadataRoot)` and `currentStoryFilesHash(projectRoot, 'HEAD', metadataRoot)`.
- `diagnoseReviewRunSnapshot(projectRoot, metadataRoot: string = projectRoot)` threads metadataRoot into its `currentMaterialHash` EMPTY_MATERIAL_HASH diagnostic (spike caveat — consistency).
- Handler `review_run_start` passes `workspace.metadataRoot || ctx.root` into captureReviewRunSnapshot (and, via captureReviewRunSnapshot, diagnose). `buildReviewRunWorkspaceBinding.metadataRoot` STAYS `workspace.metadataRoot || ctx.root` (already correct at handler:110) so the persisted binding is authoritative.
- Default `metadataRoot = projectRoot` → plain repos byte-identical (Proof D).

## CHK-003: Consumer fix — thread run.workspaceBinding?.metadataRoot ?? projectRoot into the two freshness checks

**Owner**: lattice-implementer
**DependsOn**: CHK-002 (same file `core/review-run.ts`)
**Files**:
- Modify: packages/main/src/core/review-run.ts
**Verify**:
- `npm --prefix packages/main run build` (tsc clean)
- Smoke Proof B + Proof C pass
**DoneWhen**:
- `assertCurrentReviewRunForEvidence` (call site ~:686) and `validateEvidenceRunBinding` (call site ~:826): the 4th arg (metadataRoot) of `checkEvidenceFreshnessForGit(signedProjectRoot, run.headHash, run.materialHash, <metadataRoot>, run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash)` becomes `run.workspaceBinding?.metadataRoot ?? projectRoot`. gitCwd (arg1) stays `signedProjectRoot`.
- Legacy runs without workspaceBinding fall back to `projectRoot` (Proof C).

## CHK-004: Regression guard registration + validate green

**Owner**: lattice-implementer (registration) + main-agent (validate)
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/smoke-manifest.json (add `{ "name": "review-run-metadataroot-wrapper-root", "tags": ["regression","wrapper-root"], "timeoutMs": 60000 }`)
- Modify: packages/main/package.json (add `"test:review-run-metadataroot-wrapper-root": "node dist/tasks/review-run-metadataroot-wrapper-root-smoke.js"`)
**Verify**:
- `lattice validate` all green (picks up the new smoke via manifest/auto-discovery)
**DoneWhen**:
- The durable smoke is registered and runs under `lattice validate`.
- `lattice validate` reports all green; no regression in existing review-run / freshness / done-oracle smokes.
- verificationEvidence recorded for each item's must intents.
