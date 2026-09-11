# Dynamic Finding four-gap follow-up on 0.3.315

## Authorization and baseline

This is bounded Lab maintenance, not Story administration. The existing
`codex/lab-dynamic-finding-evidence-closure` worktree was synchronized through
the official Lab command with local main `c382fe0835` (0.3.315), producing merge
`5de16c6c74`. Earlier Lab code and evidence were retained. No main integration,
version bump, remote publication, Story DONE, or enforce activation is claimed.

RED commit `bcec2515eb` registered
`node packages/main/tests/red/red-dynamic-finding-four-gaps.mjs`. The official
Lab RED recorded **0 passed / 4 failed**. Two checks are behavior/schema
counterexamples and two are wiring guards. They are not, alone, acceptance
proof for four completed features. The executable integration tests below are
the stronger evidence; final audit and committed GREEN must be recorded before
calling this repair accepted.

## Root causes and bounded repairs

| Gap | Baseline cause | Follow-up mechanism | Evidence boundary |
| --- | --- | --- | --- |
| Historical base/head | A current witness could assert `baseReproduced=true`; there was no exact historical execution join | Exact ancestor SHA runs in a detached disposable worktree; ordered historical/current receipts bind the same command, environment, toolchain, defect fingerprint and non-worsening impact vector | A missing historical harness/build dependency is refusal, not RED. Fingerprint/impact semantics still require independently reviewed executable witnesses. |
| Unrelated material drift | The gate recognized pending material re-attestation but had no complete runtime/route release path | Append-only reviewer-owned re-attestation binds the exact assessment/deferral, original dependency snapshot, fresh same-command executions, current target/canonical dependencies, and exact independent PASS | Only unchanged Story/scope/acceptance and the closed audit-narrative exception can qualify. Unknown files, code/config/policy changes, missing evidence and self-adjudication remain blocked. |
| Automatic recall | Existing history recall was explicit; invalid L4 deferral did not schedule owner-side recall | Owner transition boundary reconciles claimed deferrals through the existing receipted exactly-once recall handler, using proven cause digests | Gate/triage reads do not write. Observe/kill switch do not write. A recall failure never releases the floor or prevents returning to DEV for repair. |
| Qualification sources | Public aggregation supplied detector counts, while caller-reported rates/times could not establish the planned denominators | Preregistered executed mutation cases, independently reviewed gold, exact record census, matched workflow queries, monotonic frozen-population proposal clocks and explicit insufficient-evidence output | Synthetic executions never establish operational sample size. Missing gold, unmatched subjects, missing clocks/cohorts or prerequisites refuse enforce. A configured mode is not qualification. |

## Intermediate executed evidence

These results were obtained during development, not at one final frozen commit:

- Historical execution pair: **10 assertions passed**, including running the
  base after the owner already has commits, preserving the owner HEAD, reversed
  or repeated receipts, wrong base, worsening, repaired/nonreproducing output,
  and revoked runtime keys.
- Material re-attestation: **8 assertions passed** using real linked worktrees,
  signed target consent and baseline, native independent review, and actual
  runtime receipts. The sequence is valid initial deferral -> raw drift blocks
  -> new executions alone still refuse -> independent bound PASS restores the
  deferral. Metadata-only evidence commit is reusable; unknown extensionless
  input changes and observer self-adjudication refuse.
- Qualification event collection: **7 assertions passed**, including an actual
  failing negative control, omitted/repeated/self-reported/unregistered trials,
  and missing latency remaining explicit.
- Identity/route/renewal regression: **58 passing / 0 failed**, including signed
  invalid-deferral recall and same-cause replay producing no additional row.
- Process-fact contract verification passed before the final timing additions;
  it must be refreshed for the accepted commit.

The complete root build initially failed because this independent Lab lacked
its graph `d3` dependency. `npm --prefix packages/graph ci --ignore-scripts`
installed the locked dependencies without changing tracked manifests. That
environment failure is not part of the target RED and no graph source repair
was made.

## Audit trail and release boundary

Claude CLI intermediate audit session
`c754bde3-2b01-4c31-a1ca-edeb5ae90435` returned **NOT PASS**. Its source-only
inspection identified the absent historical execution producer, incomplete
base selector checks, missing ordered pair/evidence digest bindings, observe
mode recall mutation, and recall cause/idempotency problems. Those findings
guided the targeted corrections. It saw an in-progress working tree and is
not final certification. A later bounded audit is in progress.

Claude CLI session `4a986dad-fa9c-476d-9611-47c25031234b` subsequently executed
the pair (10 PASS) and re-attestation (8 PASS) tests. It found no demonstrated
unsafe release, but did **not** certify all contracts. Its dispositions:

- Historical-source refusal coverage: added actual mutable-ref, non-commit,
  non-ancestor, owner movement, successful cleanup and failed/dirty retention
  tests. The expanded pair/source suite reports **18 PASS**.
- Historical build locking: now holds the owner canonical build lock in
  addition to the detached probe lock. A controlled current-head producer
  launched inside the historical lock must refuse `build_in_progress`.
- Irrelevant old re-attestation: the proof reader now consumes the route
  reader's conditionally derived restoration, not an unconditional second
  re-attestation lookup. Stale unrelated records cannot be a second authority.
- Warn-mode writes: the audit inferred that "does not change gates" meant
  "does not persist anything". Section 10 of the execution plan explicitly
  permits non-authoritative warn persistence; its table reserves read-only
  behavior for observe. This repair preserves that boundary: owner-side warn
  recall appends pending non-authoritative candidates; gates keep the legacy
  result. The prompt explicitly states this. Added observe/kill-switch
  zero-ledger-delta tests; no mode was silently promoted.

The code checkpoint is `ebf669cfb6`; corrections and final validation follow it.
The new proposal-timing integration initially exposed an undefined optional
collector field rejected by canonical JSON signing. Absent performance metadata
now persists explicit `null`, not an undefined or fabricated zero. The runtime
integration has since passed **18 cases**, including the actual monotonic clock
and rejection of self-reported performance data.

The operational 20-Story / 200-independent-case / 30-day corpus is separate
from engineering fixtures. No measured user time saving, qualifying operational
window, autonomous semantic proof of all scope impact, or full plan completion
is inferred from the above counts. Formal B-03b7/B-e6d9 state is unchanged.
