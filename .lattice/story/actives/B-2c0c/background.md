## Trigger Event
On 2026-06-13, B-4e06 showed that core decision documents can receive three-round two-host review as process-events, but the lifecycle still treats that discipline as convention rather than a hard DONE gate. The user explicitly approved making that verification mandatory.

## Key Insights
The risk is not missing prose. The risk is accepting future core decision-doc changes after normal tests pass while no independent host quorum reviewed the current material. The gate must consume structured host verdict facts and material digests, not a human-written summary.

## Solution Tradeoffs
Prefer a narrow gate keyed to changed docs/requirements/decisions/*.md and host_verdict process events. Avoid auto-spawning hosts, Authority receipt redesign, or retroactive metadata rewrites; this story should only block DONE and explain how to satisfy it.

## Conversational Texture
The user is tightening Lattice because the framework itself is high-leverage infrastructure. The tone should stay practical: make the rule impossible to forget, give exact repair guidance, and keep the implementation small enough for reviewers to audit.
