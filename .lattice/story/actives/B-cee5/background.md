## Trigger Event
On 2026-07-09, during B-2861 document review, the user identified token exhaustion across multiple host accounts as the highest priority operational problem. Local evidence showed docs/requirements/decisions contains 112 Markdown files, about 331,141 words and 2,489,160 bytes, while current scope and behavior reviewer prompts can still instruct agents to read the full directory.

## Key Insights
Proofbound already has Memory Runtime Preflight, dev_memory_preflight/search, and active playbook advisory surfaces wired into session, handoff, story-create, transition, done-closure, and done-prepare paths. The waste is not that memory is absent; it is that high-token reviewer prompts still begin from broad scans instead of bounded recall and candidate spec narrowing. Memory must remain non-authoritative and gateEvidence=false.

## Solution Tradeoffs
The fastest safe fix is a stopgap prompt and static-test story: update scope-plan and behavior reviewer prompts to require bounded memory/playbook preflight and candidateSpecSet before any broad scan, keep full decisions scan as an explicit escalation path, and add regression tests against old read-every-file wording. This avoids a larger runtime/gate rewrite while immediately reducing token pressure.

## Conversational Texture
The user is not asking for theoretical cleanup; they are trying to keep real accounts from being exhausted by repeated broad reviewer scans. The story should therefore prioritize fast token-spend reduction while preserving Proof-or-Stop's evidence discipline and avoiding any claim that memory or playbook output can satisfy gates.
