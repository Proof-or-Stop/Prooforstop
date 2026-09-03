## Trigger Event
On 2026-09-02, Codex cross-host review run B-a745-xhr-r2 on story B-a745 filed 'Dirty worktree changes are omitted from relevance inputs' against packages/main/src/core/validation-relevance-input.ts, and the story owner confirmed by grep that neither the collector, the planner nor the handler references materialDirtyFiles, while the reason table already declares workspace_snapshot_changed with a gloss that is never emitted.

## Key Insights
The spec deliberately splits overlay projection into Rollout Story 2 because Story 1 must never prune and therefore cannot be made unsafe by ignoring dirty files; but an explain-only planner that says nothing about an uncommitted edit is misleading to the DEV-time operator the fast tier is meant for. The snapshot reader already knows the dirty set, so the collector can consume it without a new git call, and the selection digest must bind it or two plans over different worktree states will hash identically.

## Solution Tradeoffs
Add dirty files as explicit overlay seeds with provenance worktree-overlay, bind them into the selection digest, and escalate the git-status-unavailable sentinel through workspace_snapshot_changed rather than reading it as clean; versus the cheaper option of only printing a dirty-state warning without binding, which leaves the digest collision. The first is what the spec's DEV worktree overlay section requires, including the double-read race check, so it should be built there rather than as a warning-only stopgap.

## Conversational Texture
The user on B-a745 chose a real cross-host quorum so independent readers would attack the story; this finding came from that choice and was deferred with an in-repository draft rather than a session note, per the user's rule that deferred defects must leave a traceable, owned record.
