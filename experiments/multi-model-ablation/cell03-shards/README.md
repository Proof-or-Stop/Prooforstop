# Cell03 Shard Helpers

This directory contains provider-free helpers for safely splitting Cell03 row execution into deterministic shards before any future provider runner adopts parallel execution.

The helpers do not call providers, do not write formal Phase 1 rows, do not unlock Cell06, do not unlock Phase2, and do not change paper claims. They only prove that row-level sharding can be planned, locked, fixture-written, and merge-validated without corrupting the Cell03 evidence ledger.

## Commands

Plan an 8-shard partition:

```bash
node experiments/multi-model-ablation/cell03-shards/plan.mjs --shards 8 --json
```

Write one fixture shard to a local output directory:

```bash
node experiments/multi-model-ablation/cell03-shards/shard-runner.mjs --shards 8 --shard 0 --outDir /tmp/cell03-shards --json
```

Validate a complete shard fixture set:

```bash
node experiments/multi-model-ablation/cell03-shards/merge.mjs --inputDir /tmp/cell03-shards --json
```

Run the local selfcheck:

```bash
node experiments/multi-model-ablation/cell03-shards/selfcheck.mjs
```

Expected output includes:

```text
cell03-shards selfcheck PASS: coverage=1152 shards=8 lockReject=pass rerunReject=pass mergeComplete=pass duplicateReject=pass missingReject=pass digestDriftReject=pass canonicalUntouched=pass
```

## Boundaries

- Parallel Wave is story-level scheduling. These helpers are row-level Cell03 sharding.
- `shard-runner.mjs` writes shard-local fixture rows only.
- Completed shard output cannot be overwritten by a second shard run.
- `merge.mjs` rejects duplicate final rows, missing rows, shard-count drift, digest drift, and wrong-shard rows.
- `merge.mjs --output` refuses to write to `cell03-rows.jsonl`; formal provider evidence must use a separately approved result writer.
- Cell06 remains blocked until a real Cell03-derived budget or usage lock exists after future execution.
