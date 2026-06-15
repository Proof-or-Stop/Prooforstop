## CHK-001 Remove koala CLI alias runtime behavior

Goal: make the CLI product line, help output, runtime fact registry, runtime environment checks, and local bootstrap behavior lattice-only. Remove the `legacy alias: koala` product wording and stop treating `koala` / `koala-codex` / `@koala-agent/core` / `node_modules/.bin/koala` as valid active runtime fallback paths.

Steps:
- Update `packages/main/src/core/lattice-brand.ts` so the brand model has only the primary lattice bin and no legacy alias field or legacy invocation branch.
- Update `packages/main/src/cli-engine.ts` help and unknown-command guidance to remove `legacy alias` and `Compatible: koala` style output.
- Update `packages/main/src/core/runtime-fact-registry.ts` and `packages/main/src/core/runtime-environment-checks.ts` to report lattice-only entrypoint expectations and stale local/global koala artifacts as non-compatible.
- Update `packages/main/src/init-assets.ts`, `packages/main/src/cli-init.ts`, and `packages/main/src/handlers/lattice-cli.ts` where they still describe or generate koala runtime compatibility.

Verification:
- `node bin/lattice.js --version` contains `Lattice CLI 0.3.5` and no `koala` or `legacy alias`.
- `node bin/lattice.js help` and `node bin/lattice.js story_create --help` contain no active koala compatibility text.
- `node scripts/verify-runtime-fact-contract.mjs` passes with lattice-only expectations.

## CHK-002 Update Codex and generated assets to lattice-only wrappers

Goal: Codex adapter behavior and generated assets must use `bin/lattice-codex.js` and `bin/lattice.js` only. Legacy `.Codex/koala.json`, `.codex/koala.json`, `bin/koala-codex.js`, and `bin/koala.js` should not be accepted as active compatibility assets.

Steps:
- Update `packages/main/src/core/codex-adapter-checks.ts` so wrapper command resolution, material paths, and local-wrapper checks prefer/require lattice wrappers only.
- Update `packages/main/src/core/managed-assets.ts` and `packages/main/src/init-assets.ts` so new or managed projects generate lattice wrappers/manifest paths without preserving legacy koala asset selection.
- Update repository Codex assets (`.Codex/README.md`, `.codex/README.md`, `.Codex/lattice.json`, `.codex/lattice.json`) to document lattice-only commands.
- Remove or retire generated compatibility files in this repository when they are generated alias assets rather than historical evidence.

Verification:
- `node bin/lattice-codex.js session_brief` succeeds.
- `node bin/lattice.js verify_codex` succeeds and records codex adapter verification for lattice wrappers.
- `node scripts/verify-codex-assets.mjs` and `node scripts/verify-entrypoints.mjs` pass after their assertions are updated.

## CHK-003 Replace compatibility smokes with absence assertions

Goal: tests should fail if koala runtime alias compatibility is reintroduced. The old preservation smoke should be removed or converted so the enforced contract is absence, not compatibility.

Steps:
- Update `packages/main/package.json` to remove any compatibility smoke script whose only purpose is to prove legacy koala support.
- Update `rollout-check-smoke`, `cli-engine-branding-smoke`, `session-brief-prompt-sync-smoke`, `lattice-cli-migration-smoke`, Codex asset smokes, and entrypoint/runtime contract scripts to assert lattice-only active behavior.
- Keep deliberate historical/process exceptions narrow: reviewer lane names, KOALA_* environment variables, legacy data-read paths, and archived documentation are not runtime alias compatibility.
- Update active docs (`README.md`, `docs/guide-hooks.md`, `docs/requirements/decisions/project-vision.md`, `docs/requirements/decisions/testing-infra.md`, `docs/requirements/decisions/stack-layering.md`) so they no longer instruct users to verify or rely on the koala alias.

Verification:
- `npm --prefix packages/main run build` passes.
- Targeted tests and scripts pass: rollout branding smoke, session brief prompt sync smoke, runtime fact contract, Codex asset verification, entrypoint verification, and `node bin/lattice.js verify_codex`.
- An active-source search for `legacy alias: koala`, `Compatible: koala`, `@koala-agent/core fallback`, and generated `bin/koala*.js` compatibility expectations has zero non-excluded hits.
