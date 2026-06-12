## Trigger Event
On 2026-06-12, user identified a remaining parallel-development correctness risk: multiple loops or stories can edit the same file and accidentally fix A while breaking B. Existing owner lease protects single-story metadata writes and main write lock serializes merges, but parallel_merge_queue did not mechanically inspect actual active worktree file overlaps.

## Key Insights
The correct fix is not a broad global file lock. Lattice already uses worktree isolation, story owner leases, and main write locks. The missing mechanical fact is actual changed-file overlap across active story worktrees, especially when sharedHotspots were not manually declared.

## Solution Tradeoffs
Keep the feature read-only and host-neutral. Use git-derived changed-file overlap as scheduling/merge guidance, not Authority evidence and not a replacement for REVIEW/TEST/DONE. Avoid arbitrary optimization or generalized scheduler rewrites.

## Conversational Texture
The user wants Lattice CLI itself to catch this class of parallel risk, following consistency of logic: do not optimize for optimization, only fix real correctness issues, and keep local Non-authority guidance separate from Authority Server proof.
