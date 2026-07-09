## CHK-001

Goal: make partial-DONE recovery perform the same runtime semver bump decision as the normal DONE merge path.

Implementation steps:
1. Import `bumpVersionOnDoneMerge` into `packages/main/src/handlers/done-recover.ts`.
2. After `recoveryMergeChangedPaths` and `runtimeSemverChanged` are computed, call `bumpVersionOnDoneMerge({ mainMergeRoot, shouldBump: runtimeSemverChanged, runGit })` before `runDoneMainPackageBuildAfterMerge`.
3. Keep artifact and capability release ledger calls unchanged, still receiving the same `runtimeSemverChanged` value.
4. Extend an existing recovery smoke or version smoke so a runtime-changing recovery proves the auto-bump line and commit call happen before build.

Verification:
- Build must pass.
- Focused smoke must cover runtime-changing recovery and metadata-only recovery skip behavior.
- Source check must show no recovery path can compute `runtimeSemverChanged` without using it for version bump.

## CHK-002

Goal: make patch bump synchronize all documented version sources, including lockfiles.

Implementation steps:
1. Extend `VERSION_SYNC_FILES` / `VERSION_SYNC_PATHS` in `packages/main/src/core/version-bump.ts` with `package-lock.json` and `packages/main/package-lock.json`.
2. Read both lockfile top-level versions, and for root package-lock also verify the root package entry and `packages/main` package entry where present. For the nested package-lock, verify its top-level and root package entry.
3. Update lockfile contents structurally through JSON parse/serialize, preserving rollback semantics used by the existing bump plan.
4. Extend `version-bump-smoke.ts` fixtures to include both lockfiles and add drift, missing-version, and rollback coverage.

Verification:
- `node packages/main/dist/tasks/version-bump-smoke.js` passes after build.
- Smoke asserts all package/lockfile/brand sync points land on the next patch and roll back together on verification failure.

## CHK-003

Goal: restore a consumable local version boundary for the already-merged B-90d6 runtime changes without remote release.

Implementation steps:
1. Ensure the final local DONE completion of this story bumps beyond `0.3.170` and synchronizes `package.json`, `package-lock.json`, `packages/main/package.json`, `packages/main/package-lock.json`, `packages/main/src/core/lattice-brand.ts`, and dist brand after build.
2. Use the story worktree build/dist CLI for closure if needed so the new lockfile-sync finalizer, not stale main dist, performs the bump.
3. Do not run `git push`, `npm publish`, or `scripts/release.mjs publish`.

Verification:
- `npm --prefix packages/main run build` passes.
- Package metadata and source/dist brand versions agree.
- `lattice --version` reports the new local patch version after merge/build.
- Git history contains local commits only; remote publish remains untouched.
