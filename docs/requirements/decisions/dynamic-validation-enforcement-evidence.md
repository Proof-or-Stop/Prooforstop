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
   revocation-ledger digests; no stale receipt is admissible.
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
node scripts/run-dynamic-validation-replay.mjs --verify-threshold
node scripts/run-dynamic-validation-replay.mjs --execute
node scripts/run-dynamic-validation-replay.mjs --execute --paired
```

All three commands restore each historical base/head in detached worktrees, record
full-vs-dynamic per-command verdicts, and run the three alternating current-HEAD
pairs with timing/selection digests. `--execute` is the canonical spelling;
`--paired` remains an executable compatibility alias, and executable replay is
always paired. The frozen `--verify-threshold` checklist selector also executes
that paired campaign and fail-closes on an inadmissible report; invoking the
wrapper with no arguments remains plan-only. The wrapper also writes
`fault-injection.json` with per-catalog FI-1..FI-5 rows.

When an executable campaign is interrupted after historical records are
durably written but before the current-HEAD paired campaign completes, the
wrapper resumes rather than blindly replaying the entire population. It first
recomputes each historical selection manifest and accepts a record only when
its base/head identity, selection identity, per-command equivalence, zero
residue, and both signed full/dynamic receipts remain valid. Missing,
malformed, unsigned, or incompatible records are re-executed; the paired
current-HEAD campaign is never reused.

If an operator interrupts a replay while it is writing one historical record,
`--repair-story=<id> --execute` may regenerate that exact full/dynamic record.
It is deliberately non-authoritative: it produces no paired-performance report
and cannot satisfy the frozen threshold command by itself.
Operators must not promote this document to an enforcement approval without a
fresh, signed report bound to the target HEAD and a current canonical baseline.
