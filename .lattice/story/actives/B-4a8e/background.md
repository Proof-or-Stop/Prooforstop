## Trigger Event
2026-06-12 user verified B-3938 in /Users/jek/Documents/ClawCreek: story_resolve and review_run_start succeed after gitRoot=clawcreek, but session_brief still prints only Non-git project, making the Host appear unresolved.

## Key Insights
The resolver correctness path and the operator-facing status path are separate. configured-git-root can make signed workspace resolution valid even when the metadata root remains non-git, so session_brief must render both facts together.

## Solution Tradeoffs
The fix should be presentation and diagnostic correctness, not automatic repair. It should consume existing configured gitRoot / signed workspace resolution facts and keep unresolved wrapper roots fail-closed without scanning deep trees or choosing a child repo.

## Conversational Texture
The user challenged the prior completion claim because the Host did not show the problem as solved. The response should make future status output match what users actually need to see: metadata root non-git, but signed workspace configured OK when gitRoot is valid.
