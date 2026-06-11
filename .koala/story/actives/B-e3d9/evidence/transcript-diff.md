# B-e3d9 TEST Transcript Diff

## Expected

- `gap_analyze` converges from `6 high / 0 medium` uncovered requirements to `0 high / 0 medium`.
- `validate --story=B-e3d9` passes with all checklist `verificationIntent` entries covered.
- Codex adapter verification passes after the canonical `.Lattice` and `.codex` path-casing fix.
- Host-specific Claude/Codex observations remain advisory; Lattice CLI outputs are authoritative gate evidence.

## Actual

- `node bin/lattice.js validate --story=B-e3d9` passed.
  - Project validation command: `npm test` passed.
  - Verification intent coverage: `15/15 covered`, `0 required missing`.
- `node bin/lattice.js gap_analyze` passed.
  - Requirement coverage: `100%`.
  - Test coverage: `100%`.
  - Gaps: `0 high / 0 medium`.
- `node bin/lattice-codex.js verify_codex` passed.
  - Codex manifest, prompt registry, runtime exclusions, native PreToolUse hook, local wrapper/global-thin contract, and aux availability passed.
  - The only note was the expected non-blocking global fallback heartbeat advisory because the global package resolves to the main worktree, not this story worktree.

## Diff Notes

- No product-facing mismatch was observed against the PLAN outcome.
- The original six `gap_analyze` high gaps are closed by current Lattice evidence.
- Additional reviewer-discovered correctness issues were resolved before TEST:
  - Pinned-key receipt verification now still enforces `serverKey.algorithm`.
  - CHK-001 verification intent wording now matches Ed25519 normalization behavior.
  - Codex adapter entrypoints now use canonical case-stable paths for case-sensitive hosts.
  - Verification evidence commands are now mechanically reproducible from the story worktree: package scripts use `npm --prefix packages/main`, local Lattice evidence uses `node bin/lattice.js`, and direct `dist` invocations include a preceding build in the same command string.
- Remaining scope warnings are acknowledged adapter/help/smoke support paths, not unreviewed feature expansion.
