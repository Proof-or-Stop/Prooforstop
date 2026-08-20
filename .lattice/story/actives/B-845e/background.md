## Trigger Event
On 2026-08-18 an operator ran `node packages/main/dist/cli.js story_advance --storyId=B-49ed --phase=TEST` and saw a very long wait. The specific story id is not important; any story_advance with --phase=TEST shows the same delay.

## Key Insight
story_advance to TEST is not a cheap phase flip. The orchestrator first runs REVIEW-to-TEST preflight (channel, concept, lint, docs-drift, english-artifacts, lattice-residue, optional adapter checks) and then runs proof-or-stop validate unless a fresh validation PASS already exists.

## Tradeoff
Walking a brand-new story through INIT, PLAN, DEV, and REVIEW just to time TEST would spend more time on process than on measurement. A tiny probe that calls the same production functions, plus standalone timed validate flags, is enough to name the bottleneck.

## Conversation Texture
The operator asked for a new story and a very simple case, not a rewrite. First measure the real wall-clock of each step, then explain the cause in plain language.
