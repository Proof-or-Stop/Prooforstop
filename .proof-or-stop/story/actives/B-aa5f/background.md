## Trigger Event

2026-09-03 repro-first intake is creating a story from accepted candidate evidence. Probe rp-mtlq4b1z-hem77a and review rr-mtlq63zn-umve6e are bound before development starts.

## Key Insights

The repro review is red-reviewed and classified as target-bug, so this story starts from observed failing behavior instead of a speculative fix. Candidate verification-execution-fanout-input-freshness-20260903 remains intake evidence only.

## Solution Tradeoffs

Using story_create_from_repro keeps the normal story lifecycle intact while adding a pre-story binding artifact. It avoids pretending candidate evidence is verificationEvidence, DONE evidence, Authority proof, or production proof.

## Conversational Texture

The maintainer sees a normal ProofOrStop story with a durable intake binding, then still expects DEV, REVIEW, TEST, validation, and DONE evidence to prove the actual fix after implementation.
