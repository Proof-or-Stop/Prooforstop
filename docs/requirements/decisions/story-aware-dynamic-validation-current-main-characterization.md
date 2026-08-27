# Story-aware dynamic validation: current-main characterization

This record is the baseline for the layered validator described in
[`story-aware-dynamic-validation-execution-plan.md`](story-aware-dynamic-validation-execution-plan.md).
It is intentionally evidence-first: a green smoke is not treated as proof of
TEST authority unless the signed manifest, closure certificates, receipts and
revocation ledger all bind to the same HEAD.

## Inventory and policy

The inventory is discovered from canonical `proof-or-stop.config.json`, with
legacy `lattice.config.json` as a fallback, and receives a stable command ID
from command plus arguments. The root configuration now records the DYN-1
policy tuple on every command, and the verifier materializes effective
scheduler fields for legacy rows: 58 `full-only` /
`whole-repository` validation-infrastructure rows and 54
`story-selectable` / `static-and-traced` rows (including the two DYN-5 gate
rows). The compiled 112-command catalog reports
`policySource=explicit` for all 112 entries (the inventory digest is emitted
by `verify-validation-inventory.mjs`). Every command carries the effective
catalog policy tuple:

| Field | Meaning |
| --- | --- |
| `assurance` | `always`, `story-selectable`, or `full-only` |
| `riskTier` | `local`, `shared`, `gate`, or `validation-infra` |
| `closurePolicy` | `static-and-traced`, `whole-repository`, or `never-reuse` |
| `fullBaselineReusePolicy` | `not-applicable`, `exact-current-epoch-only`, or `forbidden` |
| `cpuWeight` | explicit row weight when configured, otherwise the registered policy default |
| `expectedP50Ms` | explicit row estimate when configured, otherwise the bounded timeout-derived scheduler estimate |
| `caseRegistryPath` | in-root DYN-5 registry, when sharding is required |
| `runnerSourcePath` | executable DYN-5 runner bound into source closure |
| `declaredEnvironmentKeys` | command-specific environment reads allowed by closure |

Missing policy is recorded as `policySource=default` and cannot satisfy the
enforcement ownership prerequisite. This makes an unregistered command fail
closed instead of silently entering the reusable set. The two gate rows also
declare `caseRegistryPath`, `runnerSourcePath`, and
`LATTICE_VALIDATION_SHARD_ADAPTER` in both canonical and legacy config files;
the runner path is part of each gate row's source closure.

## Baseline run

The canonical baseline is produced only by a complete, passing validation plan.
Wave 0 is always executed before the authoritative selection manifest is
finalized. The baseline binds source HEAD, inventory/catalog digests, runner and
toolchain digests, build proof, runtime closure traces, and a 24-hour expiry.
The baseline is invalid when any command has an undeclared read, module load,
spawn, environment access, missing trace, or external path.

## Measurement commands

```sh
npx tsc -p packages/main/tsconfig.json --noEmit
bun packages/main/src/tasks/story-aware-validation-smoke.ts
bun packages/main/src/tasks/story-aware-validation-production-smoke.ts
bun packages/main/src/tasks/story-aware-validation-mutation-smoke.ts
node scripts/verify-validation-catalog.mjs
node scripts/verify-story-aware-validation-plan.mjs
node scripts/run-dynamic-validation-replay.mjs

# Optional assurance campaigns (they execute real historical/current plans):
node scripts/run-dynamic-validation-replay.mjs --verify-threshold
node scripts/run-dynamic-validation-replay.mjs --execute
node scripts/run-dynamic-validation-replay.mjs --execute --paired
```

The production smoke uses the same configured-command parser as the verifier,
executes both review-pass and quorum registry-backed shards, validates every
signed receipt, and requires the case runner to emit a case-body success marker.
The mutation smoke covers catalog, closure, receipt, selection, scheduler and
shard fault classes. A root `npm test` result remains a separate full-suite
signal; a failure in an unrelated legacy assertion must not be relabeled as a
dynamic-validation PASS.

`run-dynamic-validation-replay.mjs` defaults to a safe plan-only inventory
characterization. Executable replay creates detached git worktrees for each
historical base/head pair, runs the full and selected plans there, writes
per-Story records, and always runs the required alternating `full→dynamic`,
`dynamic→full`, `full→dynamic` current-HEAD campaign with a durable
`paired-performance.json`. `--execute` is the canonical spelling and `--paired`
is an executable compatibility alias. The frozen `--verify-threshold` selector
also executes the paired campaign and fail-closes on inadmissible evidence;
none of these execution modes is implied by the no-argument smoke wrapper.

## Interpretation

Observe and shadow retain the complete plan as the authority oracle. Enforce
authority is granted only when the gate-owned prerequisite vector is entirely
true. Otherwise the result is explicitly `full-fallback`, with the reason and
the invalidated command IDs persisted for triage.
