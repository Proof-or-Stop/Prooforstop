# B-7561 Execution Plan — Experience Layer Phase 3 (Story Recall, final slice)

Structured-field similarity recall over the existing story_list scan. Read-only.
No FTS, no derived index, no embedding (the plan's cut-FTS decision).

## CHK-001 Profiles + structured similarity scoring
experience-layer-types.ts: StoryProfile {storyId,title,type,phase,priority,
keywords[],fileKinds[],touchpoints[],riskSignals[],notableFindings[],
notableDecisions[],outcome}. core/story-recall.ts: buildStoryProfile(meta) and
scoreSimilarity(a,b) using structured overlap (Jaccard over keyword/fileKind/
touchpoint sets + type/phase match). Pure & deterministic; imports only
experience-layer-types + node:.
Verification: smoke asserts an overlapping profile scores above a disjoint one;
scoring is symmetric + deterministic; multi-field (no single-field domination).

## CHK-002 recallSimilarStories over the story_list scan
core/story-recall.ts: recallSimilarStories(target, candidates, topN) -> ranked
matches with match reasons. Candidates are profiles built from the StoryStore
enumeration (existing story_list scan). NO derived index. Read-only.
Verification: smoke seeds stories, builds profiles via the store, asserts the
most-similar first, top-N respected, nothing written.

## CHK-003 handlers/recall.ts CLI + registration (read-only)
handlers/recall.ts: `recall --story <id>` (profile + ranked top-N similar with
match reasons + notable findings/decisions/outcome) and `recall --query "..."`
(ad-hoc keyword profile). Reuses the store enumeration; read-only. Register
`recall` (flat underscore) via command-policy(readOnly)/config/registry/cli-engine.
Verification: smoke/CLI returns ranked results for --story and --query; no writes.

## CHK-004 Smoke + npm script + no regression
tasks/experience-layer-recall-smoke.ts + package.json test:experience-layer-recall.
Hermetic. Assert: profile building; ranking + top-N; reuse story_list scan (no
derived-index file created); read-only (no writes); zero outward coupling (recall
module); build clean; existing experience-layer smokes still pass.
Verification: npm script exits 0 'smoke passed'; verifier TOTAL N | PASS N | FAIL 0.

## Out of scope
Any FTS/BM25/embedding/derived-index; writing state or touching a gate during
recall; cross-project aggregation (Phase 4, future).
