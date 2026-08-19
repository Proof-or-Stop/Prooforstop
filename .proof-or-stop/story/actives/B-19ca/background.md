## Trigger Event
After B-c163 completed on 2026-07-16, the approved remediation order moves directly to C4: verification-intent and legacy test-intent dispatches can receive implementer prompts, while story-level reviewer hints can describe calls the handler rejects without an itemId.

## Key Insights
The defect is not two isolated strings. Role privilege, prompt class, lifecycle phase, alias compatibility, and identifier cardinality are inferred in different places. Prefix detection fails open to implementer behavior, so the contract must be explicit and shared by every consumer.

## Solution Tradeoffs
A typed registry is a larger change than adding two conditionals, but it removes duplicated authority and makes unknown types fail closed. Legacy aliases remain supported through deliberate entries. Rollback retains aliases while disabling new enforcement; it must not restore prefix-based privilege inference.

## Conversational Texture
The user has already approved the execution document and explicitly instructed the agent to run the sequence without routine confirmation pauses. This story therefore proceeds autonomously through the normal Lattice gates, surfacing only real blockers or scope-changing decisions.
