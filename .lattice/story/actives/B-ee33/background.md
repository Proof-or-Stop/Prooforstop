## Trigger Event
During the 2026-06-11 two-host final audit after B-8f4c DONE, the Claude-host lane found a blocker in docs/requirements/decisions/stash-split-execution-plan.md: the purpose paragraph says each bucket may become a future story or commit.

## Key Insights
The rest of the same document requires one future story per bucket, and Lattice host-neutral correctness depends on story-scoped checklist, review, validation, and evidence gates. A direct commit path contradicts that boundary.

## Solution Tradeoffs
The smallest correct fix is to remove the direct commit option and say each accepted bucket must become a separate future story with its own tests and evidence. No broader rewrite, no extra framework, and no arbitrary wording cleanup is needed.

## Conversational Texture
The user explicitly asked for final multi-host review under four principles: no optimization for its own sake, no arbitrary optimization, only real correctness issues, and consistency of logic. This story only addresses that verified inconsistency.
