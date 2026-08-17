## Trigger Event
B-6e41 completed on 2026-07-02 and delivered the generic ClaimAdmissibilityPack interface plus read-only registry, while the quantum execution plan still marks M2-M5 pending. The next bounded implementation slice is M2 verifier adapters.

## Key Insights
M0-M1 already detect missing, stale, mismatched, and unbound evidence for Q1-Q12. M2 should not invent a new proof manager; it should define adapter descriptors and deterministic receipt normalization that feed the existing evaluator.

## Solution Tradeoffs
Keep this story read-only and local: adapter definitions and normalizers are code/runtime contracts, not command runners or lifecycle gates. Gate policy, benchmark harnesses, and reporting remain separate stories so review scope stays clean.

## Conversational Texture
The user wants the milestone sequence executed to DONE, but also cares about proof-or-stop boundaries. This story should be narrow enough to finish with strong evidence instead of becoming a vague quantum framework rewrite.
