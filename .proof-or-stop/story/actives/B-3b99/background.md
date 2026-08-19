## Trigger Event
2026-07-01 convergence_check reports 9 high-priority uncovered_requirement gaps after all unfinished business stories were closed; this blocks the user-requested full convergence pass.

## Key Insights
The current gap scanner matches requirement keywords against @task annotation text, not semantic TypeScript AST facts. Several gaps point at already implemented behaviors whose exact requirement tokens are not visible in annotation fields.

## Solution Tradeoffs
A narrow mapping fix is safer than changing behavior: add explicit implementation coverage facts and smoke assertions for Autopilot, ProofStory, and local assurance wording. Do not reintroduce retired Authority Server semantics.

## Conversational Texture
The user wants one-by-one closure until DONE, with no fake completion. This story is scoped to make the current high-gap dashboard truthful and machine-verifiable before moving to remaining convergence checks.
