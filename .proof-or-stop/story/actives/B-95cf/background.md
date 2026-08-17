## Trigger Event
During B-a7c5 (2026-08-15), running the project's root `npm test` for extra confidence beyond `lattice validate` surfaced three deterministic failures on a clean, untouched main checkout at commit 8dbfac8809: proofstory-acceptance-basis-smoke.ts, field-regression-cli-smoke.ts, and worktree-authority-smoke.ts. All three were confirmed unrelated to B-a7c5's diff and flagged as separate follow-up tasks rather than folded into that story.

## Key Insights
All three share the same shape: a real production change (a new PROCESS_FACT_REGISTRY entry, a newly-required review_pass_set argument, and a new done_recover version-bump wiring) outran a test fixture's synthetic setup, and none of the three fixtures are registered in lattice.config.json's validate.commands, so lattice validate silently never runs them -- only the broader root npm test does. Each failure's root cause was independently confirmed by direct reproduction on the current main tree before this story was opened.

## Solution Tradeoffs
Bundling all three into one story trades focused single-root-cause REVIEW lanes for saving three separate story lifecycle overheads (each full INIT-to-DONE cycle carries meaningful fixed cost, as observed directly in B-a7c5). Per explicit user instruction, each bug gets an independent RED reproduction (repro-first methodology under packages/main/tests/red/) proven to fail before any fix lands, then a GREEN fix, before the story advances past DEV.

## Conversational Texture
User gave an explicit repro-first-then-fix-then-full-lifecycle instruction: write a RED reproduction for each of the three problems first, then a GREEN fix, then bundle all three into one story and drive it to DONE -- consistent with this repo's established Red -> Spike -> Story convention.
