## Trigger Event
On 2026-07-18, Story B-7ffc promoted the accepted role-prompt modularization plan and the user directed execution of every ordered milestone through DONE. Story 1 is the first implementation slice and must establish trustworthy contracts and measurements before any Prompt text is migrated.

## Key Insights
The current repository already has 16 registry-backed prompt outputs and a strong byte/hash baseline, but role lifecycle status is split across dispatch behavior and an audit-only verifier matrix. The new structures must reuse current truth, make status explicit, and report observability boundaries without pretending provider-hidden input is known.

## Solution Tradeoffs
Prefer additive typed registries, deterministic canonical serialization, and a read-only measurement command over rewriting Prompt templates or changing agent_prompt output. This keeps the existing behavior frozen and gives later Stories a stable contract surface, at the cost of carrying both legacy prompt bodies and new sidecar metadata during migration.

## Conversational Texture
The user expects the plan to be executed, but explicitly challenged unnecessary optimization and assumed Prompt edits should be quick. This Story therefore needs visible, reproducible evidence that it adds only the minimum baseline machinery required by the accepted plan and does not smuggle in later envelope, dispatch, or gate behavior.
