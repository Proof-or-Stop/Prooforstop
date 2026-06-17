## Trigger Event
On 2026-06-17, after story B-1b28 (LLM usage ledger default-on rollout) reached DONE on local main, the user reviewed a v1.0 Experience Layer draft. Two parallel code-grounded analyses (a six-surface map of the real Lattice codebase plus an adversarial critique, and a map of the ClawCreek playbook reference implementation) produced a corrected v1.1 draft saved at repo-root lattice-experience-layer-v1.1-zh.md. The user then asked to formally land it into docs/requirements/decisions/ via the full Lattice story workflow with a three-round review audit.

## Key Insight
The decisions/ corpus is uniformly English freeform execution-plan markdown (for example lattice-llm-usage-ledger-execution-plan.md, 830 lines, with a Story header and Problem/Principles sections). The Experience Layer doc must follow that house format and must be code-verified: every existing-system claim (the dev-memory capture layer, the decision-doc-promotion digest pattern, the activity-log appender, the absence of any full-text-search engine, runtime-artifact-registry materialHash exclusion, and the reviewRunId promptHash domain) must match the real code so the doc does not mislead future implementers.

## Tradeoff
We land a freeform English execution-plan document (plan only, no source code, no new commands implemented) rather than the structured decision proposal path, because the existing long execution plans in decisions/ are freeform and this doc is a multi-section roadmap rather than a single durable decision statement. Cost: the doc is advisory roadmap text whose accuracy must be defended by review rather than by the compiler. We accept review-defended accuracy plus a verifier that checks document structure and code-anchor presence.

## Conversation Texture
The user explicitly chose English (recommended, matching house convention and the OSS English program) over Chinese or bilingual, and explicitly requested the full three-round Lattice audit. The Chinese v1.1 draft remains as the working reference. This follows the user standing requirement that all Orchestrate changes go through the Lattice story workflow.
