# B-5a9a Plan

## CHK-001

Write the decision document first. It must define storyFilesHash, its file set, why it is secondary rather than a replacement for materialHash, how whole-tree drift is downgraded to an explicit re-attestation warning, and which binding surfaces adopt it. The doc should explicitly reject silent rebind and story-diff-only semantics.

## CHK-002

Implement the secondary binding signal in code. Add optional storyFilesHash fields to durable types, compute the hash from story-owned material files versus merge-base main, and thread it alongside materialHash for review runs, verification evidence, and review escalation/fallback records. Preserve legacy records without storyFilesHash by keeping existing strict materialHash behavior.

## CHK-003

Change freshness evaluators so matching storyFilesHash keeps bindings valid when only unrelated whole-tree materialHash changed, while returning a visible warning that re-attestation is recommended/required for full whole-tree confidence. Add focused smoke coverage for unchanged story files, changed story files, and legacy strict materialHash records.
