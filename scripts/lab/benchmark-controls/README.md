# Benchmark execution controls: bounded Lab experiment

This experiment tests the six controls requested after the token-consumption
investigation. It does not change the Codex Desktop scheduler, Story policy,
approval rules, reviewer infrastructure, or the active benchmark task.

The RED candidate exports an explicit uncontrolled adapter. Its observation path
uses the actual existing 0.3.425 monitor filter: changes to progress/timestamps
still wake the model despite an unchanged external blocker. The uncontrolled
execution and full-history context paths are experimental comparison fixtures,
not claims that we have reconstructed the whole production host.

The historical RED commit `528a347380984bbb647948e1f068a8c5004bef6c`
re-exports `baseline.mjs` from `controller.mjs`. The GREEN commit
`e53b608f672291286b3d98b7ce5bebaaf8eb5cdc` replaces that re-export with the
repair. The same command was run on those two different committed trees:

    node scripts/lab/benchmark-controls/verify.mjs

The GREEN controller owns its injected execution boundary. Offline fixtures
cover blocking, in-flight/result deduplication, aggregate and partition budget
reservation, provider-identity usage accounting, bounded context and process
completion. Stub usage values are synthetic; local subprocesses are real.
No paid model call is needed. Historical replay is counterfactual, not actual
saved tokens. This Lab cannot establish that all 1.56 billion historical tokens
would have been avoided.

Scope exclusions: production integration, cross-process persistent reservations,
durable dispatch acknowledgements, operator approvals and Story DONE. Local Lab
integration uses the separate mandatory independent-audit/finish workflow.

## Mechanical boundary and measurements

`controller.mjs` projects verified observations onto task, phase, candidate,
policy, blocker dependencies/binding, and execution identity/status. Progress
and observation time never wake a model. Relevant changes request re-evaluation;
they do not grant approval. Invalid observations report once and block new work
until recovery. Caller-supplied `verified` is a fixture contract, not a signature
verifier or an authorization mechanism for production use.

All injected executions pass through one in-process registry. The key includes
task, candidate, policy, cwd, exact argv, witness, and provider. In-flight calls
share a promise; settled success/failure is reused. Retrying a failure requires
an explicit new witness or candidate; there is no automatic retry. These inputs
must identify the complete environment before production adoption.

Budget checks synchronously reserve before adapter launch. Calls, cached input,
uncached input and output have aggregate and product/repair partition ceilings;
elapsed wall time has a shared deadline. Zero means zero. Actual known usage
settles reservations; missing/invalid usage keeps its reservation and stops new
dispatch. Duplicate provider/response IDs stop accounting rather than double
count. Actual overruns remain visible and stop further dispatch. An external
provider must enforce its own output limit to guarantee an upper token bound.
Timeout sends an AbortSignal only to this controller's adapter. An adapter that
ignores it may continue; the reservation stays unknown and is never released.

The compact context contract carries current task, phase, blocker, decision and
log references. It rejects oversized facts, never silently truncates them, and
does not read growing history. Production orchestration must actually adopt
this contract; this Lab cannot shorten this desktop conversation retroactively.

`verify.mjs` retains every original RED assertion and adds reservation-mutation
and call-ceiling-tampering coverage. `compare.mjs HISTORY.json OUTPUT.json`
reports deterministic before/after counts, UTF-8 context bytes, three alternating
rounds of real local-process elapsed time, and a separate historical projection
replay. The historical RED commit failed at its first assertion; this refers to the
recorded old tree, not an alternate runtime arm in the current repaired tree. Its
elapsed time is not compared to the full GREEN suite as a performance improvement.
The comparison requires a separately extracted HISTORY.json and is not part of
the deterministic regression command. To reproduce historical RED without editing
the active checkout:

```sh
benchmark_red_dir=$(mktemp -d)
git archive 528a347380984bbb647948e1f068a8c5004bef6c scripts/lab/benchmark-controls scripts/lab/benchmark-monitor-change-filter | tar -x -C "$benchmark_red_dir"
node "$benchmark_red_dir/scripts/lab/benchmark-controls/verify.mjs"
# Expected nonzero exit and BLOCKED_PROGRESS_WAKE_REGRESSION.
```

The current `verify.mjs` always runs its nonempty suite, including when imported
by a module wrapper. Shared fixture imports live in `fixtures.mjs`; comparison
does not execute tests as an import side effect. `verify-entry.mjs` additionally
checks both the ordinary CLI and module-wrapper invocation and requires the
structured nonempty result. Four negative-check groups exercise invalid budgets,
requests, partitions and context shapes. None of these checks launches a model.

Historical extraction is reused unchanged from
`../benchmark-monitor-change-filter/extract-history.py`. It reconciles per-response
usage and excludes missing observations. The new controller is not replayed on
incomplete historical execution facts. The historical filter's result therefore
does not claim additional savings beyond the already integrated 0.3.425 filter.

No independent audit is claimed. Before any integration, use the separate Lab
audit/finish workflow and satisfy the user's integration authorization requirement.
