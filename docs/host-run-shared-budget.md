# Explicit shared host-run budget

Use one stable `PROOF_OR_STOP_RUN_BUDGET_ID` for the entire bounded job, with
`PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS` as a positive integer. Every participating
`host_run` must inherit both settings. Canonical project identity makes linked
worktrees share the same atomic reservation file. Separate processes and restarted
clients consume the same ceiling. This opt-in policy does not change unconfigured
callers or attach a budget to an existing desktop conversation.

Optional controls:

- `PROOF_OR_STOP_RUN_BUDGET_MAX_REPAIR_CALLS`: positive repair-call ceiling within
  the total. When set, every caller must explicitly set
  `PROOF_OR_STOP_RUN_BUDGET_CATEGORY=repair` or `product`.
- `PROOF_OR_STOP_RUN_BUDGET_MAX_PROMPT_BYTES`: positive UTF-8 byte ceiling on the
  supplied prompt. Oversize requests are refused whole before launch. Never
  truncate acceptance requirements or reviewer context to fit this limit.

The first reservation binds the group's limits. A changed policy under the same
ID is refused. Owners must not change IDs, remove the environment, relabel repairs
as product work, or delete state merely to evade an exhausted budget. Resume only
with an explicitly authorized new budget. Reviewers should compare reservations,
transport counts and final usage rather than infer coverage from a blocked label.

Reservations are persisted before execution under the registered canonical-project
runtime directory. Concurrent checks use an ownership-aware lock. Proven
non-spawn releases the reservation. Completed calls remain charged, and exceptions
or crashed processes keep their reserved slot because consumption is uncertain.
A lost terminal settlement therefore underuses the allowance rather than silently
reopening it. Corrupt state, invalid settings, policy drift and lock failure do not
launch the provider. Turning off the optional usage ledger does not turn off an
explicit shared budget. Provider accounting remains null when not reported.

A throwing host transport writes a terminal usage row linked to its preflight
record when the ledger is enabled. A bounded stdout scanner preserves provider
usage received before the exception through the normal provider adapters. Missing
usage, stderr-only numbers and a later truncated candidate remain unavailable.
These are the provider-reported counters, not a claim that an interrupted run's
entire bill is known. Raw exception text is never stored as the accounting reason.
The original exception still propagates. Abrupt process death can still leave only
a preflight row, while the budget reservation remains charged. Verify the exception
path with `node scripts/verify-benchmark-exception-usage.mjs`.

This is a **host invocation count**, not a token, price, model-turn or elapsed-time
upper bound. A provider CLI can perform multiple model turns within one invocation.
The byte ceiling covers the prompt supplied by this repository, not hidden provider
instructions, files loaded by the provider or desktop conversation history. Calls
outside `host_run` and callers that omit the group are outside this contract.
The runtime files are operational accounting, not signed Story evidence or an
independent usage audit. Existing managed idempotency remains the duplicate-run
mechanism; a shared budget is not a replacement for execution keys.

Malformed provider counters become null in reservation accounting; recovering old
malformed counters never releases a charged call. Refusals before the trusted
runner boundary release their reservation, while runner exceptions remain charged.
If settlement fails after a completed run, `HostRunResult.budgetSettlementError`
reports `host_run_budget_settlement_failed`; stdout, exit status and usage remain
available. A corrupt reservation structure still blocks subsequent launches.

Reproduce with `node scripts/verify-benchmark-shared-budget.mjs` and
`node scripts/verify-benchmark-budget-adversarial.mjs`. Both use actual host-run
entry logic with the paid transport intercepted, isolated runtime state and
fixture usage. They create no paid model requests and do not mutate active Stories.

For the complete local Lab replay, run `node scripts/verify-benchmark-release.mjs`.
It owns the content-bound build and explicit TypeScript check before the dist
smokes. It covers the focused entry,
reservation, restart, exception, budget-meter and usage regressions plus static
source-evidence consistency. The source bindings were regenerated after reviewing
the added registry assertions; existing subprocess expressions, classifications,
reasons and invocation restrictions are preserved. Both process/runtime contract
verifiers execute in the replay. Only their exact recorded baseline failure lists,
causes and unchanged source bindings are admitted; extra failures, command errors,
signals or changed baseline sources fail the replay. The known failures remain
printed as failures, not PASS evidence. This replay is not a full repository-health
verdict or formal Story completion evidence.
