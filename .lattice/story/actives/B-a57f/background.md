## Trigger Event
On 2026-06-14, after three review rounds standardized docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md (latest commit fa6803a95; story B-5773 DONE), the user approved the manifest and asked to execute the plan via the Lattice CLI flow: actually translate packages/main/src/cli-engine.ts to English and add the open-source guardrails described in the plan's Phases 0-4.

## Key Insights
The plan's Phase 0 is mandatory FIRST: implementation must not start until every Chinese-bearing line maps to an approved manifest row, and the manifest is a point-in-time snapshot (762 rows) that has drifted from the current source (767 Chinese lines; B-4e06 added 5 and shifted line numbers). So Phase 0 must regenerate the manifest from the current branch via a new extract script before any source edit. cli-engine.ts is 4031 lines. The 3 behavior-sensitive rows (M668/M669/M750) match Chinese at runtime via regex/.includes and need coordinated code+test changes, so they are deferred to a separate follow-up story.

## Solution Tradeoffs
The user chose to do all five phases in a single story rather than phase-by-phase, accepting a larger diff. Behavior-sensitive rows are carved out to keep this story free of runtime-matching changes. Phase 1 (public surface) must update tests asserting old Chinese output; Phase 3 adds a gate so new Chinese cannot regress the work; Phase 4 keeps active docs English and pushes historical Chinese to archive locations rather than mixing it in.

## Conversational Texture
The user reviewed the manifest across three rounds (19 wording fixes, 20 structural items as B-5773, then a 7-category consistency cleanup), then said "按照这份文档执行吧，使用Lattice CLI流程". They explicitly chose everything-in-one-story and a separate follow-up story for the behavior-sensitive rows.
