# B-50fb Execution Plan

## CHK-001
Rename the published package metadata so the canonical public package identity is Lattice-branded. Update package names and workspace dependency edges for core, utils, lab, and example CLI packages from `@koala-agent/*` to `@lattice-agent/*`. Keep the `lattice` binary primary and retain `koala` only as an explicit legacy bin alias where current users may still invoke it.

Expected user-visible result: package metadata inspection prints `@lattice-agent/core` at version `0.3.5`, and no canonical package name in package manifests still uses `@koala-agent/*`.

Implementation notes:
- Update root and workspace package metadata coherently.
- Refresh lockfiles through npm tooling or equivalent deterministic metadata edits.
- Do not remove the legacy `koala` command alias in this story.

Verification focus:
- Metadata assertion over package.json and lockfiles.
- Install/build behavior does not leave unresolved old package dependencies.

## CHK-002
Update runtime and bootstrap resolution so `@lattice-agent/core` is canonical in code paths that locate local or global packages. Where existing installed projects can still have `@koala-agent/core`, support it as a clearly named legacy fallback.

Expected user-visible result: runtime diagnostics refer to canonical `@lattice-agent/core`; if a legacy `@koala-agent/core` path is detected, diagnostics label it as legacy compatibility instead of presenting it as the current package.

Implementation notes:
- Prefer constants/helpers for package scope names and package path construction.
- Update worktree relink, runtime environment checks, Codex adapter checks, init bootstrap, rollout checks, and prompt registry source.
- Keep fallback bounded to package resolution and compatibility diagnostics, not new canonical docs.

Verification focus:
- Existing runtime contract scripts pass with updated canonical package facts.
- Fallback behavior remains testable and does not mask stale canonical resolution.

## CHK-003
Refresh user-facing docs, truth-source docs, and verification scripts that present `@koala-agent/core` as the canonical package. Keep historical or explicitly legacy references only when they are clearly described as compatibility or history.

Expected user-visible result: README/runtime docs describe global `lattice` as coming from `@lattice-agent/core`, with old `@koala-agent/core` references only marked legacy.

Implementation notes:
- Update README and relevant requirements decisions listed in relatedDocs.
- Update scripts that assert package names or dependency scopes.
- Avoid broad historical rewrite across migrated legacy docs unless a stale line would be consumed as current guidance.

Verification focus:
- Search confirms canonical package references use `@lattice-agent/*` in active docs/code paths.
- Verification scripts are aligned with new package names.

## CHK-004
Verify the rename end to end before advancing. The story is high-risk because package identity participates in runtime diagnostics and validation surfaces, so evidence must cover metadata, build/typecheck, runtime contract checks, and Lattice validation.

Expected user-visible result: terminal output shows package metadata checks passing and `lattice validate --story=B-50fb` passing for the story.

Verification commands to consider:
- Metadata assertion for workspace package names/dependencies.
- `npm install` or deterministic lockfile refresh if needed in the story worktree.
- `npm --prefix packages/main run build` or repo-standard build/typecheck.
- `node scripts/verify-entrypoints.mjs`.
- `node scripts/verify-global-lab-entrypoint.mjs` if still present and applicable after dependency updates.
- `node bin/lattice.js verify_codex` if adapter assets, prompt templates, `.Codex`, or `.claude` generation behavior is touched.
- `lattice validate --story=B-50fb`.
