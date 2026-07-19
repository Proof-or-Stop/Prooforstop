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
output. Its committed `.gitignore` excludes generated rows and lock files, so
the documented run/analyze flow leaves `git status --short` clean. Operators may
delete generated rows after inspection.

`docs/requirements/decisions/lattice-experiment-protocol.md` describes an
unrelated five-arm lifecycle ablation. It is design inspiration for
pre-registration discipline only; it is not this experiment's governing
protocol or acceptance source. `protocol.json`, `corpus.json`, and the canonical
role-prompt decision are the Story 3 contract.

## Claim boundary

The authority for each replay sample is the inline `material.content` committed
inside `corpus.json`, bound by `materialDigest` and the corpus/experiment
digests. `material.sourceHintPath` is provenance context for a human; it is not
read, executed, or treated as proof that the hinted file's current or historical
bytes equal the inline snapshot. The validator requires
`snapshotAuthority=corpus-json-content-addressed.v1` and
`snapshotId=<sample id>` so an arbitrary path or label cannot silently become
the reconstruction authority.

The canonical corpus includes a small frozen snapshot of real signed historical
findings from Story B-dd81. The validator recomputes the v1 finding signature
over `storyId`, `findingId`, description, severity, creation time, review round,
`reviewRunId`, and `signatureVersion`, and also binds the complete snapshot into
an explicit digest.
The category, evidence state, and source references are corpus-bound metadata;
the v1 finding signature itself does not cover those fields.

The corpus still does not contain exact content-addressed legacy/modular
dispatch prompt snapshots, reviewer output artifacts, or independent
semantic-match adjudication bytes connecting either A/B arm to those findings.
Its prompt bytes/tokens/digest and replay finding recall therefore remain
`INCONCLUSIVE`; the sample-level rows are future oracle seeds marked
`oracle-only-unverified`, never detected findings.
Selfcheck separately uses explicitly labelled hermetic, inline,
content-addressed fixtures to prove that exact prompt measurement and semantic
finding comparison work when all required evidence exists. Those fixtures are
not historical or production evidence.

The current corpus also has no committed dispatch/provider receipt plus
evidence digest, so every known dispatch, provider-processed, output, and cache dimension is
`unavailable(reason)`, never zero. Both corpus and ledger validators reject an
available numeric historical metric—including zero—until a future schema binds
it mechanically to a committed evidence artifact and verified digest.
The ledger likewise rejects available `assembledPromptTokens` unless the record
schema can bind both a prompt digest and reconstruction evidence; the current
schema deliberately has no such evidence field, so canonical rows keep that
dimension unavailable. Empty or wholly unavailable ledgers summarize provider
input as `null` plus a stable unavailable reason, never as an observed zero.

The harness must not be used to claim production prompt savings, provider cost
savings, model-quality parity, gate readiness, or Story completion. A missing,
tampered, version-skewed, asymmetric, under-floor, or invalid-denominator input
is `INCONCLUSIVE` and produces no savings or recall claim. Story 4 owns
incremental eligibility; Stories 5–6 own role migration; Story 7 owns budget
rollout.

All ledger rows carry `namespace=experiment-only` and `gateEvidence=false`.
Their schema intentionally excludes Story IDs, phases, review IDs, authority
claims, raw prompts/completions/transcripts/tool arguments, and credentials.
Appending is serialized by an experiment-local exclusive lock; the ledger is
opened with `O_NOFOLLOW`, validated and appended through the same file
descriptor, fsynced, and checked against its canonical fd path.

Selfcheck proves the no-production-write boundary in a temporary isolated
evidence root. It seeds real-shaped sentinel pass, finding, ReviewRun,
verification, validation, lifecycle, and process-event artifacts; copies the
experiment modules and entrypoints into that sandbox; runs ordinary replay,
ledger replay, and analysis there; then compares every sentinel artifact byte
and the complete evidence-root tree before and after. This avoids races with
concurrent real Story metadata while detecting any new or modified production
artifact or process event. Separate structural tests reject production paths,
forged gate authority, Story references, and normal process-fact/usage-ledger
consumption of experiment rows.
