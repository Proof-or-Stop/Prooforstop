## Trigger Event
On 2026-07-12, B-f97c removed the 2.5 MB requirements-corpus injection from story_review. The user then asked for an execution Markdown document describing the next optimization: hosts propose relevant keywords, local search finds documents, and reviewers read only ranked candidates.

## Key Insights
Model-proposed keywords improve semantic recall but cannot be the only source. A deterministic CLI seed set, complete filename enumeration, bounded local rg, multi-host proposal union, ranking reasons, read manifests, and explicit escalation are needed to preserve review quality and auditability.

## Solution Tradeoffs
Write a narrow canonical M6 sub-plan rather than expanding the existing 1500-line consolidation plan. The document will define contracts, schemas, milestones, tests, rollout metrics, ownership, failure modes, and quality floors while clearly labeling future delivery state.

## Conversational Texture
The user is satisfied that the urgent corpus burn-through is fixed and now wants the safer follow-up documented for execution. The plan must be concrete enough that later Stories can implement it without guessing and must never imply that keyword routing is already shipped.
