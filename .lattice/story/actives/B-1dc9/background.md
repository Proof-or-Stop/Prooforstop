## Trigger Event
On 2026-06-17, stories B-000c (Phase 1a finding-signals) and B-4f46 (Phase 1b finding outcome enums + signature-registry) reached DONE on main. The Experience Layer now derives meaningful finding signals but nothing surfaces them. Phase 1.5, per docs/requirements/decisions/lattice-experience-layer-execution-plan.md, injects those signals as advisory review-time hints.

## Key Insight
A new core/experience-hint-loader.ts ranks signals by priority = signalScore * log(1 + support) * recencyBoost, filters (recurring issues at signalScore >= 0.65; common-false-positives separately), and formats a top-N "Project experience hints (advisory only)" section with progressive disclosure (summary first). It is surfaced through handlers/story-review.ts as an advisory section mirroring the existing grillSection. The load-bearing guardrail: hints are ADVISORY-ONLY and must never affect the deterministic reviewRunId binding. The REVIEW-phase promptHash is computed by resolveReviewPromptHash (core/review-run.ts) from the reviewer-supplied prompt; experience-hint loading must remain a separate channel that never feeds resolveReviewPromptHash. Surfacing writes an experience_hint_surfaced event to the activity log (reusing appendActivityLog) for auditable usage tracking.

## Tradeoff
We inject hints into the story-review advisory output (the same place grillSection already lives) and expose them as a clearly-labelled advisory section, rather than wiring them into any gate or the reviewRunId prompt domain. Cost: the hints are advisory context that a human/reviewer may ignore. We accept advisory-only surfacing (the whole point of the Experience Layer) and prove with a smoke that the deterministic promptHash mechanism is unaffected by hint content.

## Conversation Texture
The user asked to implement the whole execution plan phase by phase via the Lattice workflow until the document is fully realized. This is the third code slice. It follows B-4f46 (Phase 1b) and precedes the digest-extract refactor and Phase 2 (playbook lifecycle). All work goes through the Lattice story lifecycle; no Co-Authored-By trailer.
