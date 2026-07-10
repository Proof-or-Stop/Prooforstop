## Trigger Event
On 2026-07-09, story B-cee5 delivered packages/main/src/tasks/reviewer-scan-budget-guard-smoke.ts but could not wire it into lattice validate because lattice.config.json was outside that story's execution-boundary allowedPaths, leaving the guard unenforced.

## Key Insights
A guard that is never executed provides no protection: validate.commands is the enforcement point that runs each guard smoke on every lattice validate, and every existing guard smoke (for example retired-authority-vocabulary-guard-smoke.js) has one explicit entry there. run-all-smokes.js auto-discovers the guard via directory scan but is itself not part of validate.commands, so discovery alone does not enforce anything.

## Solution Tradeoffs
Add one explicit bare-string entry to validate.commands following the existing pattern, rather than wiring run-all-smokes.js as an aggregate runner; the explicit entry matches the established one-entry-per-guard convention, keeps validate output granular, and avoids changing execution semantics of the other smokes. The cost is a hard dependency on B-cee5 merging to main first, which this story records explicitly.

## Conversational Texture
The user asked for a small follow-up story per the project convention that all changes go through the Lattice workflow, explicitly pointed at the retired-authority-vocabulary-guard-smoke.js line-27 pattern to copy, mentioned the run-all-smokes aggregate alternative only as a fallback if the team prefers it, and asked for lattice validate as the verification step after wiring.
