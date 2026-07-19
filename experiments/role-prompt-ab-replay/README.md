# Role-prompt A/B replay (Story 3)

This directory is an experiment-only, read-only replay harness. It measures a
frozen six-sample historical observation corpus; it does not dispatch a model,
execute historical code, call `agent_prompt --storyId`, call `host_run`, write a
review pass/finding/ReviewRun, or participate in any lifecycle gate.

## Commands

```bash
node experiments/role-prompt-ab-replay/selfcheck.mjs
node experiments/role-prompt-ab-replay/run.mjs
node experiments/role-prompt-ab-replay/run.mjs --reverse
node experiments/role-prompt-ab-replay/run.mjs \
  --ledger=runtime/operator-run.jsonl --run-id=operator-run-001
node experiments/role-prompt-ab-replay/analyze.mjs \
  --ledger=runtime/operator-run.jsonl
```

The ordinary replay is read-only. Ledger output is opt-in and is confined to
`experiments/role-prompt-ab-replay/runtime/*.jsonl`; that directory is runtime
output and should be deleted after inspection.

## Claim boundary

The harness may report exact UTF-8 bytes, logical lines, the canonical offline
token estimate, content digests, and comparisons against the independently
adjudicated critical/high findings frozen in `corpus.json`. Provider-processed
input and cache dimensions are reported only where the historical observation
actually contains them. Missing dimensions remain `unavailable(reason)`, never
zero.

The harness must not be used to claim production prompt savings, provider cost
savings, model-quality parity, gate readiness, or Story completion. A missing,
tampered, version-skewed, asymmetric, under-floor, or invalid-denominator input
is `INCONCLUSIVE` and produces no savings or recall claim. Story 4 owns
incremental eligibility; Stories 5–6 own role migration; Story 7 owns budget
rollout.

All ledger rows carry `namespace=experiment-only` and `gateEvidence=false`.
Their schema intentionally excludes Story IDs, phases, review IDs, authority
claims, raw prompts/completions/transcripts/tool arguments, and credentials.
