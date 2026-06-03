# B-5cea Implementation Plan

## Scope
Fix two Lattice CLI self-development guidance bugs without changing global install semantics: Codex adapter gates must recommend an actually available verify_codex command, and story worktree acceptance must prefer current-worktree local commands while keeping stale global CLI drift advisory.

## Non-Goals
- Do not migrate `koala.config.json` to `lattice.config.json` in this story.
- Do not force global `lattice` to point at a story worktree.
- Do not use Swift or Mac Native App validation as primary delivery evidence.

## CHK-001 Resolve Codex adapter verify command from available wrappers

**Owner**: claude-agent-codex-gate

**Plan**:
1. Add a small resolver in `packages/main/src/core/codex-adapter-checks.ts` that chooses the preferred verify command from existing local wrappers in priority order: `bin/lattice-codex.js`, `bin/koala-codex.js`, `bin/lattice.js`, `bin/koala.js`, then documented global-thin fallback.
2. Use the resolver in `summarizeCodexEvidence` for missing, failing, stale, and default passing details.
3. Update `review-preflight.ts`, `phase-gates.ts`, and `handlers/codex-adapter.ts` so rendered gate labels and recovery hints consume the resolved command instead of hardcoding `LOCAL_CODEX_VERIFY_COMMAND`.

**Verify**:
- A legacy repo fixture with only `bin/koala-codex.js` reports `node bin/koala-codex.js verify_codex`.
- A lattice wrapper fixture reports `node bin/lattice-codex.js verify_codex`.
- Rendered REVIEW preflight output matches the resolver detail.

## CHK-002 Make worktree acceptance guidance prefer current worktree CLI

**Owner**: claude-agent-runtime-guidance

**Plan**:
1. Preserve existing advisory semantics in `checkGlobalFallback`: global core resolving outside the current worktree is warning/heartbeat-only, not a universal hard failure.
2. Replace any stale recovery command on this warning path with a current-worktree local command that actually exists or with the new resolver output.
3. Tighten README/bootstrap wording so story worktree status/validate/gate evidence uses `node bin/lattice.js <command>` after build or `node packages/main/dist/cli.js <command>` for core-only checks.

**Verify**:
- Diagnostics/docs contain `heartbeat-only, not current-worktree gate/status evidence` for stale global fallback.
- The story does not require global CLI mutation and does not hard-fail normal external project global drift.

## CHK-003 Add focused regression tests and delivery evidence

**Owner**: claude-agent-tests-docs

**Plan**:
1. Extend existing Node smokes where possible before creating new tasks: `scripts/verify-codex-assets.mjs` for resolver/gate behavior and `scripts/verify-entrypoints.mjs` for docs/entrypoint guidance.
2. Add a focused task only if existing smokes become too broad or cannot isolate stale-global/current-worktree behavior.
3. Run focused validation after implementation and record verificationEvidence for every intent ref.

**Verify**:
- `npm run test:codex-assets`
- `npm run test:entrypoints`
- `npm --prefix packages/main run build`
- JSON stdout parse check such as `node packages/main/dist/cli.js validate --json` parsed by `JSON.parse` when build artifacts are ready.
- No `swift test` or Mac Native App validation command appears in delivery evidence.
