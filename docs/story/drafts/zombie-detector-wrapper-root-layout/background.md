## Trigger Event
On 2026-09-02, while implementing B-41c8 CHK-003 (shared story-workspace resolver), the implementer found that detectZombieStories in handlers/story-query.ts lists worktrees from the metadata root rather than the git root. On a wrapper-root layout the healthy DEV story under test was flagged as a zombie, so session_brief did not render it as active; the CHK-003 smoke therefore does not assert the wrapper-root case for session_brief.

## Key Insights
The zombie detector is a health signal that must agree with the same workspace resolution the rest of the CLI uses; when it enumerates from a different root it produces a false negative about liveness that hides an active story from the operator. B-41c8 delivered a single resolver (core/story-workspace.ts) that already honours gitRoot, so the fix is to consume it rather than to add another enumeration.

## Solution Tradeoffs
Route the zombie scan through resolveStoryWorkspace (one owner, consistent with B-41c8) versus patching detectZombieStories to read the configured gitRoot directly (smaller diff, but a fifth resolution path). The first is preferred; the second is acceptable only if the helper cannot serve a whole-repository scan cheaply.

## Conversational Texture
The user asked that medium defects found mid-story be recorded with evidence and deferred rather than widening scope; this draft is that record, filed during B-41c8 DEV so the observation is not lost.
