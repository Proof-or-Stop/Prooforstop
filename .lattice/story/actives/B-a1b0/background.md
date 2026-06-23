## Trigger Event
On 2026-06-23, while auditing the paper's data coverage (this session, after B-7b6e merged), we found that experiments/injection-probes/ implements 6 stateless-safe failure-injection probes (B1/B2/B6/B9/B11/B13) with passing self-tests, but there is NO driver that applies them to real recovery-runner arms — only run-all-selftests.mjs exists. The paper's tab:recovery lists these scenarios as 'pending powered run'. The user (jek) decided to build the driver and run the 6 powered.

## Key Insights
The 6 probes already conform to probe-contract.mjs (inject / classify / selfTestCases). A powered driver must, per (probe, arm, rep): create a task workspace, apply probe.inject(), run a real agent arm (reuse the recovery-runner agentRun), capture transcript {actions, shipped}, call probe.classify() -> RECOVERED|SAFE_STOP|AMPLIFIED, and append a run record. The driver must be arm-agnostic and probe-agnostic so the same harness later runs the 9 future probes after the pre-reg amendment.

## Solution Tradeoffs
Build the driver in a NEW file (run-injection-arms.mjs) to avoid colliding with the e8aca935 session that owns run-recovery/run-ablation/run-a2prime (the green-but-wrong ablation line). Verify hermetically with a deterministic FAKE arm so the wiring is proven with zero network/cost; the real powered run (real claude -p, real money) is a separate, cost-checkpointed follow-up step, coordinated with e8aca935 to avoid double-spend. We do NOT modify probe-contract.mjs or the 6 existing probe files.

## Conversational Texture
User asked whether to first finish running the 6 probes powered and then complete the other 9, and chose both 'build the driver and run' and 'expand the pre-registration from 6 to 15, building and running all of them'. We agreed the order: driver first (this story), then the powered run of the 6, then a pre-reg amendment (6->15) BEFORE building/running the 9, since pre-registration must precede the run to stay methodologically honest.
