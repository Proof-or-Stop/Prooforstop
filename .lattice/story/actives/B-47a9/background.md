## Trigger Event
2026-06-15: A re-validation report on Lattice 0.3.5 confirmed Bug 1/1a still reproduce. Empirically re-confirmed in ClawCreek: lattice validate --concept prints warning: Not a git repository / [concept] warn: git diff failed (main...HEAD), and the finding cluster-sync skips with not a git repository. Root cause is the same class as B-4e06 (which fixed worktree bootstrap to honor a configured gitRoot) but these read-side commands were never routed through the resolved gitRoot.

## Key Insights
An id-independent resolver already exists and is proven: resolveProjectGitRoot(metadataRoot, configuredGitRoot) in packages/main/src/core/story-signed-workspace-resolution.ts (added/used by B-198c doctor + advisory). The fix is to route the main-branch-relative git read ops through it instead of cwd/root. Confirmed call sites: core/cluster-sync.ts (git log main..HEAD), the concept CLI gate (git diff main...HEAD), and story_discard. session.ts git log and test-story.ts git diff are the same pattern but lower priority.

## Solution Tradeoffs
Option A (chosen-leaning): route the reported commands (concept gate, cluster-sync, story_discard) through resolveProjectGitRoot with a fallback to metadataRoot for plain repos, plus a tiny shared git-cwd helper. Minimal, targeted, mirrors B-4e06, keeps plain-repo behavior byte-identical. Option B: a sweeping all-git-invocations-use-resolved-gitRoot refactor — broader blast radius, higher regression risk, scope creep. Reject B per the do-not-over-engineer steer.

## Conversational Texture
The user asked to do two things: (1) commit ClawCreek story metadata to close the Bug 3 metadata-loss risk (done, commit a8050da), and (2) open this framework story to fix Bug 1/1a. This is the framework half. Scope must stay on the reported failures, not a repo-wide git rewrite.
