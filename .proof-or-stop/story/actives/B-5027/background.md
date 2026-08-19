## Trigger Event
Review of DONE Story B-407c on 2026-07-28 reported two HIGH findings: evaluator role misbinding and a 72-receipt replay that fails in a clean checkout. The user requested Red tests before any production fix.

## Key Insights
The evaluator handler selects browser and CLI agents independently, but envelope assembly appears to use one fixed role. Separately, the report selfcheck copies ignored runtime evidence, so a developer checkout may not contain its claimed inputs.

## Solution Tradeoffs
This Story deliberately adds focused failing tests only. It does not repair production behavior yet, preserving an auditable Red state and separating reproduction evidence from the later implementation choice for immutable fixtures or deterministic generation.

## Conversational Texture
The request is explicitly evidence-first: verify that both reported problems truly exist before treating the review as authoritative or starting Story 7. Output should show precise, understandable failures tied to each HIGH finding.
