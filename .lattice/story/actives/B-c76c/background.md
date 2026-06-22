## Trigger Event
On 2026-06-22, B-bcd4 planning found proofbound package metadata at 0.3.60 while retired Orchestrate and global lattice reported 0.3.63, so canonical work would continue from an older CLI baseline if left unresolved.

## Key Insights
This is not an optimization problem. The real correctness issue is that the active canonical checkout must not trail the retired source checkout before new guard behavior is implemented and validated.

## Solution Tradeoffs
Import only tracked code/config/docs needed to match the old main baseline, regenerate package-lock locally, and avoid copying Orchestrate retired-root warnings, untracked experiments, or legacy evidence into GitHub-facing proofbound history.

## Conversational Texture
The user noticed the version mismatch immediately, which means the acceptance moment should be concrete: proofbound itself must report the same CLI baseline before the retired-root guard story continues.
