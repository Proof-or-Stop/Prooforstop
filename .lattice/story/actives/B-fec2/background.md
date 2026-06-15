## Trigger Event
On 2026-06-15 while verifying B-198c CHK-003 we need a successful story_create to exercise the create-surface advisory path and confirm it stays silent.

## Key Insights
The storyDir-outside-gitRoot advisory is warn-only and must stay silent when storyDir resolves inside the resolved gitRoot, as it does in this normal repo root.

## Solution Tradeoffs
Option A warn-early without blocking was chosen over hard-failing; the late INIT_CHECK guards remain the hard backstop for the worktree and DONE lifecycle.

## Conversational Texture
This is a throwaway probe story that will be discarded immediately after confirming no advisory line is emitted on stdout or stderr in the normal repo.
