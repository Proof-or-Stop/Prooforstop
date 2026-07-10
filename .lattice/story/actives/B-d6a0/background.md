## Trigger Event
On 2026-07-10, following the B-b264 merge (2895bbb5e, v0.3.181), the B-b264 quality reviewer (run B-b264:RR-008) flagged that the whole-output-trim porcelain bug class fixed inside that story likely exists at other `git status --porcelain` call sites outside B-b264's scope, naming dashboard.ts, cli-engine.ts and dirty-worktree-gate.ts as candidates and asking for a dedicated audit story.

## Key Insights
The bug class: `execSync(...).trim()` on FULL porcelain output strips the first row's leading space, so a first modified-tracked row ' M path' becomes 'M path' and `line.slice(3)` yields a path missing its first character ('.lattice/x' -> 'lattice/x'); every downstream prefix-based classification (isMaterialExcludedPath, .lattice/ material filters, isVolatileRuntimeArtifactPath) then misfires. Untracked '??' rows never start with a space, so untracked-only fixtures cannot catch it. The audit must therefore judge each site by BOTH its read pattern (full-trim vs per-line trimEnd vs untrimmed) AND its usage (path classification vs count/emptiness-only), and regression tests must stage a tracked-modified first row.

## Solution Tradeoffs
Fix per-site with the raw-read pattern B-b264 already established (execFileSync without full trim, split then per-line trimEnd, parse via the existing row parsers) instead of introducing a new shared git-status module: a shared-module refactor would touch ~15 safe call sites and multiply review risk, while the per-site fix keeps the diff bounded to the four affected consumers plus two display-only sites and matches the pattern reviewers already accepted. The audit verdict for every untouched site is recorded so the no-change decision is auditable.

## Conversational Texture
The user asked to open a story that audits every remaining porcelain call site for the same whole-output-trim pattern, fix any that are affected, and add first-row modified-tracked-file regression assertions, explicitly referencing the gitStatusRows/gitRaw fix pattern and assertModifiedTrackedPathExactness as the assertion model. The deliverable they care about is that no remaining consumer silently misclassifies the first dirty row.
