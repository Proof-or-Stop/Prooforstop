## Trigger Event
On 2026-07-03, after B-7ee1 reached DONE, playbook_promotion_status still showed PLAYBOOK_DONE_SETTLEMENT_ENABLED off and candidatePlaybooks=0 while the live store had more than 1400 proposable seeds. The user explicitly rejected another default-off learning feature and asked to fix the DONE learning path before considering historical backfill.

## Key Insights
The old guard protected correctness by preventing DONE success from being counted as helped evidence, but B-7ee1 already added the negative controls that keep DONE settlement out of promotion denominators. The remaining correctness issue is that new DONE stories do not leave any learning settlement trail unless an operator remembers an environment variable.

## Solution Tradeoffs
Prefer a narrow default-on settlement health path over batch historical import. The fix should record non-authoritative, gateEvidence=false DONE settlement rows by default, keep an explicit opt-out for local experiments, preserve idempotency, and prove the current story itself writes settlement data when it reaches DONE. Do not batch-convert historical seeds in this story.

## Conversational Texture
The user is frustrated because multiple playbook features looked implemented but produced no live learning data. The answer needs to be a concrete product behavior change: future DONE stories automatically enter the learning settlement layer, and we inspect live data before deciding whether to backfill historical records.
