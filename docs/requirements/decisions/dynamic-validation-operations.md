# Dynamic validation operations runbook

This runbook is the operator contract for the four policy modes.

## Mode selection and rollback

Set `validate.dynamic.mode` (or the legacy `validation.dynamic.mode` alias, or
pass `--dynamic-mode`) to one of:

| Mode | Behavior | Authority |
| --- | --- | --- |
| `off` | ordinary complete validator | full plan |
| `observe` | compute and persist selection, then run the complete plan | full plan |
| `shadow` | execute the dynamic plan, then the complete plan and compare verdicts | full plan |
| `enforce-low-risk` | use the dynamic result only after every gate-owned prerequisite passes | dynamic for eligible local/docs Stories; otherwise full fallback |

Without `--story`, all non-off modes are bounded previews: zero project
commands execute, no receipts are issued, and no TEST/DONE authority is granted.

The typed project configuration also accepts `validate.dynamic.policyDefaults`
for catalog defaults such as `assurance`, `riskTier`, `closurePolicy`,
`fullBaselineReusePolicy`, `cpuWeight`, and `expectedP50Ms`.

## Required configuration

Canonical `proof-or-stop.config.json` (with legacy `lattice.config.json`
fallback) owns the inventory. Each object in `validate.commands` contributes a
policy tuple; the verifier records the resulting effective tuple after applying
the registered policy defaults and bounded scheduler fallback for legacy rows.
The current 112-row catalog has 58
full-only/whole-repository validation-infrastructure rows and 54
story-selectable/static-and-traced rows; defaults remain only a fail-closed
parser fallback for legacy external configurations. Each object in
`validate.commands` must preserve these effective fields through the verifier
inventory: `assurance`, `riskTier`, `closurePolicy`,
`fullBaselineReusePolicy`, `cpuWeight`, and `expectedP50Ms` (the latter is a
configured value when present, otherwise a bounded timeout-derived scheduler
value). For DYN-5, the effective row also carries
`caseRegistryPath`, `runnerSourcePath`, `declaredEnvironmentKeys`, and
`env.LATTICE_VALIDATION_SHARD_ADAPTER`. The runner source is included in the
catalog input roots so changing it revokes the closure/baseline evidence.

`full-only` is a complete-plan escalation policy, not merely a row-level
fallback label. An impacted full-only row escalates the complete plan. An
unimpacted row may avoid escalation only when its declared
`fullBaselineReusePolicy=exact-current-epoch-only` has a valid, signed
canonical baseline receipt for the current epoch. `forbidden` rows never
reuse; until the catalog contains an exact-epoch policy for them they make the
complete plan execute. The current catalog deliberately has 58 `forbidden`
validation-infrastructure rows, so current runs are expected to full-escalate
until that policy population is changed with fresh evidence.

The registry is a project-relative JSON array. Each case has a stable `caseId`,
domain (`quorum` or `review-pass`), a sentinel flag, and an executable
`runner` (`command`, `args`, optional `cwd`/`env`, and an optional success marker;
when omitted, the adapter derives a deterministic marker from the case id). The
registered adapter checks the registry digest, exact case routing, executes
every runner in an isolated shard, writes one case-evidence file bound by its
content digest, and emits a signed `ValidationShardReceipt` for the shard;
the receipt—not the per-case file—carries the signature gate. It fails closed
on a static marker or missing body execution.

## Artifacts and inspection

For Story `B-xxxx`, inspect:

```text
.proof-or-stop/runtime/dynamic-validation/B-xxxx/selection.json
.proof-or-stop/runtime/dynamic-validation/B-xxxx/report.txt
.proof-or-stop/runtime/dynamic-validation/B-xxxx/receipts.json
.proof-or-stop/runtime/dynamic-validation/B-xxxx/revocation-ledger.json
.proof-or-stop/runtime/dynamic-validation/B-xxxx/shards/*
```

Every selection row explains `execute`, `reuse`, or fail-closed disposition.
Receipts bind command identity, input/closure/catalog/inventory digests, runner
and toolchain, build proof, baseline epoch, ancestry, clean tree, expiry and
the append-only revocation-ledger digest. Shard artifacts additionally expose
case coverage, sentinel, adapter/registry digests and cleanup residue.

## Triage and recovery

| Symptom | Required response |
| --- | --- |
| `catalog/inventory mismatch` | refresh the catalog and rerun catalog verification |
| `closure-certificate-unavailable` | run the complete baseline; do not reuse |
| `undeclared-runtime-*` | inspect trace, add a justified declaration or keep full-only |
| `baselineCurrent=false` | establish a fresh canonical full baseline for current main |
| `receipt revoked/expired` | rerun the affected command and retain the ledger history |
| DYN-5 registry/adapter failure | fix registry/runner routing; aggregation remains FAIL |
| scope/protected/unmapped change | full validation; never override with a text flag |

Rollback is non-destructive: set mode to `off` or `observe`. Existing Story
evidence remains valid, while dynamic receipts simply stop being consumed by
the authority predicate.

To establish a canonical full baseline for the current HEAD, run the ordinary
unscoped complete validator with dynamic mode off:
`proof-or-stop validate --dynamic-mode=off --json` after a clean build. The
verifier writes the baseline only for this non-Story complete-plan run, after
it passes and all runtime closure traces are admissible. Inspect the resulting
`.proof-or-stop/runtime/dynamic-validation/canonical-baseline.json` before
expecting reuse. If it is missing, expired, or digest-mismatched, the gate
selects full validation.

Explicit `--full` and TEST/DONE Story validation use the complete canonical
command plan regardless of the configured dynamic mode. Selective execution is
limited to DEV/REVIEW iteration; cached dynamic receipts do not remove final
canonical command obligations. Exact-input evidence reuse retains its separate
existing authority checks.
Focused invocations remain diagnostic subsets and do not mint complete routine
validation evidence, including the legacy combination of `--full` with `--focus`.
