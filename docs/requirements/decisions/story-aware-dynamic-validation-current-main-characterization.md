# Story-aware dynamic validation: current-main characterization

This record is the baseline for the layered validator described in
[`story-aware-dynamic-validation-execution-plan.md`](story-aware-dynamic-validation-execution-plan.md).
It is intentionally evidence-first: a green smoke is not treated as proof of
TEST authority unless the signed manifest, closure certificates, receipts and
revocation ledger all bind to the same HEAD.

## Inventory and policy

The inventory is discovered from `lattice.config.json` (or `validate.commands`)
and receives a stable command ID from command plus arguments. Every command
must carry the catalog policy tuple:

| Field | Meaning |
| --- | --- |
| `assurance` | `always`, `story-selectable`, or `full-only` |
| `riskTier` | `local`, `shared`, `gate`, or `validation-infra` |
| `closurePolicy` | `static-and-traced`, `whole-repository`, or `never-reuse` |
| `fullBaselineReusePolicy` | `not-applicable`, `exact-current-epoch-only`, or `forbidden` |
| `caseRegistryPath` | in-root DYN-5 registry, when sharding is required |
| `declaredEnvironmentKeys` | command-specific environment reads allowed by closure |

Missing policy is recorded as `policySource=default` and cannot satisfy the
enforcement ownership prerequisite. This makes an unregistered command fail
closed instead of silently entering the reusable set.

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
```

The production smoke uses the same configured-command parser as the verifier,
executes both review-pass and quorum registry-backed shards, validates every
signed receipt, and requires the case runner to emit a case-body success marker.
The mutation smoke covers catalog, closure, receipt, selection, scheduler and
shard fault classes. A root `npm test` result remains a separate full-suite
signal; a failure in an unrelated legacy assertion must not be relabeled as a
dynamic-validation PASS.

## Interpretation

Observe and shadow retain the complete plan as the authority oracle. Enforce
authority is granted only when the gate-owned prerequisite vector is entirely
true. Otherwise the result is explicitly `full-fallback`, with the reason and
the invalidated command IDs persisted for triage.
