## Trigger Event
On 2026-06-23, after S1 (B-a1b0 driver) and S2 (B-0c07 real arm + first powered catchRate 0.667) merged, we hit an architectural wall: ~5 of the remaining 9 B1-B15 scenarios (B4 context-loss, B5 host-interruption, B7 prompt-injection, B8 requirement-conflict, B10 no-progress) are STATEFUL/live-loop and cannot be expressed as the stateless 'apply-to-all-arms' workspace injections the 6 done probes use. The user decided to build a NEW live-loop harness for all 9; this story is its first step (skeleton + 2 scenarios).

## Key Insights
The stateless probe-contract injects a fault into a workspace then runs a single-shot arm. The stateful scenarios need a MULTI-TURN loop with interruption points: truncate context mid-task (B4), kill+restart (B5), inject into the next prompt (B7), feed an unsolvable task and detect no-progress (B10). So the harness models runLiveLoop({scenario, agent, maxTurns}) with per-turn interrupt hooks and a pluggable agent. OUTCOME (RECOVERED/SAFE_STOP/AMPLIFIED) is reused from probe-contract read-only.

## Solution Tradeoffs
Step 1 ships the loop skeleton + the 2 most tractable scenarios (B7, B10) verified hermetically with deterministic fake agents (0 spend), proving the interruptible-loop architecture before scaling to all 9 or spending on real claude -p multi-turn runs. New file (live-loop-harness.mjs); do NOT import or edit probe-contract.mjs / run-recovery / run-ablation / run-a2prime (e8aca935 ownership). The real powered run and the other 7 scenarios are explicit follow-ups.

## Conversational Texture
After S1+S2 produced the first real catch-rate (0.667) for the 6 stateless probes, the user chose 'build a new live-loop harness for all 9' over the easy-subset or future-work options, and then asked to complete the entire first step of that S4' build through the full lifecycle to DONE.
