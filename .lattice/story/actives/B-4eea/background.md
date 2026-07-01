## Trigger Event

2026-07-01 repro-first intake is creating a story from accepted candidate evidence. Probe rp-mr1jjulp-nb58yf and review rr-mr1jk20o-bqqxy9 are bound before development starts.

## Key Insights

The repro review is red-reviewed and classified as target-bug, so this story starts from observed failing behavior instead of a speculative fix. Candidate playbook-runtime-m5-m12-red-20260701 remains intake evidence only.

## Solution Tradeoffs

Using story_create_from_repro keeps the normal story lifecycle intact while adding a pre-story binding artifact. It avoids pretending candidate evidence is verificationEvidence, DONE evidence, Authority proof, or production proof.

## Conversational Texture

The maintainer sees a normal Lattice story with a durable intake binding, then still expects DEV, REVIEW, TEST, validation, and DONE evidence to prove the actual fix after implementation.
