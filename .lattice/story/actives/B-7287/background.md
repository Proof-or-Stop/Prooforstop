## Trigger Event
2026-06-29 user approved development after docs commit ebaf683d2 and explicitly limited the first implementation batch to M0-M2: freeze intent, classify hardening, and report dry-run DEV proof gaps.

## Key Insights
The raw request is not executable. Story creation is only a container; DEV should be admitted by a ProofStory gate. The MVP must stay light: every story gets Intent MVP, milestone ledger and collision are triggered, and dry-run diagnostics come before enforcement.

## Solution Tradeoffs
This story intentionally implements storage commands and dry-run checks before any hard blocking behavior. Red evidence, spike promotion, DONE enforcement, and REVIEW completeness lanes stay out of scope so the first slice can be measured in observe/warn mode.

## Conversational Texture
The user wants a practical implementation now, not more conceptual expansion. They also asked for a milestone table with checkmarks, so the work should stay mapped to M0-M2 and make completed pieces visible.
