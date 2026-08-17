## Trigger Event
On 2026-06-23, after S1 (B-a1b0, the injection-probe powered-run DRIVER) merged to main (merge 35361c35d), the user directed 'run it all, cost is minor'. The driver is verified only with a fake arm; no REAL powered results exist yet. This story (S2) builds the real arm and produces the first genuine powered catch-rate data for the 6 stateless-safe probes.

## Key Insights
The merged driver runInjectionArms({probes,arms,reps,runArm}) takes a PLUGGABLE runArm. recovery-runner's agentRun is a local non-exported closure (INIT-001) and its file is owned by another session, so the real arm is built in a NEW file mirroring the claude invocation: execFileSync('claude', ['-p','--model',m,'--dangerously-skip-permissions','--output-format','json',prompt], {cwd: ws, timeout, maxBuffer}). 'shipped' for the bare arm is always true; classify() then reads the post-run workspace fault state. A no-LLM self-check proves the wiring without spend.

## Solution Tradeoffs
Slice 1 = the BARE arm only at small N, to get the first real numbers + prove the pipeline cheaply, before scaling to all arms (A2-prime/A4-C/A4b-B) and full reps. Build real-arm.mjs as a NEW file; do not import or edit run-recovery/run-ablation/run-a2prime (e8aca935 ownership). Records go to a new jsonl; the paper backfill (tab:recovery pending -> real) is a later step after enough arms/reps are run.

## Conversational Texture
The user repeatedly pushed for full completion ('run it all', 'is it all done yet'); we were honest that only S1 was done and that a paper-grade powered run is a real multi-step experiment. This S2 story is the first real-agent step: real arm + a first small powered batch, scaled up afterward.
