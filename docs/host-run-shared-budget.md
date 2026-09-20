# Explicit shared provider invocation quota

Use one stable `PROOF_OR_STOP_RUN_BUDGET_ID` for the entire bounded job, with
`PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS` as a positive integer. Every participating
job owner must supply both settings. The same ID and canonical project identify
one quota across host runs, managed workers, plans, standalone reviews, repairs,
general dispatch, bounded adapters, supervised processes and custom Lab audits. Canonical project identity makes linked
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
instructions, files loaded by the provider or desktop conversation history. External processes outside these registered launch owners and jobs that never
configure a group remain outside this opt-in contract. A job must not remove or
change its ID to evade the quota. This does not configure the Codex Desktop
scheduler or limit provider-internal model turns.
The runtime files are operational accounting, not signed Story evidence or an
independent usage audit. Existing managed idempotency remains the duplicate-run
mechanism; a shared budget is not a replacement for execution keys.

Malformed provider counters become null in reservation accounting; recovering old
malformed counters never releases a charged call. Refusals before the trusted
runner boundary release their reservation, while runner exceptions remain charged.
If settlement fails after a completed run, `HostRunResult.budgetSettlementError`
reports `host_run_budget_settlement_failed: <cause>`; stdout, exit status and usage
remain available. On a transport exception, a settlement failure reports the same
cause to stderr while preserving the exact original exception, including frozen
objects. A corrupt reservation structure still blocks subsequent launches.

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

Routine behavioral coverage runs through `npm run test:benchmark-behavior`, the
canonical `npm test` inventory and the registered `proof-or-stop validate` command.
It runs the shared-quota regression and six existing private-fixture regressions
without building or calling the process/runtime contract verifiers. Individual `test:benchmark-*` aliases remain available. The Lab release
entry separately owns build/typecheck, registration and full-suite inventory smoke
checks, static evidence, usage smokes and complete contract invocations.

The existing snapshot-binding baseline is a static AST check: its only read is
`shared-validation-execution.ts`, parsed by TypeScript. The Lab classifier pins
that entire source, the verifier, the resolved TypeScript parser bytes and the
complete normalized assertion diagnostic, including Node stack/version. It does
not infer unchanged runtime facts from an umbrella assertion message. Any binding
or diagnostic drift refuses the exception. That baseline failure stops the runtime
verifier; checks ordered after it remain unexecuted and are not claimed as passed.

## Shared launch ownership and retry accounting

A task's launch owners consume the same durable reservations. Per-plan budget
meters and concurrent-process slots remain additional restrictions, never
substitutes for the cumulative quota. Configure the quota once on the owning
job process and keep the ID stable across all stages. No default number is
implied by the regression fixtures.

Managed submissions capture only the quota variables in their immutable spec
and bind them to idempotency input identity. The worker restores that binding
even if its ambient environment loses the settings. A worker or resumed
submission claiming a different quota is refused; provider output and runtime
observation cannot replace this submission-owned policy. Historical records
without the field retain their original opt-in environment behavior.

Bounded provider requests reserve their available retry allowance atomically
before transport and pass only that allowance to the adapter. A valid positive
attempt count releases unused retries; errors, malformed counts and interrupted
work retain reservations. This conservative accounting can underuse a quota,
but does not authorize extra work. Late settlement failures preserve the
execution outcome and emit a diagnostic. Nested planner/adapter/supervisor
layers reuse an active in-process object identity so the same attempt is
charged once; serialized or copied objects cannot declare themselves exempt.
Other independent calls always obtain their own reservation.

`SHARED_PROVIDER_QUOTA_RUNTIME_POLICY` registers the owners and their quota
call edges. `node scripts/verify-shared-provider-quota.mjs` exercises all five
previous cross-route counterexamples, retry/exception cases and live binding
behavior. The coverage verifier checks the current provider inventory and
rejects an unregistered owner or a removed call site. It is a structural
regression guard, not a claim to prove arbitrary dynamic JavaScript or external
provider subprocesses. The same verifier runs in the routine benchmark behavior
suite. Test transport is intercepted; no paid model call is required.
