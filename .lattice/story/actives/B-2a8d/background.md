## Trigger Event
On 2026-06-17, after the Experience Layer build reached completion (Phase 3, story B-7561, DONE on local main), the user decided that cross-project aggregation — documented as "L4 Cross-project aggregation (future)" and "Phase 4" in docs/requirements/decisions/lattice-experience-layer-execution-plan.md — must NOT be built. Lattice is a per-project developer tool; each project should learn only from its own history. Cross-project learning would pollute single-project review (a pattern that is a real bug in project A may be intentional in project B) and would weaken the auditable local lineage that is the layer's core property.

## Key Insight
This is a documentation-only edit to the committed execution plan: remove the "L4 Cross-project aggregation (future)" Architecture bullet and the "Phase 4 — cross-project" Roadmap bullet, and reword the remaining cross-project references (principle 5 "Local first, cross-project later"; the problem-statement "cross-project footprint" mention; the "no cross-project aggregation in v1" not-to-do line) to state per-project-only by design. The load-bearing Phase 1 concept — the "deterministic local signature" aggregation key (a different, lowercase concept from the two-layer localSignature/publicSignature cross-project framing) — must remain intact.

## Tradeoff
We edit the plan now so a future implementer does not build cross-project aggregation as a default behaviour. The risk is accidentally deleting the Phase 1 "local signature" aggregation concept while removing the two-layer cross-project framing; we mitigate by removing only the L4/Phase-4 cross-project text and keeping the L1 "local signature" sentence. No source code changes; the built Phases 1a-3 are already per-project and are unaffected.

## Conversation Texture
The user explicitly chose "彻底删掉 Phase 4" (entirely remove Phase 4) and reasoned that per-project-only is the correct default and cross-project would "混" (mix/pollute) single-project judgement. This follows B-7561 (Phase 3) and the standing requirement that all Orchestrate changes go through the Lattice story workflow. No Co-Authored-By trailer.
