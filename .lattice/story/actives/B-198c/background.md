## Trigger Event
2026-06-15: A ClawCreek user with a wrapper-root layout (metadata root /Users/jek/Documents/ClawCreek, configured gitRoot=clawcreek) hit "story metadata is not inside the resolved git root" at INIT_CHECK worktree bootstrap; the story reaches PLAN but then stalls. Relates to B-4e06, which honored a configured gitRoot but never enforced that storyDir resolves inside it.

## Key Insights
The git-backed lifecycle must git-commit story metadata (scoped story branch + DONE merge to main), which requires storyDir to resolve inside the resolved gitRoot. The only two places that detect the violation today are late guards at worktree.ts:754 and cli-engine.ts:3367 (grep-confirmed). No early detection exists, so users invest INIT/PLAN effort before discovering the dead end.

## Solution Tradeoffs
Option A hard-fails at story_create: clearest signal but retroactively breaks existing wrapper-root projects that currently limp along (ClawCreek has 19 live stories). Option B warns early plus a doctor check: non-breaking, surfaces the problem before INIT_CHECK without blocking metadata-only use. Leaning B, keeping the late guards as the hard backstop, and reusing the existing relative-path escape logic rather than forking a second resolver.

## Conversational Texture
The user asked to analyze this infrastructure issue and chose to do both halves: fix the ClawCreek config and harden the framework. This story is the framework half. The validation must reuse the exact escape check the two guards already use (realpath both sides; violation when the relative path is empty, absolute, or contains a .. segment) so detection has a single source of truth instead of a third copy that can drift.
