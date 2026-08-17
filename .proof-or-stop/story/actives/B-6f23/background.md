## Trigger Event

On 2026-08-14, B-d0b8 repeatedly failed DONE-required validation even though all 47 root tests passed when warm. A cold build followed by the canonical root suite produced 46/47: flow-stability-smoke timed out at 120 seconds and the suite ended at 300.97 seconds.

## Key Insights

The bottleneck is runAgentLivenessSuite, which launches seven independent temp-root smoke processes serially. Raising outer full-suite jobs worsened contention and reproduced the same timeout. The narrow repair is bounded concurrency inside this nested suite while preserving child markers, exit propagation, inherited output, and cleanup.

## Tradeoffs

Do not raise the 120-second member ceiling or 300-second total budget. Use a small fixed concurrency bound so the critical path shrinks without creating jobs=8 style CPU oversubscription.

## Conversation Texture

The user asked to resolve the TEST blocker directly without bypassing Proof-or-Stop gates.
