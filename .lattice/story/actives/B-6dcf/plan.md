# Execution Plan

## Boundary

Do: add explicit managed asset root diagnostics to lattice check JSON/text output and cover wrapper-root projects where metadataRoot differs from configured gitRoot.

Do not: move managed asset writes into gitRoot, run lattice check --apply in ClawCreek, change doctor/gitRoot execution behavior, or change release/global install behavior.

Stop if: the implementation requires changing relPath/applied semantics, moving managed assets across roots, or broadening into external project housekeeping.

Allowed files: packages/main/src/core/managed-assets.ts, packages/main/src/handlers/check.ts if needed, scripts/verify-entrypoints.mjs or an equivalent task file, and only closely related docs if the CLI contract needs documentation.

## CHK-001 - Expose managed asset root diagnostics in lattice check results

Implementation steps:
1. Extend ManagedAssetCheckResult with root diagnostic fields: metadataRoot, assetRoot, gitRoot, pathsRelativeTo, and a boolean that identifies whether assetRoot and gitRoot differ.
2. Populate metadataRoot and assetRoot from the existing runManagedAssetCheck root argument.
3. Resolve gitRoot for diagnostics only using the existing project-level gitRoot resolver. If no gitRoot resolves, return null explicitly.
4. Preserve existing relPath, applied, manifestPath, items, profile, assetMode, mode, warnings, and summary semantics.

Verification:
- Parse lattice check --json output and assert the new fields exist.
- Assert metadataRoot/assetRoot are populated even when gitRoot is null.
- Assert relPath/applied remain relative strings and are not reinterpreted as gitRoot-relative.

## CHK-002 - Render clear path-base guidance in lattice check text output

Implementation steps:
1. Update renderManagedAssetCheck so the root context appears immediately after the summary for both OK and DRIFT output.
2. State that managed asset relPath, applied paths, and manifestPath are relative to assetRoot.
3. Show gitRoot separately when it differs, using wording that makes the split visible before the apply recommendation.
4. Keep wording concise for normal projects where assetRoot equals gitRoot or gitRoot is unavailable.

Verification:
- Generate text output from a clean fixture and a drift fixture.
- Assert root guidance appears before any check --apply recommendation.
- Assert wrapper-root output shows both assetRoot and gitRoot as separate paths.

## CHK-003 - Add wrapper-root regression coverage for lattice check diagnostics

Implementation steps:
1. Add a focused regression to the existing entrypoint verification script or an equivalent task.
2. Build a temporary fixture with metadataRoot as a non-git wrapper directory and configured gitRoot as a nested git repo.
3. Run lattice init or create the minimal managed-asset shape required for check to execute.
4. Run check in JSON and text modes and assert root diagnostics distinguish metadataRoot/assetRoot from gitRoot.
5. Run check --apply against the temporary fixture only and assert files are created or updated under metadataRoot, not under the nested gitRoot.

Verification:
- npm --prefix packages/main run build
- node scripts/verify-entrypoints.mjs, or the narrower package script that owns entrypoint checks if available.
- lattice check --json from the worktree to inspect real output shape.
