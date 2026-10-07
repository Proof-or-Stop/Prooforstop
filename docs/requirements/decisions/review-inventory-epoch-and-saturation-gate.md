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
proof-or-stop review_inventory_begin --storyId=B-xxxx
proof-or-stop review_inventory_status --storyId=B-xxxx
# finish the required lanes reported by status before dispatching the critic
proof-or-stop dispatch '{"storyId":"B-xxxx","agentType":"proof-or-stop-review-topology-critic","reviewPurpose":"inventory-completeness","inventoryEpochId":"<epoch>"}'
proof-or-stop review_run_start '{"storyId":"B-xxxx","agent":"proof-or-stop-review-topology-critic","reviewPurpose":"inventory-completeness","inventoryEpochId":"<epoch>"}'
# submit the critic's terminal finding_add or review_pass_set with read evidence
proof-or-stop review_inventory_critic_set '{"storyId":"B-xxxx","epochId":"<epoch>","reviewRunId":"<critic-run>","agent":"proof-or-stop-review-topology-critic","findingDispositions":[{"findingId":"B-xxxx:F-001","disposition":"verified_family","familyKey":"finding:B-xxxx:F-001","reason":"independent critic retained this verified family"}]}'
# use findingDispositions:[] only when the aggregate verified finding set is empty
proof-or-stop review_inventory_wave_advance --storyId=B-xxxx # only when status reports new families
proof-or-stop review_inventory_finalize --storyId=B-xxxx
```

B-29bc separates explicit `inventory-completeness` admission from the default
topology purpose. Use the current epoch returned by the CLI, not a historical ID.
The inventory dispatch, signed run and critic receipt bind the current OPEN
epoch, wave, cutoff, scope, required lanes and run-sequence boundary. This branch
preserves real Git attribution and does not require a role-named Git author;
it still requires independent critic execution and signed terminal/read evidence.
Omitted purpose retains the original topology provenance requirements. Do not
retry a refused topology assignment as inventory, or present inventory evidence
as topology certification, TEST/DONE approval or independent-host assurance.

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
explicit recovery path. It accepts an OPEN epoch and also a FINALIZED receipt
that has not been consumed; in the latter case it signs `invalidatedAt` and
`invalidationReason` into the receipt before allowing a new epoch:

```bash
proof-or-stop review_inventory_cancel --storyId=B-xxxx --reason="return to DEV and replace the frozen candidate"
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

Temporal integrity is enforced at the reviewer-evidence write boundary under
the same inventory lock. A FINALIZED epoch seals its review round permanently,
including the interval after receipt consumption but before phase publication;
DEV also rejects reviewer evidence even if an old signed ReviewRun is supplied.
For genuinely late evidence before consumption, the operator cancels the
FINALIZED epoch, which signed-invalidates the receipt, then begins a fresh epoch
and fresh ReviewRun. No receipt is silently reopened or fabricated.

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
5. a separately dispatched `proof-or-stop-review-topology-critic`, explicitly
   bound to `inventory-completeness`, starts a fresh ReviewRun only after all
   required lanes terminate, submits signed terminal
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
Wall-clock timestamps are audit context, not ordering authority. `begin` signs
`initialRunSequenceBoundary`, and each checkpoint signs
`nextRunSequenceBoundary`, derived from the monotonically allocated numeric
`RR-...` identity. Only a strictly greater sequence is eligible for the new
wave. Thus equal-millisecond runs are conservatively classified by their
linearized durable identity without sleeps, and a truly post-boundary run has
an unambiguous proof. A lane still projects one canonical terminal for coverage,
but its raw finding set is the union of verified findings from every eligible
same-wave run; a newer pass cannot hide an older concurrent run's finding.
Exhausting the bounded wave budget yields
`REVIEW_INVENTORY_BUDGET_EXHAUSTED` and requires replan/decompose/escalation; it
never yields PASS.

At `begin`, the epoch signs `baselineFindingIds`: every open, signature-valid,
verified finding with mechanical read evidence from a current-round/current-
cutoff ReviewRun that predates the epoch. The first wave carries those findings
into the critic disposition set even though their ReviewRuns began before
the signed initial run-sequence boundary. Consumers recompute the eligible baseline and fail closed with
`REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED` on any difference. Consequently
cancel/rebegin cannot erase an unresolved verified finding merely by moving the
epoch boundary.

## Freshness and mutation enforcement

The preventative prewrite projection rejects material targets while an epoch
is OPEN. Prevention is not the authority: `review_run_start`, the shared
`assertCurrentReviewRunForEvidence` path used by `review_pass_set` and reviewer
`finding_add`, finalization, status and transition consumption recompute
lineage. They also recompute the canonical scope digest and active required
lanes. `scope_contract_acknowledge` uses the same inventory mutation lock, so a
scope write cannot interleave between validation and evidence/finalization/
consumption; any scope or lane drift atomically changes the epoch to
`INVALIDATED` with `OPEN_REVIEW_INVENTORY_SCOPE_MUTATION`. A direct edit or
unsupported-hook bypass is therefore detected by the next authoritative consumer.
The scope digest is the complete acceptance subject, not a title/files summary:
it includes checklist context, status, related docs, user-visible claims,
exclusions, file routing, verification intents, verification evidence
*semantics*, and the frozen claim snapshot. Evidence is bound by what a verifier
OBSERVED — `intentRef`, `kind`, `file`, `command`, `result`, `note`,
`mechanical`, and the authenticated V5 observation/input projection
`proof-or-stop.inventory-verification-observation.v1`. Before projecting, the
store-backed consumer validates the complete signed receipt graph, immutable
artifact, publication freshness tuple, and command against its intent pin.
Malformed or tampered data is refused, not normalized into a valid subject.
The whitelist retains execution-input identity, full-output digest, exit/timeout
outcomes, and assertion intent/selector/matcher/result. It omits signatures,
run IDs, artifact instance IDs, execution timestamps/duration, publication
coordinates and reuse lineage—not merely the outer receipt timestamp. Thus
genuine same-observation, same-input re-execution or authorized reuse preserves
the acceptance subject. Changed output or execution inputs still invalidate it.
This projection does not supply lifecycle authority: authentic V4 remains
historical audit-only and requires real V5 renewal. Independent epoch material
and scope cutoffs remain enforced even when a receipt projection is unchanged.
This mirrors the same semantic-content-not-bookkeeping rule already applied to
the ProofStory contract below. Every checklist writer (including `verification_intent_repair` and
verification-evidence writers) takes the inventory lock before its checklist
lock. A supported REVIEW mutation is therefore serialized, and the next status,
evidence, critic, wave, finalize, or consume boundary persists
`OPEN_REVIEW_INVENTORY_SCOPE_MUTATION` before accepting old reviewer evidence.

The same semantic-content-not-bookkeeping rule applies to the candidate set. The
epoch signs `candidateSpecSetDigest` as a routing-universe projection of the
current valid `CandidateSpecSetArtifact` — `schemaVersion`, `mode`, each selected
candidate reduced to its `path` and content hash, and
`scanEscalationReason` — and `corpusDigest`, deliberately NOT the artifact's own
`artifactDigest` (which bakes in `headHash`/`materialHash` verbatim as the
artifact's tamper-detection identity; `verifyCandidateSpecSet` still verifies that
full identity digest, so genuine tampering with the candidate set is still caught)
and deliberately NOT `queryFiltering`, `storyInputDigest`, or any candidate's
`score`/`reasons`, all of which are seeded by the changed-file set from `git diff`
and therefore leak freshness rather than routing-universe identity. A re-run that
changes which specs are selected, any selected spec's content, `schemaVersion`,
`mode`, or `scanEscalationReason` invalidates the epoch with
`OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION`, and lanes from pre-reroute and
post-reroute candidate sets can never form one wave.

**B-8af0 closure of BUG-F107-INCOMPLETE:** the candidate projection is now sorted
by `path` then `contentHash` before its barrier digest is computed. A routing
re-run may reorder an otherwise identical candidate list after unrelated
`changedPaths` freshness changes, but cannot invalidate an OPEN epoch for that
ordering alone. `changedPaths` remains ranking input but is not promoted into an
exact-path protected candidate without an explicit understanding touchpoint. A
changed selected path, selected content hash, corpus digest, schema/mode, or
escalation policy still yields
`OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION`. The full persisted artifact
continues to require its original `artifactDigest` validation; a malformed or
tampered persisted candidate artifact is fail-closed as
`OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT`, never silently treated as
absent or allowed to throw a raw `TypeError` at the inventory gate.

`candidate_spec_route` performs its durable replacement inside
the inventory lock, so a supported REVIEW re-route is serialized against epoch
reads rather than racing them.

**Lab reroute-mid-inventory (2026-10-07):** a REVIEW re-route is supported only
when it can change something. `candidate_spec_route` refuses
`[candidate_route_current_in_review]` (nothing written, one `Next: proof-or-stop
next`) while the stored route is launch-ready (`candidateRouteLaunchReady`) and
the current round already has a ReviewRun: at the material the lanes already
reviewed, a reroute gave them nothing new but invalidated the OPEN epoch and the managed passes and ended, after
all lanes reran, in a verdict with no runnable next step. A stale or missing
route is still re-routed (by `review_round_prepare`), and then this
invalidation applies as described above.

`review_run_start` holds the inventory lock from its run-start snapshot and
cutoff/subject precheck through monotonic RR allocation, Prompt Envelope write,
and durable ReviewRun publication, nesting the metadata transaction in one
fixed lock order. A wave/cancel/begin boundary therefore linearizes wholly
before or after the run; it cannot checkpoint between precheck and publication.

Each new review-run Prompt Envelope signs an immutable as-of-run projection of
finding identity, creation time, status, severity, category, and description.
Historical eligibility recomputation consumes that signed projection. Later
resolve/dismiss/cluster metadata cannot rewrite or invalidate a run that was
valid when it started.
Story/runtime metadata excluded by the canonical material hash does not
invalidate the epoch.

The inventory and reviewer-pass read-modify-write sections use the shared
mkdir lock's ownership token and same-host process-incarnation liveness check.
A live holder is never reclaimed merely because it exceeds the historical
10-second stale age. PID reuse is distinguished by the persisted process start
time; UUID ownership still protects release from deleting a successor. If the
host or process-start probe is unavailable, classification is explicitly
unknown and retains the bounded mtime fallback rather than claiming liveness.

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
selection all fail closed to the complete active lane set. The v2 selection policy
includes unresolved bare runtime or bundler aliases: only known Node builtins may
be ignored without a resolved target. Prior v1 selections must be recomputed. The selection changes
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

Finalization also seals reviewer terminal evidence at the write boundary:
`review_inventory_finalize`, reviewer `finding_add` / `review_pass_set`, and
receipt consumption serialize on the same story lock. Once a valid FINALIZED
receipt is pending, late reviewer evidence is rejected. Consumption additionally
replays the current signed runs, terminals, finding dispositions, critic binding,
family digest, and coverage digest; an out-of-band or crash-era late append fails
with `REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED` and cannot publish DEV.

The frozen acceptance subject includes the scope contract, complete checklist
semantics, the semantic ProofStory contract, binding dispositions, and the
scope-shrinkage decision. Every acceptance writer—including
`scope_shrinkage_decision_set` and its `declare_unreachable` caller—uses the same
inventory lock as finalize/consume. Both OPEN boundaries and FINALIZED receipt
consumption recompute the subject; finalize-vs-shrink serializes, while a
post-finalize shrink makes the old receipt unusable and requires a fresh epoch.

`review_pass_set` is replay-safe at its terminal boundary. Under the shared
inventory/pass lock, story + review round + lane + ReviewRun identify the
terminal and canonical note/read evidence identifies its semantics. An exact
retry returns the existing RP id without another pass or process event; a retry
with conflicting semantics fails closed.

## Wave 4 authority boundary for this Story

This repository configures executable pre-review in `observe` mode. Its signed
artifact remains diagnostic; an inconclusive result must never be described as
PASS or used as lifecycle authority. The mandatory Wave 4 acceptance authority
for B-3f3d is the current signed `acceptance-rollout-report.json`: the registered
producer executes the frozen matched cohort, and the read/check consumers
verify current HEAD/material/story-files bindings plus genuine full-3x2 quorum.
The repository sets `proofStory.acceptanceRolloutGateMode=enforce`, so DEV→REVIEW
mechanically rejects a missing, stale, tampered, non-promotable, or degraded
report; this authority is not supplied by this prose.
Enforce-mode projects may additionally require a passing pre-review artifact;
that separate configuration does not let this observe-mode Story claim
pre-review authority.
