## Trigger Event
On 2026-08-24, B-dc83 REVIEW-to-DEV preflight repeatedly exceeded twenty minutes while validating a large prompt-envelopes.json ledger across current-round reviewer runs.

## Key Insights
The slow path is deterministic: collectReviewerEvidenceState validates many signed runs, and each verifier call reparses the same immutable ledger. The correctness checks are valuable, but the repeated file reads are not.

## Solution Tradeoffs
Cache only the snapshot within one read-only evidence collection and thread it through the verifier and incremental baseline lookup. Preserve the existing default direct-read behavior for independent callers and keep every integrity check active.

## Conversational Texture
The operator needs the lifecycle command to complete predictably while retaining fail-closed evidence semantics. The result should be observable as faster readiness, not as a relaxed gate or a hidden bypass.
