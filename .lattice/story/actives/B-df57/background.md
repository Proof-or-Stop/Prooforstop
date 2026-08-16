## Trigger Event

B-8de3 reached REVIEW with 13 of 13 fresh tool-executed receipts and four signed reviewer lanes. Its frozen ProofStory contract names those rows with positional refs such as CHK-001:happy:0, while the immutable verificationIntent and verificationEvidence records use authored stable IDs such as artifact-object-publication. The REVIEW completeness gate compares raw strings and falsely reports all 13 as missing. The evidence writer correctly refuses fabricating a positional receipt because that token is not the authored ID.

## Key Insights

Both supported spellings must resolve through one canonical checklist-row identity before any coverage comparison. The resolver must be shared by ProofStory REVIEW and DONE completeness, acceptance topology, acceptance coverage-basis, and milestone-status consumers; a partial consumer-only patch would create contradictory truth. Stable IDs can also collide with positional-looking strings, so ambiguous aliases, duplicate authored IDs, wrong checklist ownership, malformed lanes, and out-of-range indices must fail closed rather than guess.

## Solution Tradeoffs

Create one side-effect-free canonical verification-intent reference resolver and route the exact consumer set through it. Keep verification evidence command/selector pins, mechanical/freshness requirements, and PLAN contract freezing unchanged. Explicitly prove that proofstory_contract_set remains refused during REVIEW and leaves contract bytes/hash unchanged. Do not add a mid-flight mutation bypass, automatic evidence rewrite, or permissive fallback for unknown refs. Register the consumer contract in process-fact projection and its verifier.

## Conversational Texture

When a frozen contract and a fresh receipt name the same authored verificationIntent row with different supported spellings, ProofStory completeness reports PASS. When the spelling is unknown, cross-item, malformed, out of range, duplicate, ambiguous, stale, failing, or non-mechanical, it remains uncovered with a precise fail-closed diagnostic.
