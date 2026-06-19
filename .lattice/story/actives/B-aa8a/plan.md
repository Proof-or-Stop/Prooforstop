# Plan: Auto-bump patch version on DONE merge to local main (B-aa8a)

Chosen option: bump-in-done-effects-pure-module. A pure, hermetically testable
core/version-bump.ts, wired into the existing DONE post-merge effect under the
merge-lock, gated on the same material-change predicate as the dist rebuild.

## CHK-001 — Patch-bump the 3 version sync points in the DONE post-merge effect

New module `packages/main/src/core/version-bump.ts` (MUST NOT import done-effects.ts):
- `parseSemver(v)` / `formatSemver` — strict X.Y.Z parse; throw on malformed.
- `nextPatch(v)` — 0.3.9 -> 0.3.10 (patch-only; minor/major untouched).
- `readSyncedVersion(root)` — read the version from all 3 sync points (root package.json `version`, packages/main/package.json `version`, the `LATTICE_CLI_VERSION = X.Y.Z` literal in packages/main/src/core/lattice-brand.ts); assert all 3 identical, else throw a clear drift error naming each value.
- `applyPatchBump(root)` -> {from,to,files} — readSyncedVersion -> nextPatch -> write all 3 -> re-read to verify identical. Pure filesystem, NO git. Hermetically testable against a temp dir.
- `bumpVersionOnDoneMerge({mainMergeRoot, shouldBump, runGit})` -> report line. If !shouldBump return "✓ version bump skipped (no material code change)". Else applyPatchBump(mainMergeRoot), then runGit(add the 3 files) + runGit(commit -m "chore: bump lattice cli to <to>"); return "✓ version auto-bumped <from> → <to> across 3 sync points after DONE merge". On any failure throw a loud recovery message (manual 3-point sync), matching runDoneMainPackageBuildAfterMerge failure style.

Wire into `packages/main/src/handlers/done-effects.ts` applyDoneMergeEffects, AFTER Step 3 merge and BEFORE the runDoneMainPackageBuildAfterMerge call (~line 878):
- compute `changedPaths = listChangedPathsBetweenMainShas(mainMergeRoot, before, after)` once;
- `shouldBump = shouldBuildDoneMainPackageForChangedPaths(changedPaths)`;
- `mergeLines.push(bumpVersionOnDoneMerge({mainMergeRoot, shouldBump, runGit: runGitArgs}))` BEFORE the build; pass changedPaths into the build call to avoid recompute.
- Ordering guarantees: bump writes source -> existing rebuild compiles lattice-brand -> dist reports the new version with no extra build; bump commit lands on main under the merge-lock.

## CHK-002 — Hermetic smoke (positive, negative, consistency, idempotency)

New `packages/main/src/tasks/version-bump-smoke.ts`:
- unit: nextPatch(0.3.9)=0.3.10, nextPatch(1.2.0)=1.2.1; malformed semver throws.
- applyPatchBump on a temp dir with 3 fixture files all at 0.9.9 -> all become 0.9.10, identical, minor/major unchanged; re-read confirms sync.
- drift detection: fixture with mismatched versions -> readSyncedVersion/applyPatchBump throws.
- gate (import shouldBuildDoneMainPackageForChangedPaths + isDoneMainRuntimeBuildInput from done-effects.js): [packages/main/src/x.ts]->true, [.lattice/story/B-x/index.json]->false, [package.json]->true.
- bumpVersionOnDoneMerge with shouldBump=false -> returns the skip line, NO filesystem change.
- bumpVersionOnDoneMerge with shouldBump=true + injected runGit capturing args -> files bumped AND a git add + a "chore: bump" commit were issued; returns the bump line.
- idempotency: applyPatchBump twice on a fresh fixture increments by exactly 1 each (computed from current state, no accumulation).
- Register the smoke in lattice.config.json validate.commands.
