## Trigger Event
On 2026-06-12, B-ab43 produced and audited the execution plan for the ClawCreek review_run_start follow-up. The observed bug is that metadataRoot may be /Users/jek/Documents/ClawCreek while the real signed git workspace is a nested repo or linked worktree.

## Key Insights
B-3787 fixed currentReviewRound and diagnostics, but not the root-resolution contract. The real implementation must distinguish metadataRoot, signedWorkspaceRoot, authoritativeCwd, and workspaceBinding without guessing nested repositories.

## Solution Tradeoffs
The implementation should be correctness-first and narrow: add a shared resolver, use it in story_resolve and review_run_start, add signed workspace binding if necessary, and prove fail-closed cases. Do not broaden lifecycle or Authority Server behavior.

## Conversational Texture
The user asked for two host perspectives to execute in parallel while the main agent acts as auditor. The work should follow Lattice CLI lifecycle, keep local host evidence non-authoritative, and only fix real correctness issues.
