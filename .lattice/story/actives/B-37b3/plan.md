# Plan — Resolve the Experience Layer cache from the main repo root (worktree fix)

The finding-signals cache lives only in the main checkout (`.lattice/learning/` is
gitignored), but story DEV/REVIEW runs in worktrees where it's absent — so hints
never load and `experience_hint_surfaced` ~never fires (Experience Layer dormant,
nOn=2). Resolve the learning-store cache root to the main repo root, with a fallback.

## CHK-001

In `packages/main/src/core/learning-store.ts` (the only toucher of
`.lattice/learning/`), resolve the learning directory to the MAIN repo root for both
READ and WRITE:
- Add a helper (e.g. `resolveLearningRoot(root)`) that runs
  `git rev-parse --git-common-dir` with cwd=root, resolves the (possibly relative)
  result to an absolute path, and returns its PARENT directory (the canonical main
  worktree root). On ANY failure (non-git dir, error, empty output) return the
  passed `root` unchanged.
- Apply `resolveLearningRoot` to BOTH the read path (the cache read used by
  `experience-hint-loader` / `learning_validate` / `learning_effectiveness`) and the
  write path (`learning_scan`), so reads and writes always agree on one canonical
  cache. Never throw — wrap in try/catch and fall back.
- Do NOT change the cache schema, the finding-signals derivation, or any gate. Keep
  the module a leaf (node builtins only).

User sees: `story_review` inside a worktree loads the main checkout cache — the
`_reviewPrompt` advisory hints section is populated and `experience_hint_surfaced`
fires (previously zero in worktree runs); `learning_scan` from a worktree writes the
single main cache; non-git temp dirs fall back to the passed root unchanged.

## CHK-002

Add a smoke `packages/main/src/tasks/experience-hint-worktree-cache-smoke.ts`
(auto-discovered + npm wiring):
- **Worktree resolves main cache:** build a main git repo, write a finding-signals
  cache under `main/.lattice/learning/`, create a linked worktree, and assert the
  learning-store (and `loadExperienceHints` / `hasExperienceHints`) reads the cache
  from the worktree (non-empty).
- **Non-git fallback:** a plain (non-git) temp dir falls back to the passed root
  (no throw; empty when absent), proving existing temp-root smokes stay valid.
- Optionally assert write-then-read parity: `learning_scan`-style write from the
  worktree lands in the main cache and a subsequent worktree read hits it.

User sees: `node packages/main/dist/tasks/experience-hint-worktree-cache-smoke.js`
prints its checks and exits 0; full `npm test` exits 0 with the new smoke in the
chain; existing experience-layer/hint smokes stay green.

## Verification approach

One DEV commit (learning-store resolver + smoke); build tsc-clean; run the new smoke
+ the existing experience-layer/hint smokes; full `npm test` green; ONE review round
(claude 3 lanes + codex host-2); `recover_evidence`; TEST → DONE (DONE merge
auto-bumps version + auto-rebuilds dist — do NOT do those manually). After DONE,
record the durable behavior: REVIEW dispatch should feed the `_reviewPrompt` hints
section to the lane reviewers so the ON arm genuinely influences review.
