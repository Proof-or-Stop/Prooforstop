## Trigger Event
On 2026-07-02 after B-9958 reached DONE, the user challenged the manual activation boundary: with hundreds of historical experiences, asking a human to explicitly activate each candidate is not scalable and unfairly shifts responsibility to the operator. The correct next step is evidence-activated promotion, not human blame.

## Key Insights
B-9958 completed the V1 seed/proposal/candidate/outcome/recommendation/runtime verification loop, but it intentionally left automatic activation disabled. That was correct for safety, yet the product now needs a stronger activation model where evidence, not memory or manual courage, decides which advisory playbooks become active.

## Solution Tradeoffs
Do not turn on blanket auto-activation or use story DONE as proof of usefulness. Implement a guarded activation writer that requires recommend_activate, decisive outcome samples, concrete exposure, structured verdict source, clean lineage/dedup audit, policy-reviewed thresholds, digest binding, idempotency, and demotion/rollback capability. Keep learning non-authoritative and never use playbooks as lifecycle gate evidence.

## Conversational Texture
The user is frustrated because a system with many lessons should not ask a human to manually carry activation risk. The response should make Proofbound feel evidence-first: humans approve the rule of evidence, while activation is mechanically justified, reversible, and auditable.
