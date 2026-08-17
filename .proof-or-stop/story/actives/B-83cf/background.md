## Trigger Event
On 2026-07-16, B-914f reached TEST with explicit human approval for the documented degraded three-round single-host assurance path, but autopilot_review_submit accepted verdicts lacking keyId, validationDigest, and promptDigest that the gate then ignored.

## Key Insights
The single-host fallback is described as executable, yet canonical bindings are derived only inside quorum_submit, which requires two hosts. A one-host caller cannot satisfy the gate without duplicating private algorithms or fabricating another host.

## Solution Tradeoffs
Use an explicit derive-bindings mode and a shared fail-closed helper. Preserve legacy warning behavior when the flag is absent, reject stale supplied bindings, and avoid silently changing all autopilot submissions or weakening quorum independence.

## Conversational Texture
The user has already approved running the remediation plan to completion and does not want repeated human pauses. This story removes a mechanical workflow contradiction so the approved fallback can complete unattended with auditable evidence.
