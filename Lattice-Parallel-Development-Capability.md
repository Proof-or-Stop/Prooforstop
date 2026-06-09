# Lattice Parallel Development Capability Execution Plan

> Capability type: horizontal coordination capability
> Status: Proposal for implementation
> Scope: parallel implementation coordination, not capability proof
> Non-goal: this is not a sixth baseline layer

## Purpose

Lattice Parallel Development defines how Lattice can coordinate multiple
host/agent workstreams at the same time without weakening proof, ownership,
evidence, or claim discipline.

It answers one question:

```text
How can Lattice accelerate development through parallel workstreams while still
requiring sequential proof before any higher capability claim is unlocked?
```

This capability is valuable because developers want speed, but speed cannot
come from skipping gates, merging unproven work, or letting one host certify its
own output. Parallel Development is therefore a coordination layer for
implementation, not a shortcut for validation.

## Core Rule

```text
Implementation may proceed in parallel.
Capability proof and claim unlock must remain sequential.
```

Equivalent short form:

```text
parallel implementation, sequential proof
```

Parallel Development may start workstreams for Engineering, Loop Engineering,
Production Safety, and Capability Claim implementation in parallel. It must not
claim those capabilities in parallel.

The proof order remains:

```text
Development Baseline
  -> Engineering Baseline
  -> Loop Engineering Baseline
  -> Production Safety Baseline
  -> Capability Claim Baseline
```

## Capability Statement

Allowed wording after this capability is implemented and validated:

```text
Lattice can coordinate bounded parallel development workstreams while preserving
shared contracts, ownership boundaries, evidence gates, merge ordering, and
sequential capability proof.
```

Forbidden wording:

```text
Lattice can prove multiple capability layers in parallel.
Lattice can bypass lower-layer baselines when high-layer code exists.
Parallel Development makes unattended development production-ready.
Parallel Development replaces Loop Engineering, Authority, or Capability Claim gates.
```

## Non-Goals

Parallel Development does not:

- Add a sixth baseline layer.
- Create a new capability claim level.
- Replace `parallel_wave_*` read-only planning commands.
- Replace Loop Engineering.
- Replace story owner leases or main write locks.
- Replace REVIEW, TEST, DONE, delivery, receipt, or Authority gates.
- Turn local/shadow evidence into authority evidence.
- Allow high-layer workstreams to return `PASS` before lower layers are proven.

If a future implementation needs to modify runtime schedulers, baseline runners,
claim evaluators, or Authority submission paths, that must be handled by
separate implementation stories.

## Relationship To Existing Concepts

| Concept | Role | Boundary |
|---|---|---|
| Parallel Wave | Read-only scheduling projection. | It plans candidate waves but does not mutate lifecycle or prove authority. |
| Parallel Development | Horizontal implementation coordination. | It starts and supervises workstreams under ownership, evidence, and merge rules. |
| Loop Engineering | Bounded loop inside a workstream. | It decides continue, repair, stop, rollback, block, or handoff. |
| Production Safety | Long-term safety and authority evidence. | It cannot be unlocked by local parallel execution alone. |
| Capability Claim | Claim authorization. | It reads lower-layer evidence and fails closed on missing or stale proof. |

The relationship to Loop Engineering is nested:

```text
Parallel Development
  -> Workstream A
       -> bounded Loop Engineering repair/review loop
  -> Workstream B
       -> bounded Loop Engineering repair/review loop
  -> Workstream C
       -> bounded Loop Engineering repair/review loop
```

Parallel Development decides which workstreams may run at the same time. Loop
Engineering decides what each workstream does when it encounters failure,
uncertainty, review findings, budget exhaustion, or risk.

Rules:

```text
Every parallel workstream may run its own bounded loop.
No loop may edit outside its workstream ownership without coordinator approval.
No workstream may be marked complete until its loop is closed, blocked, or escalated.
Parallel merge is allowed only after participating loops produce fresh evidence.
```

## Parallel Wave Integration

Parallel Development should build on Parallel Wave without changing Parallel
Wave's authority boundary.

Short form:

```text
Parallel Wave plans.
Parallel Development coordinates execution.
Story, review, validation, receipt, and claim gates prove.
```

Parallel Wave remains an L0 read-only planning projection. Its outputs can help
choose workstreams, candidate hosts, dependencies, and merge guidance, but they
must not become lifecycle evidence, receipt evidence, or capability proof.
Parallel Development may consume a frozen Parallel Wave snapshot as an input
contract, then add ownership, execution state, evidence freshness, merge queue
enforcement, and sequential proof discipline around it.

Recommended composition:

```text
parallel_wave_create --output wave.json
  -> optional parallel_wave_inspect / parallel_plan for full-envelope planning
  -> optional parallel_report for human-readable summary only
  -> operator confirms candidate workstreams
  -> coordinator freezes shared contract and workstream partition
  -> parallel_development_run binds the full-envelope Wave artifact plus coordinator freeze metadata
  -> workstreams execute through normal story lifecycle gates
  -> parallel development merge queue consumes real review and validation evidence
  -> sequential proof gate unlocks claims one layer at a time
```

Only full-envelope Wave surfaces may seed the frozen snapshot:
`parallel_wave_create`, `parallel_wave_inspect`, and `parallel_plan`.
Projection-only surfaces such as `parallel_report`, `parallel_status`, and
`parallel_merge_queue` may help an operator read the plan, but they omit parts of
the full envelope and must not be used as the binding artifact for a Parallel
Development run unless paired with the original full-envelope Wave artifact.

Boundary mapping:

| Parallel Wave field | Parallel Development use | Not allowed |
|---|---|---|
| `waveId` | Stable reference to the planning snapshot. | It is not a run id or proof id by itself. |
| `storyRefs` | Candidate workstream sources and lifecycle context. | They do not authorize mutation outside each story's owner lease. |
| `hostCandidates` | Possible `ownerHost` suggestions. | They are not independent host verdicts. |
| `evidenceRefs` | Lineage hints for recovery and verification planning. | They are not fresh gate evidence. |
| `mergeOrder` | Initial merge queue seed. | It is not merge permission. |
| `authority` | Must remain non-authoritative. | It must not set production completion, receipts, or claim unlock. |

Frozen snapshot fields from the full-envelope Wave artifact:

```text
waveId
waveSchemaVersion
storyRefs
hostCandidates
evidenceRefs
mergeOrder
authority
```

Coordinator-added freeze metadata:

```text
waveHash
materialHash
sharedContractVersion
createdFromCommands
frozenAt
```

Rules:

```text
Parallel Development may consume Wave output.
Parallel Development must not mutate Wave output in place.
Wave evidenceRefs are lineage only; fresh proof comes from story/review/validate/receipt gates.
Wave mergeOrder is guidance only; merge queue readiness must re-check ownership, review, evidence, and blockers.
Claim unlock must ignore Wave success wording and read only lower-layer gate evidence.
```

This means Parallel Wave can be the recommended planning entrypoint for a
Parallel Development run, but it does not become the execution engine. A future
implementation should add separate `parallel_development_*` surfaces for frozen
run state, workstream status, merge queue enforcement, and final reporting.

## When To Use Parallel Development

Use it when all are true:

- There are two or more independent workstreams.
- The workstreams have separable file ownership.
- The shared contract can be frozen before implementation.
- Each workstream has clear evidence requirements.
- Merge ordering can be planned before work begins.
- High-layer work can safely run in `shadow`, `audit_only`, or
  `not_authorized` mode until lower-layer proof exists.

Do not use it when any are true:

- The task is small enough that coordination cost exceeds development speedup.
- Multiple agents need to edit the same core schema or gate simultaneously.
- The shared contract is still unsettled.
- A workstream would need to claim `PASS` from evidence it cannot own.
- A human product or architecture decision is unresolved.
- The only benefit is "more agents" rather than a real throughput gain.

## Shared Contract Freeze

Before parallel workstreams start, the coordinator must freeze the minimum
shared contract. This prevents each workstream from inventing incompatible
artifact formats.

Required shared contract:

| Contract item | Required decision |
|---|---|
| `runId` format | Stable unique id for a baseline/workstream run. |
| `baselineId` format | Names such as `ENG-*`, `UDM-*`, `SAFE-*`, `AUTH-*`, `CLAIM-*`. |
| `materialHash` semantics | Which files/artifacts make evidence fresh or stale. |
| `evidenceRef` format | How commands, files, artifacts, receipts, and host verdicts are referenced. |
| `final-report.json` | Per-run expected outcome, actual outcome, and authority/local status. |
| `baseline-suite-report.json` | Aggregated suite outcome, rates, false DONE count, maturity target. |
| `host-verdicts.json` | Independent host identity, material hash binding, verdict, and freshness. |
| `claim-report.json` | Highest authorized claim, blocked reason, missing evidence, stale evidence. |
| `merge-queue.json` | Workstream readiness, dependencies, blockers, and merge order. |

Minimum frozen rule:

```text
No parallel workstream may redefine shared artifact fields locally.
Any shared contract change must become a coordinator change request.
```

## Workstream Partition

Each workstream must declare a bounded write set before implementation.

Example partition for baseline implementation:

| Workstream | Owns | May not own |
|---|---|---|
| Engineering Runner | Engineering baseline runner, ENG fixtures, engineering suite report. | Claim evaluator, Production Safety authority logic. |
| Loop Engine | Loop policy, repair/review loop records, loop budget/stop handling. | Production receipt verification, claim unlock. |
| Production Safety | SAFE/AUTH/PROD traps, receipt verification integration, soak summary. | Lower-layer runner behavior unless a contract change is approved. |
| Claim Evaluator | Claim report, overclaim traps, stale evidence rejection, allowed wording. | Baseline execution or host verdict production. |
| Shared Contract | Schema definitions, material hash rules, report format. | Edited only through coordinator approval. |

Every workstream must declare:

```text
workstreamId
ownerHost
storyId or taskId
ownedPaths
readOnlyPaths
sharedContractVersion
expectedArtifacts
verificationCommands
loopPolicy
mergeDependencies
claimBoundary
```

## Ownership And Lease Rules

Parallel Development must preserve Lattice's existing coordination model:

- One story has one mutating owner session at a time.
- Read-only inspection is always allowed.
- Story-scoped mutating commands require the story owner lease.
- Shared main and B-META writes require the main write lock.
- Active lease takeover requires explicit `--forceTakeover`.
- Stale lease takeover requires explicit `--takeover`.

Parallel Development may coordinate multiple stories or worktrees. It must not
let two sessions mutate the same story metadata, same shared schema file, or
same gate artifact without a coordinator-approved handoff.

Ownership violation outcome:

```text
outcome = BLOCKED
blockedReason = ownership_conflict
requiredAction = wait | takeover | repartition_workstream
```

## Shadow Mode For Higher Layers

Higher-layer workstreams may be implemented early, but their authoritative
output must remain locked until lower layers pass.

Allowed early outputs:

```text
status = audit_only
status = shadow
status = not_authorized
status = blocked
```

Forbidden early outputs:

```text
status = pass
fullAuthorityDone = true
authorizedClaimLevel > provenLowerLayer
receiptVerified = true without verified receipt
productionDone = true without authority receipt
```

Examples:

| Scenario | Required output |
|---|---|
| Claim evaluator runs before Engineering Baseline passes. | `not_authorized`, blocked reason names missing Engineering evidence. |
| Production Safety runner has local success but no receipt. | `audit_only`, `receiptVerified=false`, `productionDone=false`. |
| Loop Engine completes but review loop remains open. | `blocked`, open loop evidence listed. |
| Host verdict exists for old material hash. | `blocked`, stale verdict identified. |

## Sequential Proof Gate

Parallel Development can produce artifacts for multiple layers early. The proof
gate consumes those artifacts in order.

```text
if Development Baseline != PASS:
  lock Engineering, Loop, Production Safety, Claim capability unlock

if Engineering Baseline != PASS:
  lock Loop Engineering, Production Safety, Claim capability unlock

if Loop Engineering Baseline != PASS:
  lock Production Safety and Claim capability unlock

if Production Safety Baseline != PASS:
  lock Production Safety claim and any stronger claim

if any lower-layer evidence is stale:
  lock all dependent claims
```

No high-layer report can compensate for missing lower-layer proof.

## Merge Queue

Parallel workstreams do not merge directly to main. They enter a merge queue.

Each merge queue entry must include:

```text
workstreamId
branch or worktree
ownedPaths
sharedContractVersion
loopState = closed | blocked | escalated
validationState = pass | blocked | audit_only
reviewState = pass | blocked
evidenceFresh = true | false
dependsOn
mergeRisk
rollbackPlan
```

A queue entry is ready only when:

```text
loopState in [closed, blocked, escalated]
reviewState = pass
evidenceFresh = true
ownedPaths do not conflict with earlier ready entries
sharedContractVersion matches coordinator version
no unresolved high/critical finding
```

Merge order should prefer:

1. Shared contract updates.
2. Lowest-layer runner changes.
3. Workstreams with no downstream dependents.
4. Workstreams whose evidence unblocks other entries.
5. Claim evaluator changes last.

Claim evaluator changes may be merged early only if they fail closed against
missing lower-layer evidence.

## Fail-Closed Rules

Parallel Development must fail closed on these conditions:

| Failure mode | Required outcome |
|---|---|
| Missing shared contract | `BLOCKED: missing_shared_contract` |
| Shared contract drift | `BLOCKED: shared_contract_drift` |
| Two workstreams edit same owned path | `BLOCKED: ownership_conflict` |
| Workstream tries to edit shared schema directly | `BLOCKED: coordinator_required` |
| Loop still open | `BLOCKED: open_loop` |
| Evidence stale | `BLOCKED: stale_evidence` |
| Host verdict missing | `BLOCKED: missing_host_verdict` |
| Same host self-certifies | `BLOCKED: insufficient_independent_hosts` |
| Receipt missing for authority claim | `BLOCKED: missing_authority_receipt` |
| Lower layer not proven | `BLOCKED: lower_layer_not_proven` |
| Budget exhausted | `BLOCKED: budget_exhausted` or `ESCALATED` |
| Human-only decision needed | `ESCALATED: human_decision_required` |

The system must never convert any of these into `PASS` through summary text.

## Stop Conditions

Parallel Development should stop adding or continuing workstreams when:

- The shared contract is disputed.
- Two workstreams need the same write set.
- More than one workstream needs to change gate semantics.
- A high-layer workstream cannot run in shadow/audit-only mode.
- A workstream repeatedly expands scope beyond its ownership.
- A loop reaches max iterations, max runtime, or max cost.
- Three consecutive merge queue attempts fail for the same reason.
- Human decision is required to choose architecture, product scope, or risk
  tolerance.

Stop output:

```text
parallel_status = BLOCKED
blockedWorkstreams = [...]
coordinatorDecisionRequired = true
recommendedNextAction = repartition | freeze_contract | human_handoff | reduce_parallelism
```

## Dogfooding Plan

The first useful validation of this capability is to use it to implement the
baseline layers 2-5.

### Phase 0 - Contract Freeze

Produce the minimum shared contract:

- Baseline run artifact schema.
- Suite report schema.
- Material hash and freshness semantics.
- Host verdict schema.
- Claim report schema.
- Merge queue schema.

Expected result:

```text
sharedContractVersion exists
all workstreams reference the same version
no workstream-local schema fork exists
```

### Phase 1 - Parallel Implementation

Start independent workstreams:

| Workstream | Mode before proof | Expected early result |
|---|---|---|
| Engineering Runner | normal implementation | local runner artifacts, no higher claim. |
| Loop Engine | normal implementation | bounded loop artifacts, no production claim. |
| Production Safety | shadow/audit-only | safety traps can run, authority claim locked. |
| Claim Evaluator | fail-closed | claim report blocks on missing lower-layer evidence. |

Expected result:

```text
parallel implementation artifacts exist
no high-layer PASS before lower-layer proof
merge queue orders integration
```

### Phase 2 - Sequential Proof

Evaluate in order:

1. Development Baseline.
2. Engineering Baseline.
3. Loop Engineering Baseline.
4. Production Safety Baseline.
5. Capability Claim Baseline.

Expected result:

```text
proof gates unlock one layer at a time
stale or missing lower-layer evidence blocks dependent claims
```

### Phase 3 - Retrospective

Measure whether parallelism helped without weakening quality:

| Metric | Meaning |
|---|---|
| elapsed_time_saved | Compare sequential estimate with actual parallel duration. |
| merge_conflict_count | Count ownership failures. |
| shared_contract_change_count | Detect contract instability. |
| false_done_count | Must remain 0. |
| stale_evidence_block_count | Should block, not pass. |
| human_handoff_count | Shows where automation correctly stopped. |
| overclaim_block_count | Shows claim evaluator failed closed. |

Parallel Development is useful only if it reduces elapsed time without raising
false DONE, overclaim, stale evidence, or ownership failures.

## Minimum Artifacts

An implementation of this capability should produce:

```text
.omx/artifacts/parallel-development/<run-id>/
  shared-contract.json
  workstreams.json
  ownership-map.json
  loop-state-index.json
  merge-queue.json
  proof-gate-status.json
  claim-lock-status.json
  final-report.json
  final-report.md
```

`final-report.json` must include:

```json
{
  "schemaVersion": "lattice.parallel_development.v1",
  "runId": "...",
  "sharedContractVersion": "...",
  "parallelImplementation": true,
  "sequentialProof": true,
  "workstreamCount": 4,
  "readyMergeCount": 0,
  "blockedMergeCount": 0,
  "falseDoneCount": 0,
  "overclaimBlocked": true,
  "authorizedClaimLevel": "none | development | engineering | loop | production-safety",
  "claimUnlockOrderPreserved": true
}
```

## Readiness Checklist

Before starting a parallel development run:

- Shared contract is frozen.
- Workstreams have disjoint owned paths.
- Shared paths are coordinator-owned.
- Each workstream has a loop policy.
- Each workstream has evidence requirements.
- High-layer workstreams have shadow/audit-only behavior.
- Merge queue order exists.
- Claim evaluator fails closed on missing lower-layer evidence.
- Human handoff triggers are explicit.

Before merging a workstream:

- Its loop is closed, blocked, or escalated.
- Its evidence is fresh for the current material hash.
- Its reviewer pass is bound to the current review round.
- Its owned paths do not conflict with earlier merge entries.
- It did not modify shared contract without approval.
- It did not authorize a claim beyond proven lower layers.

Before claiming capability:

- Lower layers have PASS evidence.
- `false_done_count = 0`.
- No dependent evidence is stale.
- Required host verdicts exist and are independent.
- Required authority receipt is verified where authority wording is used.
- Claim report names the highest authorized claim and any blocked stronger
  claim.

## Anti-Patterns

Do not treat these as Parallel Development success:

- Four agents all editing the same schema file.
- A high-layer runner returning `PASS` because its local test passed.
- A claim evaluator authorizing production wording from local JSON.
- A merge queue that ignores open loops.
- A coordinator that summarizes success without evidence refs.
- A workstream that expands scope because it is blocked.
- A parallel wave projection treated as authority evidence.
- A stale host verdict reused after material changes.

## DONE Criteria For This Capability

Lattice Parallel Development is implemented only when a future implementation
can demonstrate:

```text
shared contract freeze works
workstream ownership blocks conflicting edits
parallel workstreams produce independent artifacts
each workstream loop closes, blocks, or escalates
merge queue blocks unresolved conflicts
high-layer outputs remain shadow/audit-only until lower proof exists
claim evaluator fails closed on missing or stale evidence
sequential proof order is preserved
false_done_count = 0
```

Until then, this document is an execution plan and capability definition, not a
claim that the runtime has already implemented the full capability.
