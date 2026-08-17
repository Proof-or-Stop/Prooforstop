## Trigger Event
On 2026-06-23, preparing the powered run of the pre-registered five-arm reflection-loop ablation (paper section sec:loopB), two gaps block it: the experiment harness experiments/recovery-runner/ implements arms a2prime/a4/a4b but NOT the A2-prime (compute-matched naive) arm the paper calls its methodological centerpiece, and the per-run records cannot accurately count agent calls.

## Key Insights
In run-recovery.mjs the executor (agentRun) is called once per loop iteration and the reviewer (reviewArtifact) once per acceptance-pass (a4/a4b). The recorded reviewRounds only counts reviewer BLOCK rounds, so it UNDERCOUNTS reviewer calls (it misses the final SHIP review and the a4 gate review). The paper defines A2-prime as a2prime with the retry budget set to the median A4 (a4b) agent-call count, so an accurate agentCalls measure is a prerequisite. A2-prime is a BUDGET match (R = median A4 agentCalls), not a per-run spend match: a2prime still stops at the first acceptance pass, so on a passes-the-visible-test fault it amplifies at one call regardless of R; the equal-budget framing is what refutes the it-just-spent-more-compute objection to A4.

## Solution Tradeoffs
Count agent calls with an explicit counter incremented inside agentRun() and reviewArtifact() (arm-agnostic, robust) rather than deriving it post-hoc from attempts+reviewRounds (which is wrong). Implement A2-prime in the ablation driver run-ablation.mjs (a2prime with a computed R) rather than as a new engine arm, since it is a2prime under a different budget. Document the budget-match vs spend-match distinction honestly so the paper claim is precise.

## Conversational Texture
The operator asked to first implement A2-prime then expand the task corpus, until the powered ablation is fully run. This story is the A2-prime + agent-call-accounting half; the corpus expansion and the powered run follow as separate work.
