# Frozen Review Inventory Epoch and Saturation Gate

Status: implemented by B-3f3d.

## Problem and evidence

The repeated REVIEW/DEV cost was not caused simply by “too many reviewers.” The
B-cdf6 reconstruction shows four lanes started on the same candidate
(`RR-043..RR-046`, HEAD `73f42d07d1`), but F-036 returned before docs and
test-coverage terminated. Commit `155e787d0c` changed the candidate at
08:47:17Z; the unfinished results were then necessarily stale and the workflow
created `RR-047..RR-051` (and later runs). This statement is anchored to
tracked, immutable repository evidence rather than the excluded session-analysis
document:

- `B-cdf6:RR-043`, `B-cdf6:RR-045`, and `B-cdf6:RR-046` are recorded in
  commit `8e9f72fc5424f499cb396ad92bc13558d88fb712` under
  `.lattice/story/actives/B-cdf6/`;
- `B-cdf6:RR-044` is recorded in
  `57bbc87d5faba0610cca88e088af1b54a327c0ef`;
- verified Finding `B-cdf6:F-036`, including its binding to `RR-043`, is
  recorded in `26a30e6cd7f00672e2b399d5d8e7473a4cbb1360`; and
- the material fix is the exact commit
  `155e787d0c92612f16e9c2dd011531b0caa18ee6`.

The handler smoke resolves every full commit and searches the corresponding
commit-qualified tracked B-cdf6 records for each identifier, so an abbreviated
or fabricated RR/Finding/commit cannot satisfy this provenance claim. The
findings were useful; the missing boundary was “finish the inventory on one
immutable subject before remediation.”

B-9812 supplies the second failure shape: 53 verified findings over 10 finding
rounds. A fixed smaller round count would merely hide late findings. Therefore
the optimization criterion is not number of rounds; it is a mechanically
verified saturation wave on a frozen candidate.

## Operator workflow

During REVIEW:

```bash
lattice review_inventory_begin --storyId=B-xxxx
lattice review_inventory_status --storyId=B-xxxx
lattice review_run_start --storyId=B-xxxx --agent=lattice-review-topology-critic
# submit the critic's terminal finding_add or review_pass_set with read evidence
lattice review_inventory_critic_set '{"storyId":"B-xxxx","epochId":"<epoch>","reviewRunId":"<critic-run>","agent":"lattice-review-topology-critic","findingDispositions":[{"findingId":"B-xxxx:F-001","disposition":"verified_family","familyKey":"finding:B-xxxx:F-001","reason":"independent critic retained this verified family"}]}'
# use findingDispositions:[] only when the aggregate verified finding set is empty
lattice review_inventory_wave_advance --storyId=B-xxxx # only when status reports new families
lattice review_inventory_finalize --storyId=B-xxxx
```

`begin` prints the epoch ID, `State: OPEN`, frozen material cutoff and exactly
one status command. `status` prints every required lane, current wave, verified
and newly verified finding counts, blocker codes and exactly one `Next:`
command. For an OPEN epoch these are live projections from current signed
ReviewRun/pass/finding evidence; they do not wait for `finalize` to append a
wave. The unique next action progresses from the first missing lane, to the
independent critic dispatch/receipt, then to `review_inventory_wave_advance`
when the wave added families, and only to finalize when the current wave added
zero. Duplicate identity or budget
exhaustion directs cancellation/replanning; invalidated, cancelled, or a
consumed-without-phase-write epoch directs a fresh begin. `cancel` is the
explicit recovery path:

```bash
lattice review_inventory_cancel --storyId=B-xxxx --reason="return to DEV and replace the frozen candidate"
```

## State and authority

The signed epoch has four states:

- `OPEN`: material, scope, review round and required lanes are frozen.
- `FINALIZED`: all required lanes terminated on that cutoff and one complete
  wave added zero new verified finding families.
- `INVALIDATED`: a consumer observed changed material/story-file lineage.
- `CANCELLED`: the operator explicitly abandoned the epoch.

The signed receipt has deliberately narrow authority:

- `authority=inventory-completeness-only`;
- `authorizesTest=false`;
- it authorizes one REVIEW-to-remediation-DEV transition only;
- it is bound to story, round, epoch, cutoff, scope, lane set, finding-set
  digest, coverage digest and wave count;
- cancellation, invalidation, tampering, wrong-story/round replay and a second
  consumption fail closed.

The gate is mandatory for REVIEW→DEV. Absence of the artifact is not a legacy
PASS and instructs the operator to begin an epoch; otherwise hosts could bypass
the optimization and assurance simply by never calling `begin`.

The transition consumes the receipt and rechecks the live material/story-files
cutoff before publishing `phase=DEV`. Consumption failure therefore leaves the
story in REVIEW. If the later atomic story write fails, the already-consumed
receipt cannot be replayed; status directs the operator to begin a new epoch on
the still-authoritative REVIEW state. This is integrity-safe recovery, not a
multi-file transaction claim.

This is not PRE_CERT and it does not claim the repaired material is correct.

## Saturation rule

Each wave consumes existing signed `ReviewRun`, `ReviewPass` and `Finding`
facts. A wave can complete only when:

1. every lane returned by canonical `computeActiveReviewers` has a terminal
   signed pass or finding on the frozen cutoff;
2. every run binds the same review round, material and story-files lineage;
3. both pass and finding terminals carry signed `readManifest` **and**
   `readLog`; all of those lane evidence records plus lane-specific prompt
   identity are folded into the lane coverage digest;
4. duplicate lane identities cannot increase coverage;
5. a separately dispatched `lattice-review-topology-critic` starts a fresh
   ReviewRun only after all required lanes terminate, submits signed terminal
   pass/finding plus read evidence, and signs a critic receipt bound to the exact
   epoch, wave, cutoff, aggregate finding set and lane coverage; and
6. the current complete wave adds zero new verified families.

Finalization rejects a missing, forged, superseded, pre-terminal, stale-cutoff
or old-wave critic receipt. `status` exposes `Completeness critic: pending` or
`complete`; `criticDigest` alone has no authority.

Raw findings do not classify themselves into families. The independent critic
must submit a signed per-finding disposition bound into the critic receipt:
`verified_family` with an explicit family key, `duplicate` with a real canonical
verified finding, or `not_verified` with a reason. Missing, forged, unknown, or
old-wave dispositions fail closed. Only signature-valid findings whose
`evidenceState` is verified and whose critic disposition is
`verified_family` contribute a family; a signed duplicate reuses the canonical
family and `not_verified` contributes none. New verified families append to the
immutable aggregate and require another full unchanged-material wave.
`review_inventory_wave_advance` is the sole checkpoint for a complete
nonzero-new wave. `review_inventory_finalize` rejects that state without
persisting the wave; it is exclusively the zero-new receipt writer.
Exhausting the bounded wave budget yields
`REVIEW_INVENTORY_BUDGET_EXHAUSTED` and requires replan/decompose/escalation; it
never yields PASS.

## Freshness and mutation enforcement

The preventative prewrite projection rejects material targets while an epoch
is OPEN. Prevention is not the authority: `review_run_start`, the shared
`assertCurrentReviewRunForEvidence` path used by `review_pass_set` and reviewer
`finding_add`, finalization, status and transition consumption recompute
lineage. A direct edit or unsupported-hook bypass is therefore detected by the
next authoritative consumer and atomically changes the epoch to `INVALIDATED`.
Story/runtime metadata excluded by the canonical material hash does not
invalidate the epoch.

## Final review after remediation

After the receipt is consumed, remediation changes material and the receipt is
historical. REVIEW-to-TEST never consumes it. The old “round 2+ has any one
receipt” shortcut is removed. A signed post-remediation selection is recomputed
from the current review round, HEAD, material hash, story-files hash, frozen
scope digest, consumed receipt cutoff, changed-file status, impact policy, and
the bidirectional transitive dependency closure of the tracked source inventory.
A proven narrow repair requires exactly its impacted active lanes; forced lanes
remain selected. Missing or changed scope/policy/lineage, rename/delete,
untracked or ignored material, opaque or unresolved dependencies, and an empty
selection all fail closed to the complete active lane set. The selection changes
lane scheduling only: required host and escalation assurance remain unchanged.

`reviewer_list` and REVIEW transition guidance project the same gate-consumed
selection as three deterministic lines: ordered `Final-review lanes:`,
`Selection: dependency-closure (...)` or `Selection: full-set (...)`, and one
exact `Next:` command. A newly discovered dependency, regression, scope
expansion, or current-material change invalidates the prior signature and forces
recomputation; stale passes remain inadmissible. Round number alone is never
impact evidence.

## Deterministic efficiency and quality acceptance

`review-inventory-epoch-smoke.ts` encodes the B-cdf6 counterfactual as operations
and emitted events; counters are derived by filtering that replay, never returned
as expected constants. It must be deterministic across repeated runs:

| Counter | Historical baseline | Frozen epoch |
|---|---:|---:|
| mutation-driven redispatches after the first finding | at least 5 (`RR-047..RR-051`) | 0 |
| discovery epochs | n/a | 1 |
| accepted material commits while OPEN | 1 observed | 0 |
| accepted stale old-cutoff passes | must not be accepted | 0 |
| aggregated remediation transitions | fragmented | 1 |
| clean final-review epochs when remediation has no regression | repeated | at most 1 |

Quality invariants are non-negotiable: required lane count is unchanged;
critical/high escapes, stale acceptance and budget-manufactured PASS counters
must each equal zero. The replay mechanically injects tampering, lane timeout,
cancel, duplicate identity, wave-budget exhaustion, stale lineage, receipt
replay, phase-write failure, and final-review regression. It also demonstrates
that the two-host assurance floor remains `2 -> 2`. If any baseline event is missing or attribution is
ambiguous, the comparison is inconclusive rather than PASS.

## Process-fact contract

`review-inventory-epochs.json` is an L4 signed artifact registered in
`process-fact-registry.ts`. The six epoch commands (including the independent
critic command), artifact signatures, freshness
semantics and REVIEW-to-DEV consumer are checked by
`scripts/verify-process-fact-contract.mjs`. Prompt wording can guide the host,
but only these CLI/handler/gate facts grant authority.

## Wave 4 authority boundary for this Story

This repository configures executable pre-review in `observe` mode. Its signed
artifact remains diagnostic; an inconclusive result must never be described as
PASS or used as lifecycle authority. The mandatory Wave 4 acceptance authority
for B-3f3d is the current signed `acceptance-rollout-report.json`: the registered
producer executes the frozen matched cohort, and the read/check consumers
verify current HEAD/material/story-files bindings plus genuine full-3x2 quorum.
Enforce-mode projects may additionally require a passing pre-review artifact;
that separate configuration does not let this observe-mode Story claim
pre-review authority.
