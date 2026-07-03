## Trigger Event
On 2026-07-03, convergence_check reported Code annotations compliant=false with one annotation error in packages/main/src/tasks/claim-admissibility-pack-framework-smoke.ts: @type test is invalid for the task annotation validator.

## Key Insights
The runtime implementation is already present; the blocker is only machine-visible annotation metadata. The allowed annotation enum is feature, bugfix, refactor, chore, so the smoke task should be classified as chore or bugfix rather than test.

## Solution Tradeoffs
Use the smallest metadata-only source change: update the annotation type without touching smoke logic, registry behavior, or claim-admissibility runtime contracts. This keeps risk low and avoids reopening unrelated quantum or memory experiment work.

## Conversational Texture
The user asked to continue to DONE and convergence now has a crisp blocker. The work should be boring, auditable, and quick: fix the invalid label, prove validate-tasks passes, then return to the remaining lifecycle stories.
