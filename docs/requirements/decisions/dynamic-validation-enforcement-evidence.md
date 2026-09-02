# Dynamic validation enforcement evidence

This document records the evidence required before enabling low-risk dynamic
TEST authority. It is a checklist of signed, current artifacts rather than a
claim that a synthetic smoke is historical proof. The current root inventory
is 112 commands: 58 explicitly classified `full-only` /
`whole-repository` validation-infrastructure rows and 54
`story-selectable` / `static-and-traced` rows, including the two DYN-5 gate
rows. Authority still falls back whenever a selected gate/full-only row or any
other prerequisite is not admissible. A full-only impact or unavailable
canonical baseline escalates the complete plan; with the current 58
`forbidden` rows, this full escalation is expected rather than an accidental
per-row fallback.

## Mandatory gate

The enforcement report must bind one current HEAD and contain:

1. 30–50 historical Story base/head replays spanning docs-only, local handler,
   shared core, lifecycle gate, process-fact, validation runtime,
   package/config, rename/delete, intentional red, and test-only changes.
2. For every replay, complete-plan failures are a subset of dynamic executed
   command IDs, with per-command verdicts and durable replay receipts.
3. FI-1 through FI-5 coverage for every applicable catalog row (dependency,
   omitted edge, full-only, whole-repository and delete/rename mutations).
4. Three alternating current-HEAD pairs (`full → dynamic`, `dynamic → full`,
   `full → dynamic`) with median wall time, selected/reused counts, closure and
   resource timelines, and zero residue.
5. Current inventory/catalog/graph/closure/baseline/runner/toolchain and
   revocation-ledger digests; no stale receipt is admissible, subject only to
   the bounded post-replay consumer exception below.
6. All Section 24 prerequisites true, including source-first build proof,
   periodic baseline policy, explicit catalog ownership and changed-test
   propagation.

Historical full/dynamic verdict differences remain in the signed record for
diagnosis, but do not invalidate the historical safety proof when the full-plan
failure set is fully selected and residue is empty. The three controlled
current-HEAD pairs are the separate exact-verdict-equivalence requirement.

## Receipt envelope

The report must reference the exact `selection.json`, `receipts.json`,
`revocation-ledger.json`, shard aggregates and cleanup records. A report that
only says “mutation audit PASS”, or that relies on an output marker without a
case-body success marker, is rejected. `observe` traces are also checked by
the closure certificate builder; invalid observations revoke affected prior
receipts instead of being report-only text.

## Current implementation status

The executable smoke paths are available under
`packages/main/src/tasks/story-aware-validation-*.ts`. The default wrapper is
plan-only and characterization-only; the following commands generate durable
replay/performance artifacts when capacity permits, but those artifacts remain
non-authoritative until a current signed review/baseline gate consumes them:

```sh
# Verify-only admission of an already-persisted signed replay artifact.
node scripts/run-dynamic-validation-replay.mjs --verify-threshold

# The only replay producer. It creates the paired campaign itself.
node scripts/run-dynamic-validation-replay.mjs --execute
```

An executable campaign restores and executes every *missing or semantically
incompatible* historical base/head record in detached worktrees, records
full-vs-dynamic per-command verdicts for that bounded remainder, and always runs
the three alternating current-HEAD pairs with timing/selection digests. Compatible
durable historical records are verified and reused rather than restored again.
`--execute` is the only producer path, and executable replay is always paired.
`--paired` is not an alias: it is rejected unless `--execute` is also present.
The frozen `--verify-threshold` checklist selector is verify-only: it admits an
already-persisted signed paired artifact plus mutation audit and never starts,
repairs, resumes, or replays a campaign. It fails closed when that artifact is
inadmissible; invoking the wrapper with no arguments remains plan-only. The wrapper also writes
`fault-injection.json` with per-catalog FI-1..FI-5 rows.

### Bounded post-replay consumer exception

An executed replay remains bound to its recorded HEAD. A later HEAD may admit
that replay only when the verifier recomputes the current inventory and catalog
digests and they exactly match the signed replay, and every changed path from
the recorded HEAD is either Story metadata or one of the exact named
non-executing consumers in `historical-replay-artifact.ts`. Those consumers
may read, retain, or mechanically verify a completed replay; they cannot
change its inventory, catalog, configuration, selection, runner, or producer.
The exception is therefore not a receipt re-binding mechanism and never admits
a stale replay after any producer-side change. All other head drift fails
closed and requires a new executed paired campaign.

`node scripts/run-dynamic-validation-replay.mjs --mutation=missing-evidence`
is deliberately mutation-only: it runs the fail-closed missing-evidence probe
without scanning or re-executing historical Stories. Historical discovery and
the signed paired replay remain explicit work performed only by the commands
above.

When an executable campaign is interrupted after historical records are
durably written but before the current-HEAD paired campaign completes, the
wrapper resumes rather than blindly replaying the entire population. It first
recomputes each historical selection manifest and accepts a record only when
its base/head identity, exact selected command set, execution/reuse totals,
full-escalation decision, dependency graph, zero residue, and both signed
full/dynamic receipts remain valid. Historical verdict differences remain
admissible only when every full-plan failure is dynamically selected; exact
per-command equivalence is required for the controlled current-HEAD pairs.
New records also
persist a selection-semantics digest for these fields. The complete raw
manifest digest is retained for diagnosis, but a change to an unrelated global
catalog or inventory member cannot by itself force the entire historical
population to re-execute. When full escalation selects the whole inventory,
the graph is not a resume discriminator because no graph edge can change what
runs. Missing, malformed, unsigned, or semantically
incompatible records are re-executed; the paired current-HEAD campaign is
never reused.

`--resume` is intentionally diagnostic and stops at the first incompatible
record. After human approval, `--execute --resume --repair-missing` performs
the bounded repair: it reuses every admissible signed record and executes only
the missing or semantically incompatible remainder before the mandatory
current-HEAD paired campaign. It is not equivalent to a fresh replay of the
whole corpus. `--verify-threshold` never performs this repair; its mechanical
selector is emitted only after the existing assurance report is admitted.

If an operator interrupts a replay while it is writing one historical record,
`--repair-story=<id> --execute` may regenerate that exact full/dynamic record.
It is deliberately non-authoritative: it produces no paired-performance report
and cannot satisfy the frozen threshold command by itself.
Operators must not promote this document to an enforcement approval without a
fresh, signed report bound to the target HEAD and a current canonical baseline.
