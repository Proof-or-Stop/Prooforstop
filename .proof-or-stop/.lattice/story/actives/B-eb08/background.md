## Trigger Event
On 2026-07-09 during B-90d6 closeout, done_prepare printed validation progress through all configured commands and then became silent while projecting DONE closure, runtime-change, and clean-tree status.

## Key Insights
The problem is not that the gate failed; it is that the operator cannot distinguish valid closeout work from a hung command after validation completes. Heartbeat output must remain diagnostic and must not weaken fail-closed behavior.

## Solution Tradeoffs
Add bounded progress and heartbeat output to post-validation done_prepare phases while keeping JSON stdout parseable and adding independent hard deadlines for every heartbeating phase. Do not redo the B-783c activity-root logging fix.

## Conversational Texture
The user wants the CLI to keep the agent moving without guessing or waiting in silence. The output should say exactly what closeout phase is running and still stop decisively if the phase is actually stuck.
