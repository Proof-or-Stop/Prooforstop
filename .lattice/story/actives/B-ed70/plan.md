# Plan — B-ed70: OSS naming cleanup (lab + .Codex + omx)

## Goal
Three coordinated naming cleanups for OSS launch. Items 2+3 trip the always-on 3x2 decision-doc gate;
clear via standing degraded 3x1 fallback (memory: use-degraded-3x1-review-escalation).

## CHK-001 — lab/package.json description
Replace 'koala 离线优化实验室' with 'Lattice 离线优化实验室' on line 4 of packages/lab/package.json.
**Verify:** `grep -i koala packages/lab/package.json` empty; `npm --prefix packages/lab run build` passes.

## CHK-002 — Rename .Codex/ → .lattice-codex/
1. `git mv .Codex .lattice-codex` (moves all 18 internal files).
2. In each of the 41 external referencing files, rewrite `.Codex/` and `'.Codex'` and `".Codex"` to
   the .lattice-codex equivalent. CASE-SENSITIVE rewrites only — lowercase `.codex/` must be preserved
   (Codex CLI mandatory hook contract: .codex/hooks.json + .codex/hooks/lattice-scope-pretool.cjs).
3. **Verify:** `git grep -nE '\.Codex(/|\b)' -- . ':(exclude).lattice' ':(exclude).codex'` empty;
   `ls .codex/hooks.json` succeeds (Codex contract intact); `npm run build` + `npm run test:e2e` exit 0;
   `node bin/lattice.js verify_codex` passes 8/8.

## CHK-003 — Remove OMX disable guard entirely
Remove the entire disable infrastructure across 22 files (incl. 10 decision docs):
- Delete `.omx/` line from .gitignore.
- `git rm scripts/verify-omx-disabled.mjs` AND remove its `"test:omx-disabled"` script entry from root package.json.
- Remove AGENTS.md item #12 (the prohibition wording).
- Remove omx-refusing code in baseline.ts, baseline-suite-report.ts, dev-memory.ts, lattice-baseline.ts,
  runtime-artifact-registry.ts, handlers/capsule.ts, tasks/story-capsule-smoke.ts, and the
  baseline-risk-accepted-local-paths.json fixture entries.
- Update 10 decision docs to reflect "omx is not supported" instead of "supported-but-disabled".
**Verify:** `git grep -iE '\.omx|\bomx\b|OMX_' -- . ':(exclude).lattice' ':(exclude)CHANGELOG.md'` empty;
`grep test:omx-disabled package.json` empty; `npm run build` + `npm run test:e2e` exit 0.

## Out of scope
Lowercase .codex/ (Codex CLI contract), the 308-file koala residual sweep (new session), .lattice/
self-hosting metadata, intent-coverage.ts (live), the .koala runtime path layer.
