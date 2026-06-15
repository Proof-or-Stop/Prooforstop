# B-3990 real-machine transcript ↔ PLAN-outcome diff

Run with the worktree's freshly-built CLI (`node .worktrees/B-3990/packages/main/dist/cli.js`), **no `--story`** — the exact path the report's Bug 1 hit.

## Expected (understanding.outcome)
> Bare `lattice validate --concept` (no --story) on a wrapper-root project runs git diff in the resolved gitRoot and prints a concept pass line instead of `warning: Not a git repository` / `git diff failed`. Plain repos byte-identical.

## BEFORE (pre-fix, bare no-story on wrapper-root)
```
running 1 CLI gate(s) in parallel (channel=false concept=true lint=false)
warning: Not a git repository. Use --no-index to compare two paths outside a working tree
[concept] ⚠ warn: git diff failed (main...HEAD): Command failed: git diff main...HEAD
```

## AFTER (B-3990 fixed CLI, wrapper-root fixture `gitRoot=repo`, NO --story, `main...HEAD` drops a symbol)
```
running 1 CLI gate(s) in parallel (channel=false concept=true lint=false)
[concept] ✓ pass: 1 symbol(s) deleted, no residual references
  deletedSymbols: gone
  recommendation: skip concept LLM reviewer
```
`Not a git repository` marker check: **GONE**.

## Diff notes
- **Match.** With no `--story`, the gate's `gitCwd` now resolves via the project-level `evaluateStoryDirConfigInsideGitRoot` (instead of falling back to metadataRoot), so the concept gate runs `git diff` in the real gitRoot, finds the deleted `gone()` symbol, and passes. This is the report's exact Bug 1 standalone symptom, now fixed.
- cwd-only: the `--story` `resolveGitCwd` path (B-2856) and gate semantics/command text are untouched; `story-signed-workspace-resolution.ts` not modified.
- Plain-repo byte-identical: the resolver returns a null gitRoot for plain repos, so `?? projectRoot` preserves old behavior.
- Known follow-up (F-001, dismissed as out-of-scope): the smoke is real + passing but not yet in the validate battery — a pattern-wide infra gap shared with B-198c/B-2856, to be closed by a dedicated wiring story.
