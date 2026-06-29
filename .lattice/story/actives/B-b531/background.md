## Trigger Event

2026-06-29 repro-first intake is creating a story from accepted candidate evidence. Probe rp-mqzkvjqx-nb3bnj and review rr-mqzkzc8e-q4mz2k are bound before development starts.

## Key Insights

The repro review is red-reviewed and classified as target-bug, so this story starts from observed failing behavior instead of a speculative fix. Candidate post-done-closure-snapshot-drift remains intake evidence only.

## Solution Tradeoffs

Using story_create_from_repro keeps the normal story lifecycle intact while adding a pre-story binding artifact. It avoids pretending candidate evidence is verificationEvidence, DONE evidence, Authority proof, or production proof.

## Conversational Texture

The maintainer sees a normal Lattice story with a durable intake binding, then still expects DEV, REVIEW, TEST, validation, and DONE evidence to prove the actual fix after implementation.
