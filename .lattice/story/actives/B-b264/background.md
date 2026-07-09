## Trigger Event
On 2026-07-09 after B-90d6 closeout, DONE preparation and merge recovery exposed another UX gap: generated metadata, reruns, dirty files, and untracked-overwrite hazards were difficult to distinguish in the terminal flow.

## Key Insights
Repeated done_prepare runs can be valid, but the CLI should explain what changed since the last attempt. It must also separate generated metadata from unrelated user changes so agents do not commit the wrong files.

## Solution Tradeoffs
Add preflight and rerun explanations at the closeout boundary without auto-resolving merge conflicts, stashing user work, or changing DONE pass criteria. dryRun must remain strictly read-only even when it prints planned actions.

## Conversational Texture
The user wants the agent to stop asking why there is no output or why the same step ran twice. The closeout path should show safe next steps with enough context to avoid damaging local work.
