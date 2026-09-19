# Benchmark execution controls: bounded Lab experiment

This experiment tests the six controls requested after the token-consumption
investigation. It does not change the Codex Desktop scheduler, Story policy,
approval rules, reviewer infrastructure, or the active benchmark task.

The RED candidate exports an explicit uncontrolled adapter. Its observation path
uses the actual existing 0.3.425 monitor filter: changes to progress/timestamps
still wake the model despite an unchanged external blocker. The uncontrolled
execution and full-history context paths are experimental comparison fixtures,
not claims that we have reconstructed the whole production host.

The same committed regression command is used for RED and GREEN:

    node scripts/lab/benchmark-controls/verify.mjs

The GREEN controller will own its injected execution boundary. Offline fixtures
cover blocking, in-flight/result deduplication, aggregate and partition budget
reservation, provider-identity usage accounting, bounded context and process
completion. Stub usage values are synthetic; local subprocesses are real.
No paid model call is needed. Historical replay is counterfactual, not actual
saved tokens. This Lab cannot establish that all 1.56 billion historical tokens
would have been avoided.

Scope exclusions: production integration, cross-process persistent reservations,
durable dispatch acknowledgements, operator approvals, Story DONE, independent
audit and local-main integration. The worktree is retained for review.
