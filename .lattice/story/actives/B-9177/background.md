## Trigger Event
2026-06-16: B-7365 fixed a corruption where commitInitCheckMetadataAndMergeMain committed INIT_CHECK metadata to main and merged WITHOUT holding the main-write-lock, so concurrent main churn raced it and left git conflict markers in story metadata (broke the CLI twice this session). That was ONE unlocked main-mutating path; the shared-main-worktree fleet model means any other unlocked path is a latent equivalent.

## Key Insights
core/main-write-lock.ts (B-f60c) provides withMainWriteLock / withReentrantMainWriteLock; releases on throw; doctor has a stuck-lock check. CLAUDE.md states DONE/done_recover/gap_log/audit/story_create/B-META finding writes hold the lock — but this is by-convention. B-7365 proved a real gap existed and was missed for a long time. There is no mechanical guard that flags a new main-mutating path shipped without the lock. Full per-session physical isolation (separate checkout per session) would remove the shared mutable state entirely but is a large architecture change (truth source: session-ownership-and-write-leases.md); it is the deferred maximalist alternative, not this story.

## Solution Tradeoffs
Option A: audit + close any remaining unlocked main-mutating paths and add a regression guard (a mechanical test that fails when a path commits to main outside the lock) — bounded, addresses the corruption-race root, and prevents future B-7365s. Option B: full per-session checkout isolation — removes shared mutable state but is a big architectural change requiring a design decision first. Choose A; record B as deferred.

## Conversational Texture
The user asked to fix the shared-main-worktree root cause as a story. The honest bounded form is lock-coverage hardening + a guard (generalizing the B-7365 fix), since the actual severe risk is concurrent main-mutation corruption, not the worktree sharing per se. Authorized to drive the full Lattice flow to DONE without per-step confirmation.
