## Trigger Event
On 2026-06-22, the recovery-runner experiment harness at experiments/recovery-runner/ — which produces the paper's reflection-loop / recovery (section 6) evidence — was untracked scratch in Orchestrate (git ls-files and git log are empty for it, while experiments/ otherwise has 65 tracked files). To make the experiment code auditable, consistent with the project's trust-the-gate thesis, it should be brought under version control through the review gate rather than living as ungated scratch.

## Key Insights
The harness is about 1276 lines across 32 code files: the runners (run-recovery.mjs, run-a2prime.mjs, run-ablation.mjs), per-task fixtures under tasks/{eval-expr,median,parse-range,text-stats}/ (prompt.md, task.json, acceptance.mjs, ground-truth.mjs, reference-solution.mjs, and the passes-the-visible-test-but-wrong injection payloads such as subtle-wrong-output.mjs / overfit-output.mjs), and generic file-op injections under injections/ (corrupt-output.mjs, delete-output.mjs). The 14 .jsonl run-record outputs are experiment DATA and stay in the paper repo (Proofbound-AI/paper) as evidence, not in the product repo. A README should explain the harness and point to the paper repo for data and results.

## Solution Tradeoffs
Onboard only the CODE plus a README, excluding the bulky .jsonl run-records. The alternative (tracking the .jsonl too) would dump experiment output into the product repo. The harness is reproducible (the runner regenerates run-records on demand), so excluding old outputs is safe. The harness invokes the host CLI (claude -p) when run end to end, so verification must NOT run the live loop; instead it checks fixture self-consistency.

## Conversational Texture
The operator asked to bring recovery-runner into a real Lattice story so the experiment code is code-reviewed and auditable, alongside a separate quorum_submit fix. This story is the onboarding half; verification proves each task's reference solution is self-consistent with its own acceptance and hidden ground-truth checks.
