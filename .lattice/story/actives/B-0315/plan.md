# Plan: B-0315 Bump CLI version for capability contract proof changes

## Goal

Add a bounded DONE merge version-bump policy so CLI capability contract and proof changes are visible in the CLI patch version, without turning semver into a repository-wide documentation or experiment ledger.

## CHK-001: Add capability contract inputs to DONE version bump predicate

**Owner**: main-agent

**DependsOn**: none

**Files**:
- Modify: `packages/main/src/handlers/done-effects.ts`
- Test: `packages/main/src/tasks/version-bump-smoke.ts`

**Implementation**:
- Extend the existing DONE merge changed-path predicate to treat `docs/CLI.md` as a watched CLI capability contract input.
- Extend the same predicate to treat `packages/main/tests/**` as watched CLI capability proof/regression inputs.
- Keep existing runtime/package inputs unchanged.
- Keep `.lattice/**`, `experiments/**`, arbitrary `docs/requirements/**`, and general docs outside this bump policy.

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/version-bump-smoke.js`
- Smoke assertions prove:
  - `docs/CLI.md` returns `true`.
  - `packages/main/tests/milestone-status.test.mjs` returns `true`.
  - `docs/requirements/decisions/story-lifecycle.md` returns `false`.
  - `experiments/tier-c-proof/sum.mjs` returns `false`.

**DoneWhen**:
- The changed-path predicate returns true for the two bounded capability/proof input classes.
- The predicate still returns false for unrelated docs/requirements and experiment harness paths.
- No package version file is manually edited in DEV.

## CHK-002: Update smoke coverage and lifecycle docs for the new bounded policy

**Owner**: main-agent

**DependsOn**: CHK-001

**Files**:
- Modify: `packages/main/src/tasks/version-bump-smoke.ts`
- Modify: `packages/main/src/core/version-bump.ts`
- Modify: `docs/requirements/decisions/story-lifecycle.md`
- Test: `packages/main/src/tasks/version-bump-smoke.ts`

**Implementation**:
- Add focused smoke assertions for the positive and negative path classes introduced by CHK-001.
- Update the version-bump skip line so it says no watched CLI/runtime or capability contract inputs changed.
- Update story lifecycle documentation to name the bounded capability contract/proof input class and explicitly retain the exclusions.

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/version-bump-smoke.js`
- Documentation text includes the bounded inputs:
  - `docs/CLI.md`
  - `packages/main/tests/**`
- Documentation text keeps the non-goals:
  - no all-docs bump policy
  - no `experiments/**` bump policy
  - no paper artifact bump policy

**DoneWhen**:
- The smoke test output passes with the expanded policy checks.
- The docs and user-visible skip line describe the same predicate behavior.
- The strategy is understandable to hosts handling future B-3a4d-like DONE convergence.

## Non-goals

- Do not manually bump `package.json`, `packages/main/package.json`, or `packages/main/src/core/lattice-brand.ts` during DEV.
- Do not broaden the watched set to all `docs/**`.
- Do not add `experiments/**`, paper artifacts, or arbitrary requirements documents to the CLI version bump policy.
- Do not change major/minor semver behavior.
- Do not split the shared build trigger and version-bump trigger in this story.

## User-visible done signal

After completion, a future story that changes `docs/CLI.md` or `packages/main/tests/**` and reaches DONE is treated as touching watched CLI capability inputs: the DONE merge runs the package build and patch-version bump path. A future story that changes only unrelated requirements docs or `experiments/**` still prints the bounded skip message instead of bumping.
