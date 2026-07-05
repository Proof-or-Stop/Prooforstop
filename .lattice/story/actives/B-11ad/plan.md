# B-11ad Plan — Artifact Release Provenance Ledger

## Scope Boundary

This story adds a separate non-runtime artifact release ledger for DONE-delivered artifacts. It does not expand CLI package semver bump rules, does not alter remote publish policy, and does not treat `.lattice/story/**` lifecycle metadata as releasable product output.

## CHK-001 — Add artifact release ledger and non-runtime artifact digest classification

Implementation steps:

1. Create `packages/main/src/core/artifact-release.ts` with pure helpers for path normalization, releasable non-runtime path classification, artifact-set digesting, JSONL read/write, idempotency key generation, and text rendering.
2. Classify these as releasable V1 artifacts: `experiments/**`, project documentation under `docs/**`, and declared/generated product artifacts when passed as explicit changed paths. Exclude `.lattice/**`, `packages/main/src/**`, package manifests/locks, and existing DONE runtime build inputs.
3. Make `recordArtifactReleaseForDoneMerge` no-op when no releasable paths exist, and idempotent when the same story id, main commit, and artifact-set digest already exist.
4. Keep the digest deterministic: sorted normalized paths plus their git object/blob hash at the DONE merge commit where available.

Verification:

- Smoke proves `experiments/**` produces a stable `sha256:` digest.
- Smoke proves `.lattice/**` and watched CLI/runtime inputs produce no release row by themselves.
- Smoke proves mixed runtime + experiment paths can produce an artifact ledger row while version-bump predicate remains a separate decision.

## CHK-002 — Expose artifact release inspection commands and DONE post-merge report line

Implementation steps:

1. Add `packages/main/src/handlers/artifact-release.ts` with read-only `artifact_release_list` and `artifact_release_status` handlers.
2. Register the handlers in `packages/main/src/registry.ts` and expose schemas in `packages/main/src/cli/command-catalog.ts`.
3. In `packages/main/src/handlers/done-effects.ts`, after `doneMergeChangedPaths` is computed and semver/build effects run, call the artifact release recorder and append a DONE report line only when a record is written or already exists.
4. Render explicit provenance wording: `artifact release recorded`, `artifact release already recorded`, or no line for empty non-runtime artifact sets.

Verification:

- Smoke exercises list/status text and JSON renderers.
- Smoke verifies idempotency for repeated record calls.
- Build confirms command catalog and registry compile.

## CHK-003 — Document the semver/provenance boundary and validate with smoke coverage

Implementation steps:

1. Add the new smoke task to `lattice.config.json` validate commands.
2. Update `docs/requirements/decisions/story-lifecycle.md` to state that CLI patch version remains a runtime/capability marker and non-runtime DONE artifacts use the artifact release ledger.
3. Update `docs/CLI.md` with concise command examples for `artifact_release_list` and `artifact_release_status`.
4. Leave `version-bump-smoke` assertions intact so `experiments/**` still does not trigger CLI semver.

Verification:

- `npm --prefix packages/main run build` passes.
- `node packages/main/dist/tasks/artifact-release-ledger-smoke.js` passes.
- `node packages/main/dist/tasks/version-bump-smoke.js` passes.
- `lattice validate --storyId=B-11ad` passes before DONE.
