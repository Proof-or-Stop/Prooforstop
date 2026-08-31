## Trigger Event
B-5952 recorded fresh reviewer passes RP-018 through RP-020 in a clean REVIEW round, but REVIEW to TEST rejected all three with review_evidence_invalid on eligibilityDigest, eligibilityReasonCodes, and reviewBasisDigest.

## Key Insights
The committed review-incremental-context smoke passes its temporal-cutoff and production-verifier scenarios, while the real story with prior rounds and resolved findings fails repeatedly. The missing coverage is therefore the real persisted-history composition, not the bounded-inventory implementation.

## Solution Tradeoffs
The fix must preserve fail-closed rejection for real task, scope, role, runtime, material, and cutoff changes. It must not bypass Prompt Envelope verification or special-case B-5952; the smallest acceptable change is a deterministic as-of-run recomputation plus a regression using realistic prior rounds.

## Conversational Texture
The user explicitly asked not to expand B-5952 and questioned the time spent. This bug is isolated as its own main-baseline story so B-5952 remains a narrow 800-to-808 instrumentation repair, and the new work is limited to the gate defect that makes legal reviewer evidence impossible to consume.
