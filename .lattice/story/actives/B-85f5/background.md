## Trigger Event
On 2026-08-19, B-38b7 reached a signed PASS for acceptance topology and pre-review executable proof, but the production acceptance_rollout_report command failed before writing its artifact with agent_dispatch_actor_unknown. Source inspection traced the regression to commit c09259d868.

## Key Insights
The security rule is correct: a canonical PROOF_OR_STOP_AGENT identity must outrank deprecated aliases and an unknown environment actor must fail closed before a payload can launder reviewer mutation permission. The defect is at the child-process boundary: the parent writes the canonical actor while nested cohort reviewer commands overwrite only the deprecated alias.

## Solution Tradeoffs
The safe fix is to propagate each nested reviewer lane through the canonical child environment, or use the shared brand-env writer that updates both spellings. Registering acceptance-rollout-verifier as a reviewer or relaxing environment precedence would weaken the dispatch identity and mutation-permission model. The regression must exercise the real production writer rather than only the cohort core.

## Conversational Texture
The user challenged the initial diagnosis and asked why other stories did not fail. The answer required a pure-function reproduction, source-line provenance, and commit-history analysis: ordinary stories do not invoke the observe-mode rollout writer, and the existing direct cohort smoke lacks the production parent canonical actor. The user explicitly approved a separate runtime-fix Story.
