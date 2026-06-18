## Trigger Event
On 2026-06-17, Phase 2 (B-8387 playbook lifecycle) reached DONE on main, leaving Phase 3 — Story Recall — as the final slice of the Experience Layer build (docs/requirements/decisions/lattice-experience-layer-execution-plan.md, Level 2 / section 8). The execution plan explicitly CUT full-text search for v1: there is no FTS/BM25/SQLite engine in the repo (verified), so recall must be structured-field filtering over the existing story_list filesystem scan, with no derived story-index.

## Key Insight
A new core/story-recall.ts builds a lightweight in-memory profile per story from already-stored metadata (index.json title/type/phase/priority/riskSignals, understanding touchpoints, decision, findings signatures/outcomes) and scores similarity by structured-field overlap (keyword/fileKind/touchpoint set overlap, same type/phase), returning the top-N most similar prior stories with match reasons and their notable findings/decisions/outcome. It reuses the StoryStore enumeration (story_list scan) as the source — NO FTS, NO derived index, NO embedding. A new handlers/recall.ts exposes `recall --story <id>` and `recall --query "..."` (top-N). Recall is READ-ONLY: it writes nothing and never touches a gate. The recall module keeps zero outward coupling except the story read port.

## Tradeoff
We implement structured-field recall over the existing story_list scan rather than building a search index, accepting linear scans (fine at current story counts) to avoid an FTS engine / derived index the plan defers. Cost: ranking is heuristic structured overlap, not semantic similarity; a derived index/embedding is a future optimization only when scan size justifies it. We accept simple, explainable, dependency-free recall now.

## Conversation Texture
The user asked to implement the whole execution plan phase by phase via the Lattice workflow until the document is fully realized. This is the FINAL build slice (Phase 3), following Phase 2 (B-8387). Phase 4 (cross-project aggregation) is marked future in the plan and out of scope. All work goes through the Lattice story lifecycle; no Co-Authored-By trailer.
