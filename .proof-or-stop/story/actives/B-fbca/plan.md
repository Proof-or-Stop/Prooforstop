# Plan — B-fbca: zero koala in packages/*/src (except the residue-gate self-IDs) — ship-clean story 3 (full)

## Goal & scope
Drive packages/*/src to zero koala except the deferred residue-gate self-IDs. Sign every gate in
this story via the WORKTREE binary (new salt). Keep tsc + suite green and the residue gate PASS.

Out of scope: KOALA_RESIDUE_*/koala-residue in handlers/review-preflight.ts + scripts/verify-koala-residue.mjs
and the gate zero-tolerance flip (story 4); docs/experiments (story 4); .lattice/story history (kept).

## CHK-001 — Rename the 8 koala-* signature salts to lattice-*
koala-review-integrity-v1, koala-review-pass-integrity-v1, koala-review-run-integrity-v1,
koala-review-run-workspace-binding-v1, koala-review-scope-binding-v1, koala-scope-check-integrity-v1,
koala-finding-integrity-v1, koala-story-store across guard-utils/machine/process-fact-registry/
reviewer-status/story-review/canonical-story/finding-verify/review-run/review-scope-binding/scope-check
(+ smokes). Sign this story's gates via the worktree binary.

## CHK-002 — Delete the legacy-koala detection
managed-assets.ts excluded-path denylist (bin/koala.js, bin/koala-codex.js, .codex/koala.json,
.lattice-codex/koala.json); @koala-agent old-global-install handling (flow-stability/worktree-repair/
lattice-only-absence smokes); isKoalaSelfRepoBootstrap (rename if genuine self-repo logic, delete if
pure legacy detection). No old-install migration kept.

## CHK-003 — Clean koala-codex/koala-agent + all stray koala literals
The koala-codex/koala-agent references and every remaining stray koala comment/string in packages/*/src
NOT covered by the other items, except the residue-gate self-IDs (story 4).

## CHK-004 — Build/suite/gate green + zero-koala acceptance
`npx tsc --noEmit` exit 0; packages/main suite green (skip pre-existing fails); `node scripts/verify-koala-residue.mjs`
PASS + self-test; `git grep -i koala -- 'packages/*/src/**'` returns ONLY review-preflight.ts KOALA_RESIDUE_*.

## CHK-005 — Rename koala config fields/filenames to lattice
idleKoala config field, koala.config.json filename references, koalaConfig identifiers → lattice-named;
no koala.config.json read-fallback (no-compat). Update every reader/writer together.

## CHK-006 — Rename .koala/ runtime path references to the lattice runtime dir
.koala/ path literals/comments (e.g. tool-status.ts .koala/activity.jsonl) → the lattice runtime dir.
Grep for every .koala/ READ and WRITE; no .koala/ path remains. Existing .koala/ data not migrated.

## Risk control
Sign all gates via the worktree binary; re-run the residue gate + targeted smokes after each category.
Full suite + a `lattice session_brief` smoke before dev_finish.
