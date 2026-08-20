# Cell03 Parallel Shard Runner Plan

## Intent

Build a small, host-neutral helper for Cell03 row-level sharding so future provider execution can be split across independent local runners without sharing one append ledger. This story only proves deterministic shard planning, shard-local output, lock refusal, and strict merge validation. It does not execute provider calls, does not mutate active B-991d evidence rows, and does not unlock Cell06, Phase2, powered runs, or paper claims.

## CHK-001

Implement `experiments/multi-model-ablation/cell03-shards/plan.mjs`.

The shard plan will derive the expected Cell03 key set from the frozen multi-model ablation task inventory and seed manifest. It will sort keys deterministically and assign each row by stable index modulo shard count. The output will include binding digests for protocol, task inventory, prompt surface, tool surface, execution window, snapshot, and runner identity so later stages can reject drift.

Validation target: an 8-shard fixture covers all 1,152 Cell03 keys exactly once. Invalid shard count or shard index values fail closed.

## CHK-002

Implement `experiments/multi-model-ablation/cell03-shards/shard-runner.mjs`.

The shard runner will write only to a shard-local output directory. A per-shard lock prevents two runners from owning the same shard concurrently. Fixture mode can produce deterministic synthetic rows for selfcheck without calling providers. It must never append to canonical Cell03 result rows during parallel execution.

Validation target: selfcheck proves shard-local output, explicit lock refusal for duplicate same-shard ownership, and no canonical result ledger mutation.

## CHK-003

Implement `experiments/multi-model-ablation/cell03-shards/merge.mjs`.

The merge validator will read completed shard outputs, compare binding metadata, require one final row per expected key, reject duplicate rows, reject missing rows when complete merge is requested, and reject digest or shard manifest drift. Default behavior is validation/reporting only; writing a merged file is explicit and still must not target the live B-991d row ledger.

Validation target: complete fixture shards merge cleanly; duplicate rows, missing shards/rows, and metadata drift fail closed.

## CHK-004

Add docs in `experiments/multi-model-ablation/cell03-shards/README.md` and a short pointer from `experiments/multi-model-ablation/README.md`.

Docs must explain commands for shard planning, fixture shard output, and merge validation. They must distinguish this row-level helper from Proofbound Parallel Wave story scheduling and must state the non-goals: no provider execution, no Cell06 unlock, no Phase2 unlock, no paper wording unlock, and no automatic mutation of active B-991d evidence.

## Verification

Run:

```bash
node experiments/multi-model-ablation/cell03-shards/selfcheck.mjs
```

Expected PASS summary includes deterministic coverage, lock rejection, complete merge success, duplicate rejection, missing rejection, and digest-drift rejection.
