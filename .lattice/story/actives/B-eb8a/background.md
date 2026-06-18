## Trigger Event
On 2026-06-18, a follow-up policy question came up after B-5155 and the current docs still describe low-risk one-round exceptions mostly as wording-only cases. We need the policy language to say the same thing everywhere so the team does not have to infer whether annotation compliance or pure typo fixes belong in the one-round bucket.

## Key Insights
The current source of truth already distinguishes high-risk lifecycle / gate / Authority work from small documentation cleanups, but the low-risk examples are not named consistently. That leaves room for confusion even when the underlying behavior is correct, which is exactly the kind of inconsistency we should remove.

## Solution Tradeoffs
This story should only clarify policy text and keep the mechanical three-round requirement intact for lifecycle, gate, Authority, and process-fact changes. The change should avoid broadening the low-risk bucket beyond annotation compliance, pure typo, and similarly small wording-only corrections.

## Conversational Texture
The goal is to make the rule easy to read at a glance: small annotation or typo cleanups are one-round work, while anything that touches gates or Authority semantics still gets the heavier treatment. The docs should sound calm, explicit, and consistent rather than clever or expansive.
