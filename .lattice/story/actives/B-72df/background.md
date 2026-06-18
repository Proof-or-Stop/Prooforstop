## Trigger Event
2026-06-16: While driving B-e791 to DONE, the merge was blocked with main worktree has uncommitted changes to tracked files because a parallel session (B-0414, at INIT) had an uncommitted decisions doc + NAV.md edit directly on the shared main worktree. The block cleared only when B-0414 committed. The DONE gate requires the whole main worktree clean.

## Key Insights
The DONE merge (done-effects.ts / cli-engine.ts) requires git status clean for tracked files before git merge of the story branch into main, to avoid clobbering uncommitted changes. But it over-broadly requires the WHOLE tree clean; correctness only requires that the paths the merge would touch are not dirty. Multiple sessions share one main worktree (Lattice runs local worktrees + a shared main checkout), so one session's legit uncommitted INIT-phase work blocks an unrelated story's DONE. B-e74e (DONE merge fail before marking DONE when main worktree unavailable) is adjacent but about availability, not unrelated-dirty contention. The fail-safe nature must be preserved: never clobber uncommitted work.

## Solution Tradeoffs
Option A: scope the clean precondition to the merge's affected path set — block only when a dirty path OVERLAPS what the merge would change; allow DONE when dirty paths are unrelated. Simple, targeted, preserves clobber-protection. Option B: perform the DONE merge through a mechanism that does not require/dirty the working tree (merge into the main ref via a temp index, then fast-forward the checkout) — more robust but a bigger change. Lean A; B is overkill for the reported contention.

## Conversational Texture
The user asked to open and fully fix this as a story (the defensive half of the concurrent-session frictions surfaced this session). Authorized to drive through the full Lattice flow to DONE without per-step confirmation.
