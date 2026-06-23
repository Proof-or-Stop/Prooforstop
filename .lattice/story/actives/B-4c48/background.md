## Trigger Event
B-4bd7 baseline item 4 recorded that stories were losing 5-8 minutes when main merge conflicts or behind-main state appeared only at DONE closure. The concrete repeated signal was B-d43b needing multiple done_prepare runs after REVIEW/TEST metadata moved.

## Key Insights
The issue is not that DONE merge logic is wrong; DONE must still be the authoritative merge gate. The missing piece is an earlier read-only readiness signal that tells agents main has moved before they spend more review or test time on stale material.

## Solution Tradeoffs
Keep this as lifecycle correctness/readiness, not a broad optimization. Prefer advisory or readiness reporting that points to the existing sync path over a new merge implementation or a hard block that could create churn for harmless metadata-only main commits.

## Conversational Texture
The user wants each baseline problem fixed with Lattice flow, but also wants the four principles preserved. This means fixing the real late-discovery gap while avoiding arbitrary speed hacks or host-specific behavior.
