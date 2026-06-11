# B-b95c User-Value Transcript Diff

## Expected

Fresh project initialization should present Lattice as the primary asset name while preserving legacy Koala compatibility:

- New init creates `LATTICE.md`, `bin/lattice.js`, `bin/lattice-codex.js`, and `.Codex/lattice.json`.
- New init does not create duplicate Koala-named local wrappers/manifests by default.
- Existing legacy Koala assets remain accepted by managed checks and Codex verification.
- Codex prompt docs distinguish full asset mode (`.Codex/agents` materialized) from thin mode (registry via `.Codex/lattice.json`).
- Runtime diagnostics prefer `lattice`, fall back to `koala`, and detect project-local `node_modules/.bin/lattice` shadowing.

## Actual

Validation commands run during TEST confirmed the expected behavior:

- `koala validate --json` passed during REVIEW→TEST preflight and wrote `test-evidence.json`.
- `npm --prefix packages/main run test:lattice-branded-init-smoke` passed: fresh init writes Lattice primary assets and omits Koala-named generated assets.
- `npm --prefix packages/main run test:legacy-koala-compatibility-smoke` passed: legacy Koala manifest/wrapper paths remain accepted.
- `npm --prefix packages/main run test:validation-protocol` passed: runtime footprint checks include project-local `node_modules/.bin/lattice` shadow detection and legacy `koala` fallback coverage.
- `npm --prefix packages/main run test:runtime-fact-contract` passed: repair hints and PATH probing prefer `lattice || koala`.
- `KOALA_SESSION_ID=sess-e47326b32182b79a node bin/koala-codex.js verify_codex` passed hard Codex adapter checks, with only a non-hard global fallback advisory.

## Diff

No user-visible gap remains for the requested naming migration. New projects get Lattice-named local assets; old Koala projects are still readable/verifiable. The only observed advisory is that the globally installed fallback CLI points at another worktree, which the tool reports as heartbeat-only and not current-worktree gate evidence.
