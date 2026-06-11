## Trigger Event
After B-b5b2 reached DONE on 2026-06-11, unrelated main work was parked in stash@{0}. A later Claude/Codex audit returned REQUEST CHANGES because the first split plan missed untracked stash mechanics, stale NAV reconciliation, planner hash risk, and dev-memory data handling.

## Key Insights
The stash contains multiple independent topics and cannot be treated as one patch. Runtime path cleanup, Layer4 documentation, smoke expectation repairs, planner hash behavior, and local dev-memory data have different correctness risks and verification needs.

## Solution Tradeoffs
The safest route is a written execution decision before restoring anything. This costs one small documentation story, but prevents accidental whole-stash pop, mixed commits, stale NAV counts, or arbitrary planner ID churn. The document should be executable without changing code.

## Conversational Texture
The user wants the plan made concrete but also wants discipline: no optimization for its own sake, no arbitrary cleanup, only real correctness fixes, and consistent logic. The document should preserve that practical constraint rather than turning into a broad migration manifesto.
