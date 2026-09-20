# One cumulative provider invocation quota

This bounded Lab repairs launch routes that could bypass an explicitly configured
shared call ceiling. It does not configure a desktop conversation or put a ceiling
on model turns inside a provider CLI. See [configuration and limits](../host-run-shared-budget.md).

The RED command is `node scripts/verify-shared-provider-quota.mjs`, recorded by
`lab:worktree red shared-call-quota-rg` at
`af630b22e9de364e3b84ec629c367b0fc35532f9`. The source baseline is local main
`0839f9ab0c77a288491a061653cea8c803806941`. A prior syntax-error attempt was
rejected by the Lab driver and is not behavioral RED evidence.

With an explicit cumulative cap of **2**, the actual intercepted transport counts
were:

| Scenario | RED | Repaired replay |
| --- | ---: | ---: |
| Direct host owner | 2 | 2 |
| Managed worker with inherited configuration | 2 | 2 |
| Managed submission configured, worker environment missing it | 3 | 2 |
| Host calls followed by a plan | 3 | 2 |
| Host calls followed by repair | 3 | 2 |
| Host calls followed by custom audit | 3 | 2 |
| Two separately metered plans | 4 | 2 |

The cap is a fixture input, not a new default. Tests count calls crossing the
trusted runner boundary; no paid model is contacted. Positive controls let repair
and custom audit each consume one remaining slot before refusing the next host
call. Refusals must identify quota exhaustion, so unrelated launch failures cannot
satisfy the regression.

All registered launch owners now consume the existing canonical-project atomic
ledger. Bounded adapters reserve retry capacity before transport and release only
proven unused attempts. Exceptions retain uncertain reservations. Live request and
transport identity prevents charging one nested attempt twice. Managed submissions
persist quota-only environment values in their immutable spec and idempotency
identity; workers restore that policy and reject conflicting settings.

The same regression also runs 17 edge groups: all three adapter retry and early
completion paths, invalid counters, frozen exceptions, redacted child environment,
forged delegation, repair partitions, asynchronous starts, standalone review, and
managed environment loss/idempotency/conflict. Its structural check uses the
registered execution inventory and AST call sites, with missing-owner and
removed-call negative controls. A cold module import protects Lab bootstrap before
source hooks are installed. These checks guard known owned paths; they do not
prove arbitrary external code or provider-internal model calls.

Additional replay commands:

- `node scripts/ensure-dist.mjs`
- `node node_modules/typescript/bin/tsc -p packages/main/tsconfig.json --noEmit`
- `node scripts/verify-shared-provider-quota-process.mjs`: ten real local Node/native
  children through three adapter/supervisor chains, the direct supervisor,
  readiness with redacted child environment and two batches sharing one quota.
- `node scripts/verify-benchmark-behavior.mjs`: the quota suite and six existing
  benchmark regressions, including cross-process/restart/worktree accounting.
- `node scripts/verify-supervised-provider-boundaries.mjs`
- `node packages/main/dist/tasks/provider-claude-smoke.js`
- `node packages/main/dist/tasks/provider-gemini-smoke.js`
- `node scripts/verify-validation-static-edges.mjs`

The static manifest was refreshed only after checking prior source/excerpt
bindings. It reanchors 26 existing calls, 31 current excerpts and 86 dependency
references. The routine benchmark invocation's timeout changes from 30 to 60
seconds and its rationale/dependencies now include the bounded quota fixtures.
The other existing call expressions and exception classifications are unchanged.
Both original and repaired scanner runs report zero needs-review and nested rows.

Broader health is not relabelled as GREEN. `verify-reviewed-source-bindings.mjs`
fails at the same causal-source assertion on the baseline; direct comparison of
its actual reader reports the same 38 failures before and after, with no new row.
`provider-codex-smoke.js` reaches an existing agent-dispatch fixture missing
verification-intent classification; the same command fails on the built baseline.
`managed-host-run-smoke.js` reaches a managed evidence fixture refusal; its E2E
child reproduces `stale_material,producer_owned_required` on the built baseline.
An initial baseline managed run also observed an earlier snapshot/event recovery
race. These failures remain unresolved and are not covered by this bounded repair.

The first finish candidate was rejected by the independent audit. The repair
preserves structured owner refusals, final accounting and dispatch transcripts;
passes explicit context to readiness/batch probes; measures reference-mode prompt
content; and records the actual armed attempt allowance. A second behavioral RED
at `a833fc20b8` exposed escaped plan/repair refusals before these corrections.
The official replay now includes `verify-shared-provider-quota-refusals.mjs`,
which exercises standalone review, repair and all three public dispatch hosts,
checks linked final ledger rows, and rejects forged error-text classification.
Readiness/batch real-process checks include an existing bounded positive control;
no new pre-change bypass is claimed for that control.

The authoritative local RED/GREEN, independent audit and finish receipts are
owned by the Lab driver. Lab completion is local maintenance evidence, not formal
Story DONE or signed product-release evidence.
