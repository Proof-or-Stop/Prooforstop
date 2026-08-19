## Trigger Event
On 2026-06-23, baseline story B-4bd7 recorded the B-e9cb provider-host incident where proof metadata spoofing checks were discovered late because reviewer guidance did not explicitly require checking both job metadata and linked run metadata.

## Key Insights
The issue is a workflow correctness gap, not a request for broader optimization. A reviewer can miss spoofed proof fields when guidance checks only one metadata location or treats stale linked run metadata as equivalent to fresh server-authored proof.

## Solution Tradeoffs
Keep the fix narrow by updating Lattice reviewer guidance and smoke coverage. Do not change server business logic, provider execution semantics, receipt verification, deployment, or CLI scheduling in this story.

## Conversational Texture
The user asked for each baseline issue to be fixed as its own story and emphasized four principles: do not optimize for optimization, do not optimize arbitrarily, only fix correctness issues, and follow consistency of logic.
