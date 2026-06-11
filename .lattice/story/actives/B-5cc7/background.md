## Trigger Event
2026-06-11 B-70f5 cleared the active root documentation blocker, so the approved stash split plan can begin with Bucket A. The pinned stash object c4dcc3aff95fd999712d7f19dcf856f791cf0d05 contains a dev-memory code hunk plus unrelated buckets that must stay isolated.

## Key Insights
Bucket A is about compatibility reading only: Lattice should continue writing to .lattice dev-memory, while optionally reading old .koala dev-memory files as read-only fallback. The stashed .lattice/dev-memory/experience.jsonl data file is runtime data and must not be restored, staged, or committed.

## Solution Tradeoffs
A narrow restore plus focused smoke test is safer than applying the whole stash, because it proves the specific dev-memory behavior without mixing runtime registry cleanup, smoke expectation changes, Layer 4 documentation, or planner hash work. If the hunk cannot be proven by tests, it should block rather than pass by narrative.

## Conversational Texture
The user explicitly asked for two-host, multi-agent execution while preserving Lattice host-neutral discipline and avoiding optimization for its own sake. This story should feel boring and mechanical: restore only the proven Bucket A paths, test them, and leave every other bucket untouched.
