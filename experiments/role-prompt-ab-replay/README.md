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

The authority for each replay sample is the inline `material.content` committed
inside `corpus.json`, bound by `materialDigest` and the corpus/experiment
digests. `material.sourceHintPath` is provenance context for a human; it is not
read, executed, or treated as proof that the hinted file's current or historical
bytes equal the inline snapshot. The validator requires
`snapshotAuthority=corpus-json-content-addressed.v1` and
`snapshotId=<sample id>` so an arbitrary path or label cannot silently become
the reconstruction authority.

The harness may report exact UTF-8 bytes, logical lines, the canonical offline
token estimate, content digests, and comparisons against the independently
adjudicated critical/high findings frozen in `corpus.json`. The current corpus
has no committed dispatch/provider receipt plus evidence digest, so every known
dispatch, provider-processed, output, and cache dimension is
`unavailable(reason)`, never zero. Both corpus and ledger validators reject an
available numeric historical metric—including zero—until a future schema binds
it mechanically to a committed evidence artifact and verified digest.

The harness must not be used to claim production prompt savings, provider cost
savings, model-quality parity, gate readiness, or Story completion. A missing,
tampered, version-skewed, asymmetric, under-floor, or invalid-denominator input
is `INCONCLUSIVE` and produces no savings or recall claim. Story 4 owns
incremental eligibility; Stories 5–6 own role migration; Story 7 owns budget
rollout.

All ledger rows carry `namespace=experiment-only` and `gateEvidence=false`.
Their schema intentionally excludes Story IDs, phases, review IDs, authority
claims, raw prompts/completions/transcripts/tool arguments, and credentials.
