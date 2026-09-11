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

## Qualification audit corrections and measured checkpoint

Claude CLI session `b95b75b3-d65b-4bdf-a760-61395579c7c6` independently ran the
then-current calculator (86 checks) and event adapter (7 checks). Both passed,
but its source review correctly rejected a full acceptance claim. A passing
suite does not prove that it contains every required counterexample.

| Counterexample | Before repair | After repair at `0c8a5ab829` |
| --- | --- | --- |
| One critical precision miss among 200 observations | Aggregate 99.5% incorrectly passed | The critical stratum independently vetoes promotion |
| Add 4,000 synthetic successes to operational misses | Synthetic denominators diluted real errors | Operational denominator remains 200; synthetic failures remain a separate veto |
| Valid low-severity, independently eligible signed deferral | Incorrect precision failure (`0 !== 1` in the native fixture) | Eligible deferral counts as precise; false-deferral count remains zero |
| Census supplies only existing hashes | Existence masqueraded as adjudication | Exact semantic gold and rationale required under the independent report-bound PASS; mismatches count as failures |
| One large latency case masks small/unknown cases | Only corpus-level size checked | Every latency observation separately proves its measured population |

The first two became executable RED at `c6fda09dc2`: **0 PASS / 2 FAIL**.
After repair the same command ran **2 PASS / 0 FAIL**. This supplements the
original tool-owned four-gap RED; it does not replace that history.

At committed code checkpoint `0c8a5ab829`, the successful core build was followed
by `npm --prefix packages/main run test:dynamic-finding-evidence-closure`, exit 0:

| Suite | Named/grouped passing checks |
| --- | ---: |
| Qualification calculator | 87 |
| Native runtime/proposal/assessment/qualification/repair integration | 19 |
| Historical source producer and ordered pair | 18 |
| Native material re-attestation | 9 |
| Experiment and matched-workflow query adapters | 13 |
| Earlier evidence-closure regression | 9 |
| Audit boundary regression | 6 |
| Original four-gap pinned regression | 4 |
| Qualification audit counterexamples | 2 |
| **Total** | **167** |

Both `node scripts/verify-process-fact-contract.mjs` and
`node scripts/verify-runtime-fact-contract.mjs` exited 0. The official
`npm run lab:worktree -- green dynamic-finding-evidence-closure` reran the exact
pinned RED command: **4 PASS / 0 FAIL**, GREEN recorded at `0c8a5ab829`.

These counts are not independent production observations or completed plan
requirements. The 58-case route/renewal/recall suite previously passed at
`c09d232b2a`; the qualification-only checkpoint did not change its recall/route
implementation. Added assertions cover observe/kill-switch zero-ledger-delta,
invalid-L4 recall, expiry-triggered recall and exactly-once replay.

Claude CLI re-audited `0c8a5ab829` and executed the four qualification commands:
**2 + 87 + 13 + 19 = 121** named/grouped checks, all exit 0. It confirmed the
strata veto, synthetic isolation, policy thresholds, per-observation latency
population and most census corrections. No unsafe release was demonstrated.
It retained one attribution concern, addressed in the follow-up below.

### Historical decision authorship follow-up

The census reader collected the Finding's reporter but overwrote the decision
author when the payload also contained `findingId`. The current official
proposal producer separately requires proposer = current Finding reporter, so
this is not a demonstrated bypass of that current CLI entry. The reader still
needs to protect historical/imported decisions with different attribution.

The isolated signed-ledger test at `64646b5816` authenticated its source Finding
and reproduced three **Missing expected exception** failures: assessment,
deferral and mandatory-repair self-adjudication. Earlier unauthenticated/missing
fixture setup failures were not target RED. After repair it ran **3 PASS / 0
FAIL**. A genuinely separate third reviewer passes; both reporter and decision
author refuse. The native qualification/runtime integration also reran **19
PASS**, including the normal positive independent case.

Repair commit `fcedce14d4` preserves both authors, follows exact signed-ledger
assessment/proposal references and checks the proposal record hash. The
qualification policy digest now includes the attribution rule, so older cases
cannot retain the previous weaker semantics. Prompt and registry guards were
updated together. The new three-case test is in the combined suite.

Claude CLI then verified the attribution correction in source at `fcedce14d4`,
including the policy-digest invalidation, and corrected its earlier framing:
the current official producer is not the demonstrated exposure. Its independent
executions passed runtime integration **19**, historical source/pair **18** and
material re-attestation **9**. No open source finding remained in this bounded
audit, and it found no unsafe release.

Two executions did not qualify as independent GREEN: the new attribution test
aborted before assertions and routes stopped after 21 passes with
`cross-provider direct reviewer evidence is advisory-only: mixed provider
ancestry=claude->codex`. This is a host/fixture refusal, not target RED or a
production defect. Commit `65e5a62bd9` uses the existing test-only isolated
worker for those two suites and preserves the routes selector in worker argv.
No production provider rule, hook, broker verifier or process observer changed.
Workers own only disposable repositories and their own test broker keys.

Claude independently reproduced attribution **3 PASS / 0 FAIL** at
`65e5a62bd9`: the attribution finding is now execution-closed, not only
source-closed. The author also ran the full combined suite at that commit:
**170 named/grouped checks, exit 0** (the prior 167 plus the new three).

Routes then reached 46 passing assertions twice under Claude, but the isolated
worker's fixed 120-second watchdog stopped both executions before completion.
Neither timeout was counted as RED or GREEN. Based on those two measurements,
`c5d49240bb` gives only that allowlisted integration entry 300 seconds; all
other isolated fixtures remain at 120 seconds. This changes no production
runtime or gate timeout. Claude made one final routes execution with its outer
timeout longer than the fixture's own budget: **58 PASS / 0 FAIL, exit 0**,
without a retry. Both route/candidate summary lines refer to the same 58 cases,
not 116 observations.

### Final independent execution record

Claude CLI session `b95b75b3-d65b-4bdf-a760-61395579c7c6` reports the following
completed executions, separate from its earlier 121-check qualification audit:

| Suite | Committed code/fixture checkpoint | Exit | Passing checks |
| --- | --- | ---: | ---: |
| Historical source/pair | `fcedce14d4` | 0 | 18 |
| Material re-attestation | `fcedce14d4` | 0 | 9 |
| Native runtime/qualification/repair integration | `fcedce14d4` | 0 | 19 |
| Historical attribution independence | `65e5a62bd9` | 0 | 3 |
| Routes, renewal and automatic recall | `c5d49240bb` | 0 | 58 |
| **Total for this execution set** | | **0 failures** | **107** |

Production handlers are byte-identical after `fcedce14d4`; the two subsequent
commits change test isolation and its measured watchdog budget only. Claude's
bounded verdict has no remaining source finding or unexecuted suite in its
scope. The independence correction is both source-verified and independently
executed. That verdict does not claim full execution-plan acceptance, arbitrary
unrelated-code safety, operational qualification or a release.

The successful 170-check combined suite at `65e5a62bd9` is retained. Only the
routes watchdog changed afterward; the other fixture entries retain their
original budget. Process-fact and runtime-fact contract checks exited 0 after
the final production-code correction. No unrelated 134-command repository
validation cycle was started to close this Lab.

### Explicit remaining limits

- Re-attestation currently admits only the closed audit-narrative exception.
  Changed or unknown code/config/process/route/canonical dependencies remain
  blocked. This is not a general semantic classifier proving every unrelated
  code change safe; fresh targeted execution and independent review remain
  required.
- The pair fixture proves actual historical execution and its strict join,
  not a new end-to-end target-consented `pre_existing_unaffected` assessment
  acceptance fixture.
- Automatic recall runs at the next authorized owner transition boundary,
  not in a background scheduler. A corrupt/unresolvable historical subject
  remains pending and never gains a waiver.
- No operational 20-Story/200-case/30-day window, measured user time saving,
  enforce eligibility, main finish, version bump, push or formal Story DONE is
  claimed. Matched-cohort timing is process elapsed time, not human active time
  or a causal estimate of saved development hours.
