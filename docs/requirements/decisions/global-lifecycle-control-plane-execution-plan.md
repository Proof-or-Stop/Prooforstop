# Global Lifecycle Control Plane Execution Plan

> Status: implemented/partial/future capability audit frozen for B-cd3a.
> Date: 2026-06-25.
> Scope: top-level Proofbound lifecycle management across runtime closure,
> evidence consumption closure, and queue governance.
> Related baselines:
> `docs/evidence/evidence-platform-architecture.md` and
> `docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md`.

## 1. Purpose

> Canonical-vs-Compatibility:
> - Canonical rows are new: `runtime`, `consumption`, `readiness`, `queueSummary` (project),
>   `runtime`/`consumption`/`readiness`/`queue` (story), and explicit `nextSafeAction` where available.
> - Compatibility rows are retained: `lanes`, old `cp2Projection`, and story/project legacy lane names.
> - Compatibility rows are render-only projections and must never replace authoritative lifecycle gate outcomes.

This document defines the global control plane for individual story gates and
active-story operations. It does not replace the story state machine, the
Evidence Runtime, or the Proof Admissibility contract. It coordinates alongside
them so any host can answer:

1. Is this story actually controlled by main or by a worktree?
2. Are runtime locks, freshness, validation, review, and DONE readiness aligned?
3. Is the evidence allowed to satisfy the claim that the gate is consuming?
4. Is the active story queue healthy, or are duplicate / stale / experiment
   stories confusing operators?

The global control plane is therefore a management layer:

```text
Story lifecycle state machine
  INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE

Evidence Platform
  artifact object/ref store + candidate artifacts + observed events

Proof Admissibility
  scope + producer boundary + temporal binding + consumer/claim policy

Global Control Plane
  runtime waterline + consumption waterline + queue governance waterline
```

### Layer Ownership And Data Flow

The three evidence/control documents form a layered system, not three competing
implementations:

```text
Evidence Platform
  artifact objects / refs / shared definitions
        |
        v
Proof Admissibility
  verifier result / claim decision / consumer waterline
        |
        v
Global Control Plane
  consumption lane projection

Story / Git / Worktree / Locks
        |
        v
Global Control Plane
  runtime closure projection

Story index / queue metadata / exception registry
        |
        v
Global Control Plane
  queue governance projection
```

Ownership table:

| Data / decision | Source of truth | Control-plane role |
|---|---|---|
| Artifact object/ref | Evidence Platform | Read through public evidence APIs only |
| Artifact kind/schema/registry | Evidence Platform shared definition registry | Display definition identity only |
| Signature/digest/subject verification | Artifact-specific verifier adapter | Display verifier result only |
| Scope/claim/consumer decision | Proof Admissibility | Display admissibility decision only |
| Admissibility evaluation ledger | Proof Admissibility | Consume rows; do not write rows |
| Consumer waterline | Proof Admissibility projection | Map to consumption lane `GREEN/YELLOW/RED` |
| Story phase/worktree authority | Story lifecycle runtime | Display authority and mirror drift |
| Lock/process state | Lock runtime / OS process inspection through shipped modules | Display runtime closure status |
| Queue exception | Queue Governance exception registry | Own and audit exception membership |
| Global lane status | Derived Control Plane projection | Aggregate and present |
| `productionDone` eligibility | Matching external production gate decision | Display only; never mint in control plane |

Dependency rule:

- `lifecycle-control/consumption` may depend on the public Evidence Runtime /
  Proof Admissibility API.
- It must not directly read `.lattice/evidence`, call concrete receipt
  verifiers, recalculate scope/claim/consumer policy, or write
  `AdmissibilityEvaluationRow`.
- `lifecycle-control/runtime` may depend on lifecycle, git/worktree, lock, and
  readiness APIs, but not on proof-admissibility internals.
- `lifecycle-control/queue` owns queue exception and duplicate classification
  only; it cannot grant lifecycle readiness or proof admissibility.

### Compatibility With Existing Lifecycle State

The global control plane is not a second lifecycle state machine. It must not
define new phases, reinterpret phase order, or bypass existing lifecycle gates.
It is a derived control surface that reads canonical lifecycle facts and renders
them as management waterlines.

Source-of-truth order:

| Concern | Canonical source | Control-plane role |
|---|---|---|
| Phase names, phase order, rollback edges | `story-lifecycle.md` and `lifecycle-registry.ts` | Read and display only |
| Main-vs-worktree authority | `story_authority_resolve` / session-brief authority rendering | Report authority and mirror drift; do not pick a different phase |
| Per-story REVIEW/TEST/DONE readiness | `lifecycle_check` / `StoryReadinessReport` | Aggregate readiness rows; do not recompute gate truth |
| TEST-to-DONE preparation | `done_prepare` and its binding semantics | Surface stale/missing/current status; do not run it implicitly |
| DONE gate satisfaction | `done-oracle.ts` and signed lifecycle artifacts | Report blocker rows; do not replace the oracle |
| Artifact class vs proof sufficiency | `lifecycle-artifact-scope.md` plus Proof Admissibility | Keep "what kind of artifact is this" separate from "can this gate consume it" |
| Queue duplicate/experiment handling | Queue governance policy in this document | Classify backlog pressure; never mutate phase or evidence status by itself |

If the control-plane row and the lifecycle state appear to disagree, the
lifecycle source wins. The control plane must render the disagreement as a
derived diagnostic, for example: `authority=worktree`, `phase=REVIEW`,
`mirrorPhase=INIT_CHECK`, `runtimeStatus=YELLOW`. It must not write the mirror
phase forward, advance the story, mark readiness green, or hide blockers.

The Tier-C experiment exception is also only a queue-governance rule. It may
collapse or separate experiment stories in dashboards, but it must not waive
`lifecycle_check`, proof-admissibility, DONE readiness, evidence freshness, or
review requirements for any story that enters the normal lifecycle.

### Capability Detection

The control plane must discover which lower-layer features are actually present
before rendering a row as `GREEN`. Missing capabilities are rendered as
`unknown` / `unavailable`, not assumed.

```ts
interface ControlPlaneCapabilities {
  evidenceRuntimeAvailable: boolean;
  admissibilityClassifierAvailable: boolean;
  verifierAdaptersAvailable: boolean;
  evaluationLedgerAvailable: boolean;
  admissibilityWaterlineAvailable: boolean;
  enforcementMode: "unavailable" | "warn" | "enforce";
}
```

### Frozen Capability Audit

B-cd3a freezes the control-plane capability vocabulary to four machine status
words: `implemented`, `partial`, `unavailable`, and `future`. Human audit prose
may say "missing" for a capability that has no runtime implementation; the
machine-readable projection renders that state as `unavailable`. Compatibility booleans
such as `proofM7Enforcement`, `queueCleanupEnforcement`, and `tierCCleanup`
remain `false` unless that capability can itself grant the named production
behavior. The richer status rows explain partial rollout without changing those
safety booleans.

| Capability | Status | Source / evidence | What it does not claim |
|---|---|---|---|
| Read-only global status projection | implemented | `global_control_status`, `runtime_closure_status`, `admissibility_waterline`, and `queue_governance_status` are registered read-only commands in `command-policy.ts` and handlers reject write-like flags before reading facts. | Does not mutate story state, evidence, queue exceptions, receipts, or authority. |
| Runtime closure projection | implemented | `packages/main/src/core/lifecycle-control/runtime/index.ts` projects local assurance, lifecycle readiness rows, owner lease, main-write lock, and validation lock state. | Does not define a second lifecycle state machine or proof policy. |
| Runtime closure enforcement rollout | partial | `story_advance` evaluates runtime authority, dirty state, and lock state through `evaluateRuntimeEnforcement`; config is `lifecycleControl.runtimeEnforcement=warn|enforce|unavailable`. | Default warn mode is not a hard lifecycle gate. Rollback is `lifecycleControl.runtimeEnforcement=warn`. |
| Proof Admissibility waterline | partial | `admissibility_waterline` consumes public Proof Admissibility diagnostics and renders consumer rows with `diagnosticOnly=true` and `productionDoneEligible=false`. | Does not satisfy DONE, DONE_REQUIRED, Authority, or production claims. |
| Proof M7 enforcement | partial | Proof-facing diagnostics and some warn/enforce modes exist in Proof Admissibility. The control-plane capability row reports this as partial while the compatibility boolean `proofM7Enforcement=false`. | The control plane does not implement Proof M7 hard blocking. |
| Queue classification | implemented | `queue_governance_status` classifies active worktree, stale worktree, main init, experiment exception, duplicate candidate, superseded, and cleanup-required rows. | Classification alone never discards a story or grants readiness. |
| Queue exception registry | implemented | `queue_exception_set` writes preserve-only experiment exceptions under the main-write lock with actor, reason, timestamp, hash binding, and audit event. | Exceptions affect duplicate-cleanup pressure only. |
| Queue cleanup enforcement | implemented | Duplicate/superseded/cleanup-required risk is projected and exception writes are guarded; cleanup mutations remain outside this dashboard. Compatibility boolean `queueCleanupEnforcement=false`. | Does not perform, authorize, or hide cleanup by itself; it keeps cleanup pressure visible for operator action. |
| Tier-C cleanup | unavailable | Tier-C provider-execution receipt verification runs are preserved and grouped as experiment evidence; malformed Tier-C-like rows stay cleanup-required. Compatibility boolean `tierCCleanup=false`. | Automated Tier-C cleanup is retired as a non-goal; preservation and malformed-row visibility are the implemented policy. |
| External production done | unavailable | No external production adapter is part of the control plane. | Local CLI evidence cannot mint `productionDone`. |

## 2. Why This Is Needed

Evidence Platform and Proof Admissibility define, and partially implement, the
required evidence and admissibility boundaries:

- shared `.lattice/evidence` object/ref storage;
- candidate-only Repro/Spike evidence;
- `story-evidence-binding` as an intake bridge, not DONE proof;
- local/shadow/diagnostic evidence cannot claim `productionDone`;
- `authority-receipt` is evidence, not local production completion;
- proof surfaces have canonical scope, producer boundary, claim, and consumer
  vocabulary.

Current capability split:

| Capability | Status | Owner |
|---|---|---|
| Candidate artifact storage | implemented MVP | Evidence Platform |
| Proof-admissibility classification | implemented MVP | Proof Admissibility |
| Verifier adapter coverage | partial / capability-detected | Proof Admissibility |
| Evaluation ledger | specified; not assumed globally available | Proof Admissibility |
| Admissibility waterline | specified; not assumed globally available | Proof Admissibility |
| Proof hard-fail enforcement | warn/enforce diagnostics exist for some paths; global enforcement not assumed | Proof Admissibility |
| Global runtime/queue dashboard | proposed here | Global Control Plane |

The remaining failures are not one missing helper. They are cross-layer
coordination failures:

| Remaining failure | Layer | Example symptom |
|---|---|---|
| Worktree authority and main mirror disagree | Runtime closure | `story_authority_resolve` says worktree DEV/REVIEW while main mirror says INIT_CHECK |
| Validation locks survive or re-enter | Runtime closure | `lattice validate --story` sees its own pid as already running |
| Evidence is valid but stale after metadata/main drift | Runtime closure + consumption closure | PASS validation exists, but later commits make materialHash stale |
| Candidate evidence is mistaken for lifecycle completion | Consumption closure | Repro red evidence is treated as current green evidence |
| Gate output shows warnings but no operator waterline | Consumption closure | Humans cannot see which clause or consumer is weak |
| Active queue contains many similar stories | Queue governance | Ordinary duplicates hide real work; experiment batches are misread as cleanup targets |

The global control plane makes these states visible and actionable.

## 3. Three Control Lanes

### Lane A - Runtime Closure

Runtime closure answers: "Can this story safely move through the lifecycle now?"

It covers authority, worktree health, phase mirror, locks, freshness, validation,
review state, branch sync, and dirty tree state.

Runtime closure is a projector over shipped runtime modules. It must not create
new lock paths, freshness classifiers, phase rules, or lease semantics. If an
existing module has a classifier, the control plane reads that classifier and
renders it; it does not reimplement the decision.

| Runtime check | Source of truth | Status values | Green condition |
|---|---|---|---|
| Authority location | `story_authority_resolve` and session-brief authority rendering | `main`, `worktree`, `unknown` | authoritative cwd is explicit |
| Phase coherence | authoritative story metadata + mirror metadata + `lifecycle-registry.ts` | `coherent`, `mirror-drift`, `unknown` | mirror drift is absent, or reported as advisory with authoritative cwd |
| Worktree health | git worktree state + `StoryReadinessReport` state-intake rows | `clean`, `dirty-material`, `dirty-metadata`, `missing`, `stale` | required worktree exists and phase-sensitive dirty state is acceptable |
| Owner lease | `core/story-owner-lease.ts` | module-defined result, rendered as `owned`, `foreign-active`, `stale`, `missing` | current host owns or intentionally takes over through shipped lease audit |
| Main write lock | `core/main-write-lock.ts` and canonical `.lattice/locks/main-write.lock/` | module-defined result, rendered as `free`, `active`, `stale` | main-affecting operations acquire the shipped lock |
| Validation lock | `core/validation-execution-lock.ts` | module-defined result, rendered as `free`, `active`, `stale`, `self-reentry` | no active/stale/self lock blocks validation according to the shipped lock |
| Dependency readiness | `StoryReadinessReport` state intake and package/runtime preflight rows | `ready`, `missing-deps`, `unknown` | required worktree dependencies exist before command execution |
| Evidence freshness | `core/evidence-freshness.ts`, `core/evidence-stale-hint.ts`, and `done_prepare` bindings | existing classifier result only | host never self-classifies freshness; current classifier says usable |
| Main sync | `done_prepare`, DONE oracle, and git merge-base facts | `synced`, `behind`, `diverged`, `no-merge-base` | story branch contains main before DONE |
| Validation result | `StoryReadinessReport` and validation evidence readers | `pass`, `fail`, `missing`, `stale` | PASS over current material for TEST/DONE |
| Review state | `StoryReadinessReport`, review runs, review passes, findings | `passed`, `pending`, `stale`, `blocked` | required reviewers pass over current material |

Freshness rule:

Proof Admissibility owns whether a given artifact is current, stale,
historical-valid, or relation-valid for a claim. Runtime closure only consumes
that result and turns it into a safe action.

```ts
interface EvidenceBindingAssessment {
  status:
    | "current"
    | "stale"
    | "historical-valid"
    | "relation-valid"
    | "not-applicable";
  driftDimensions: Array<
    "head" | "material" | "story-files" | "policy" | "consumer"
  >;
  safeAction:
    | "none"
    | "refresh-metadata"
    | "rerun-verifier"
    | "regenerate-evidence";
}
```

Runtime lane output:

```json
{
  "lane": "runtime",
  "storyId": "B-xxxx",
  "status": "green | yellow | red",
  "authority": "main | worktree | unknown",
  "authoritativeCwd": "...",
  "phase": "...",
  "mirrorPhase": "...",
  "blockingItems": [
    {
      "check": "validationLock",
      "reason": "self-reentry",
      "remediation": "wait for active pid or clear stale lock after pid check"
    }
  ]
}
```

### Lane B - Consumption Closure

Consumption closure answers: "Can this artifact satisfy this gate claim?"

It is built on Proof Admissibility. It does not duplicate the verifier. It
projects the current consumer waterline from verifier/admissibility results.

| Consumer | Required evidence class | Must not consume |
|---|---|---|
| STORY_INTAKE | accepted repro/spike candidate + binding | current green completion proof |
| PLAN | story-evidence-binding, planning review | DONE-required proof |
| REVIEW | current implementation evidence, red-green relation evaluation when required | raw red probe alone |
| TEST | current validation evidence | historical-baseline evidence alone |
| DONE | fresh TEST evidence, delivery check, summary, review escalation, done-required evidence when configured | candidate-only, local diagnostic, stale legacy |
| DONE_REQUIRED | `local-gate-evidence` with current hash tuple and command policy | local diagnostic or old receipt |
| HANDOFF | context / candidate / diagnostic / admissible proof refs separated | worker output as `productionDone` |
| AUTHORITY_GATE_DECISION | verified external adapter decision | local/shadow accepted transport |

Consumption lane output:

```json
{
  "lane": "consumption",
  "storyId": "B-xxxx",
  "status": "green | yellow | red",
  "consumerWaterline": [
    {
      "consumer": "DONE_REQUIRED",
      "requiredClauses": ["C1", "C3", "C5", "C7", "C8", "C10", "C11"],
      "matchedClauses": ["C1", "C3", "C5", "C7", "C8", "C10", "C11"],
      "missingClauses": [],
      "staleRows": 0,
      "failRows": 0,
      "status": "green"
    }
  ]
}
```

Green condition:

- the verifier result is current;
- the artifact scope allows the intended claim;
- the consumer matches;
- the temporal role is valid for the claim;
- legacy/candidate/diagnostic evidence is not promoted;
- `productionDoneEligible` remains false in the local CLI core unless an
  external production adapter proves its own policy.

### Lane C - Queue Governance

Queue governance answers: "Is the active story list actionable?"

It does not delete stories blindly. It classifies active stories into normal
work, active worktrees, stale worktrees, experiment batches, duplicates, and
superseded items.

| Queue class | Meaning | Action |
|---|---|---|
| `active-worktree` | Real story has an authoritative worktree | Continue lifecycle from authoritative cwd |
| `main-init` | Story is waiting in INIT/INIT_CHECK | Start only if still needed |
| `stale-worktree` | Worktree story has not advanced for threshold time | Run runtime closure diagnostics |
| `experiment-batch-exception` | Many similar stories are intentional experiment evidence | Preserve; group under batch id; exclude from duplicate cleanup |
| `duplicate-candidate` | Similar non-experiment stories compete for same outcome | Pick canonical, mark others superseded/discarded through story flow |
| `superseded` | A later story/doc/commit completed the intent | Machine-readable supersession metadata |
| `cleanup-required` | Invalid or accidental duplicate | Discard only after human-readable reason and audit |

#### Tier-C Experiment Exception

The current Tier-C provider-execution receipt verification stories are not a
normal duplicate-cleanup target. They are experiment data / proof runs.

Exception pattern:

- title starts with `Tier-C provider-execution receipt verification`;
- title may include `(claude)` and a run id;
- story is in `INIT` or another non-terminal phase because the batch represents
  separate provider-execution trials;
- the experiment owner wants to preserve individual run identity.

Policy:

1. Do not bulk discard Tier-C experiment stories as duplicates.
2. Stamp or migrate a durable `experimentBatchId`, for example
   `tier-c-provider-execution-receipt-verification`. Title-prefix inference is
   allowed only for one-time discovery/migration; runtime classification must
   use the durable field or exception registry entry.
3. Hide or collapse them in default dashboards unless the operator asks for
   experiment details.
4. Count them separately from ordinary backlog health.
5. If a Tier-C story is later promoted into product work, it must leave the
   exception class and obey normal duplicate/supersession checks.
6. The experiment exception blocks only `duplicate-candidate` cleanup. It never
   hides malformed records, impossible lifecycle state, stale worktree blockers,
   or `cleanup-required` findings. Cleanup of an experiment story still requires
   an explicit human-readable reason and evidence-preserving audit trail.
7. B-cd3a treats the exact Tier-C title prefix as a migration-source experiment
   exception in the read-only queue projector so existing provider-execution
   receipt runs are grouped immediately. The row source remains
   `migration-title-prefix`; durable registry or story metadata may replace it
   later. This migration source still does not waive lifecycle readiness.

Non-experiment duplicates still require cleanup. A story is a duplicate cleanup
candidate when:

- it has no experiment exception;
- normalized title/name strongly overlaps another active story;
- target code/docs/outcome overlap;
- neither story carries unique evidence/run identity;
- one story has newer/canonical plan or completed implementation.

## 4. Story And Project Control Status

The control plane has two status levels. They must not be collapsed into one
gate.

### StoryControlStatus

`StoryControlStatus` answers whether one story can safely proceed.

```ts
interface StoryControlStatus {
  storyId: string;
  runtimeClosure: "GREEN" | "YELLOW" | "RED" | "N/A";
  consumptionClosure: "GREEN" | "YELLOW" | "RED" | "N/A";
  queueClassification:
    | "GREEN"
    | "EXEMPT"
    | "duplicate-candidate"
    | "superseded"
    | "cleanup-required";
  readyForNextSafeAction: boolean;
}
```

Story readiness rule:

```text
storyReady =
  runtimeClosure == GREEN
  AND consumptionClosure == GREEN
  AND queueClassification in [GREEN, EXEMPT]
```

If the current story is `duplicate-candidate`, `superseded`, or
`cleanup-required`, the story-level status can block that story. An unrelated
duplicate elsewhere in the project must not block this story's lifecycle gate.

### ProjectControlStatus

`ProjectControlStatus` answers whether the overall project queue is healthy.

```ts
interface ProjectControlStatus {
  runtimeAggregate: "GREEN" | "YELLOW" | "RED";
  consumptionAggregate: "GREEN" | "YELLOW" | "RED";
  queueAggregate: "GREEN" | "YELLOW" | "RED";
  staleWorktreeCount: number;
  duplicateClusterCount: number;
  experimentBatchCount: number;
}
```

Project health can warn or block project-wide cleanup/release operations, but it
does not automatically block an unrelated story's local REVIEW/TEST/DONE gate.

## 5. Top-Level Management State

The control plane should render one row per active story plus aggregate lane
status. The goal is a simple "big check" view without hiding details.

Legend:

- `GREEN`: no blocking item for that lane.
- `YELLOW`: advisory or stale-but-recoverable state.
- `RED`: blocks advancement or risks false proof.
- `EXEMPT`: intentionally excluded from duplicate cleanup or default backlog
  pressure. `EXEMPT` is valid for queue-governance rows only; runtime and
  consumption lanes must report `GREEN`, `YELLOW`, `RED`, or `N/A`.

The plan must not freeze a dated snapshot as truth. CP-0 owns the live report.
This document only defines the report shape and roll-up rules.

| Story / group | Runtime closure | Consumption closure | Queue governance | Why |
|---|---|---|---|---|
| `<storyId>` | `GREEN/YELLOW/RED/N/A` | `GREEN/YELLOW/RED/N/A` | `GREEN/YELLOW/RED/EXEMPT` | Derived reason from source rows |
| `<experimentBatchId>` | `N/A` | `N/A` | `EXEMPT` | Intentional experiment/proof-run evidence; preserve and group, do not duplicate-clean |
| `<duplicateClusterId>` | `unknown until inspected` | `unknown until inspected` | `RED` | Non-experiment duplicates require canonical/superseded cleanup suggestion |

Roll-up rules:

| Rule | Result |
|---|---|
| Any non-exempt row is `RED` | Lane is `RED` |
| No `RED`, at least one `YELLOW` | Lane is `YELLOW` |
| All applicable rows are `GREEN` | Lane is `GREEN` |
| Only queue rows are `EXEMPT` and no non-exempt blockers exist | Queue lane may be `GREEN` with an `EXEMPT` count |
| Runtime or consumption status is unavailable for an active story | Lane is at least `YELLOW`, never `GREEN` |

The generated report should show:

```text
Global control plane
  Runtime closure:     GREEN|YELLOW|RED
  Consumption closure: GREEN|YELLOW|RED
  Queue governance:    GREEN|YELLOW|RED
  Exempt experiments:  <count>
  Overall:             GREEN|YELLOW|RED
```

The "big check" is allowed only when all three lanes are GREEN or explicitly
EXEMPT where the policy says an exception is acceptable.

## 6. Execution Milestones

### CP-0 - Read-Only Control Plane Inventory

Goal: produce one read-only report that joins current lifecycle, authority,
proof, and queue state.

Inputs:

- `story_authority_resolve`
- `session_brief`
- `story_get`
- `lifecycle_check` / `StoryReadinessReport`
- latest `done_prepare` report where present
- proof-admissibility diagnostics where available
- active story titles and metadata

Outputs:

- `globalControlPlane.status`
- lane status per story
- experiment exception grouping
- duplicate candidates excluding experiment exceptions

Tests:

- B-1731 reports authoritative worktree and mirror drift.
- a fixture story with stale/missing readiness rows is reported from
  `StoryReadinessReport`, not from plan-doc heuristics.
- Tier-C batch is grouped as `experiment-batch-exception`, not duplicate cleanup.

Exit criteria:

- no mutation;
- no story is discarded;
- report names exact authoritative cwd for worktree stories.

### CP-1 - Runtime Closure Automation

Goal: make runtime readiness mechanically diagnosable before any host advances a
story.

Implementation tasks:

1. Add a runtime closure projector over shipped runtime modules only:
   - `story_authority_resolve`;
   - `core/story-owner-lease.ts`;
   - `core/main-write-lock.ts`;
   - `core/validation-execution-lock.ts`;
   - `core/evidence-freshness.ts`;
   - `core/evidence-stale-hint.ts`;
   - `lifecycle_check` / `StoryReadinessReport`;
   - `done_prepare` bindings.
2. Render validation-lock, owner-lease, main-write-lock, freshness, and
   readiness results from those modules. Do not invent new lock paths or
   classify freshness in host code.
3. Surface phase mirror drift with authoritative cwd.
4. Add safe remediation hints:
   - wait for active pid;
   - clear stale lock only after pid absence check;
   - use the existing freshness hint when deciding refresh versus rerun;
   - run dependency/bootstrap remediation when readiness reports missing deps.
5. Ensure every host sees the same runtime closure summary in session handoff.

Definition of done:

- B-1731 style mirror/worktree divergence is visible before any host makes a
  wrong conclusion.
- validate-lock/self-reentry does not look like a different host conflict.
- stale evidence rendering matches the shipped freshness classifier.

### CP-2 - Consumption Closure Projection

Goal: map Proof Admissibility's existing diagnostics / waterline into the
control-plane consumption lane.

Implementation tasks:

1. Consume `lattice admissibility_waterline` if implemented by the Proof
   Admissibility plan, or implement that plan's Appendix D verbatim. Do not
   define a competing waterline schema.
2. Call `ProofAdmissibilityService` /
   `AdmissibilityWaterlineProjector` through public APIs.
3. Preserve lower-layer identity fields in the projection:
   - `evaluationId`;
   - `policyId`;
   - `consumer`;
   - artifact/source refs;
   - verifier result summary.
4. Render by consumer:
   - STORY_INTAKE
   - PLAN
   - REVIEW
   - TEST
   - DONE
   - DONE_REQUIRED
   - HANDOFF
   - AUTHORITY_GATE_DECISION
5. Keep ledger/waterline diagnostic-only in the control plane:
   - verifier result remains source of truth;
   - waterline cannot promote a scope;
   - error rows cannot satisfy proof.
6. Do not recalculate:
   - contract clauses;
   - scope;
   - freshness;
   - proof eligibility;
   - consumer/claim policy.

Definition of done:

- a host can see which consumer is weak and why;
- `candidate` / `diagnostic` / `legacy` evidence cannot satisfy DONE;
- `authority-receipt` still cannot become local `productionDone`;
- current-state stale rows do not block unrelated stories.

### CP-3 - Queue Governance And Exceptions

Goal: keep active queue useful without destroying experiment evidence.

Implementation tasks:

1. Add active story classifier:
   - active worktree
   - stale worktree
   - main-init
   - experiment-batch-exception
   - duplicate-candidate
   - superseded
   - cleanup-required
2. Add an experiment exception registry with durable membership:
   - `experimentBatchId`;
   - actor / host id;
   - reason;
   - createdAt;
   - story hash tuple or equivalent story identity;
   - source rule used for initial migration, if any.
3. Register Tier-C provider-execution receipt verification as an exception.
4. Require normal duplicate cleanup to exclude experiment exceptions.
5. Add dashboard grouping:
   - collapsed experiment batches by default;
   - expanded view available on request.
6. Define queue-class precedence:
   - `cleanup-required` beats every other class;
   - `experiment-batch-exception` beats `duplicate-candidate`;
   - `active-worktree` beats dashboard collapse;
   - `superseded` beats ordinary backlog display only after machine-readable
     supersession metadata exists.

Definition of done:

- Tier-C experiment stories are preserved and grouped.
- non-experiment duplicates are reported with canonical/superseded suggestions.
- humans can decide cleanup with evidence instead of title guessing.
- a malformed experiment story is not hidden by the experiment exception.

### CP-4 - Unified Dashboard

Goal: show story-level and project-level status without confusing project queue
health with an individual story gate.

Implementation tasks:

1. Add `StoryControlStatus` rows:
   - runtime closure status;
   - consumption closure status;
   - queue classification for that story;
   - next safe action.
2. Add `ProjectControlStatus` summary:
   - aggregate runtime status;
   - aggregate consumption status;
   - aggregate queue status;
   - stale worktree count;
   - duplicate cluster count;
   - experiment batch count.
3. Show per-story top blockers.
4. Show exception groups separately from backlog pressure.
5. Ensure project-level queue issues do not automatically block unrelated story
   lifecycle gates.

Definition of done:

- operators do not need to manually stitch `session_brief`,
  `story_authority_resolve`, proof diagnostics, and story list.
- no host can answer "not done / needs redo" from stale plan docs alone.
- a story-level big check and project-level health check are visibly separate.

### CP-5A - Runtime Enforcement Rollout

Goal: move runtime diagnostics to safe hard gates where appropriate.

CP-5A must follow the same bootstrap discipline as Proof Admissibility M7:

- warn-mode must run first over the same story/head/material/runtime-policy tuple that
  will later be enforced;
- enforcement requires a named rollback command or config switch;
- grandfathered legacy runtime states are enumerated;
- checker/projector errors fail closed for high-risk runtime operations but produce actionable
  remediation;
- metadata-only dirty state and material dirty state are distinguished.

Order:

1. Runtime closure hard-blocks only unsafe operations:
   - stale active lock;
   - wrong authoritative cwd;
   - dirty tree before phase advance;
   - direct use of main mirror when worktree authority exists.
2. Runtime enforcement does not evaluate proof admissibility. It may display
   Proof M7 allow/deny rows, but it does not reimplement them.

Definition of done:

- unsafe runtime operations are blocked;
- normal development remains usable;
- rollback command/config is documented and tested.

Runtime enforcement rollout config:

```json
{
  "lifecycleControl": {
    "runtimeEnforcement": "warn"
  }
}
```

`warn` is the default rollout mode. Set `enforce` only after the same
story/head/material/runtime-policy tuple has been observed in warn mode. Set
`unavailable` only for emergency diagnostics where the runtime enforcement
projector itself is unavailable. The named rollback from enforce mode is to set
`lifecycleControl.runtimeEnforcement` back to `warn`.

### CP-5B - Queue Governance Guard

Goal: prevent accidental duplicate/superseded mutations while preserving
experiment evidence.

Order:

1. Queue governance hard-blocks only accidental duplicates:
   - never hard-block Tier-C experiment exception stories;
   - normal duplicates require human-visible canonical/superseded reason.
2. Exception writes are guarded writes:
   - main-affecting writes use the main write lock;
   - story-scoped writes obey owner lease;
   - every exception mutation records actor, reason, timestamp, and binding.

Definition of done:

- experiment batches remain preserved;
- non-experiment duplicate cleanup is reviewable;
- malformed experiment records are still visible as cleanup-required.

Proof-consumption hard blocking remains owned by Proof Admissibility M7:

- DONE_REQUIRED enforcement;
- review escalation / review assurance floor enforcement;
- handoff admissible proof refs;
- Authority receipt-facing consumers.

The control plane may render the M7 result and include it in the consumption
lane, but it must not implement a parallel proof enforcement policy.

## 7. Required Interfaces

Suggested future commands:

```text
lattice global_control_status --format=json                  # read-only
lattice runtime_closure_status --storyId=B-xxxx --format=json # read-only
lattice admissibility_waterline --storyId=B-xxxx --format=json # read-only; owned by Proof Admissibility if already implemented there
lattice queue_governance_status --format=json                # read-only
lattice queue_exception_set --storyId=B-xxxx --experimentBatchId=<id> --reason=<reason> # guarded write
```

The first implementation can be one command with subreports. Separate commands
are only needed if the module grows too large.

Guarded writes must respect the shipped write-coordination layer:

- main-affecting writes acquire `core/main-write-lock.ts`;
- story-scoped writes obey `core/story-owner-lease.ts`;
- no command writes lifecycle evidence from a dashboard/status path;
- queue exception writes are audit artifacts, not lifecycle gate evidence.

Suggested source layout:

```text
packages/main/src/core/lifecycle-control/
  global-control-service.ts
  control-status.ts
  runtime/
    runtime-closure-projector.ts
    authority-status-provider.ts
    lock-status-provider.ts
    branch-sync-provider.ts
  consumption/
    consumption-closure-projector.ts
  queue/
    queue-governance-service.ts
    queue-exception-registry.ts
    duplicate-classifier.ts
  dashboard/
    global-status-projector.ts
```

The layout preserves dependency direction: `consumption/` consumes public
Evidence Runtime / Proof Admissibility APIs; `runtime/` consumes lifecycle and
lock APIs; `queue/` owns exception and duplicate governance.

## 8. Story Exception Policy

Exceptions must be explicit and machine-readable.

```json
{
  "exceptionId": "tier-c-provider-execution-receipt-verification",
  "policyVersion": "proofbound.queue_exception.v1",
  "class": "experiment-batch-exception",
  "subject": {
    "kind": "experiment-batch",
    "experimentBatchId": "tier-c-provider-execution-receipt-verification"
  },
  "experimentBatchId": "tier-c-provider-execution-receipt-verification",
  "membership": {
    "storyIds": ["B-xxxx"],
    "source": "explicit|migration-title-prefix"
  },
  "migrationMatch": {
    "titlePrefix": "Tier-C provider-execution receipt verification"
  },
  "reason": "Intentional repeated provider-execution receipt verification runs; each story preserves run identity and experiment evidence.",
  "actor": "host-or-human-id",
  "createdAt": "2026-06-25T00:00:00.000Z",
  "hashBinding": {
    "storyId": "B-xxxx",
    "headHash": "optional-if-worktree-exists",
    "storyFilesHash": "required"
  },
  "allowedDuplicateShape": true,
  "defaultDashboardMode": "collapsed",
  "cleanupPolicy": "preserve"
}
```

Exception rules:

- exceptions never grant lifecycle completion;
- exceptions only affect queue duplicate cleanup;
- exceptions must not hide active worktree blockers;
- exceptions must not hide malformed or cleanup-required records;
- exceptions must be explicit and auditable after migration;
- `titlePrefix` is only a migration discovery / suggested-classification aid,
  never the final exception source of truth;
- an exception story promoted into product implementation must leave the
  exception class.

## 9. Verification Matrix

| Scenario | Expected result |
|---|---|
| B-1731 has worktree authority while main mirror is INIT_CHECK | Runtime lane YELLOW; authoritative cwd shown |
| A validate lock points to a dead pid | Runtime lane RED/YELLOW with stale-lock remediation |
| A validate lock points to a live child command | Runtime lane YELLOW active; do not clear |
| PASS validation exists but materialHash drifted | Runtime lane YELLOW/RED according to shipped freshness classifier and remediation hint |
| Candidate repro artifact is offered to DONE | Consumption lane RED; candidate cannot satisfy DONE |
| Local diagnostic receipt is offered as Authority completion | Consumption lane RED; `productionDoneEligible=false` |
| Tier-C receipt stories share title shape | Queue lane EXEMPT and grouped |
| Non-experiment stories share title/outcome | Queue lane RED duplicate-candidate |
| Fixture story is stale/behind main according to `StoryReadinessReport` | Runtime RED; queue YELLOW stale-worktree |
| Waterline has historical failed rows for another story | Visible audit only; does not block unrelated story |

## 10. Definition Of Done

The global control plane is complete when:

1. Every active story has a runtime lane status.
2. Every proof-consuming gate can show a consumption lane status.
3. Every active story is classified by queue governance.
4. Tier-C experiment stories are grouped and exempt from duplicate cleanup.
5. Non-experiment duplicates have canonical/superseded cleanup suggestions.
6. A story can only receive the global big check when runtime and consumption
   lanes are green, and queue state is either green or explicitly exempt.
7. Hosts see the same status before claiming work is done, not just stale docs
   or local memory.

## 11. Immediate Recommended Order

1. Finish B-1731 using authoritative worktree state; do not trust the main
   mirror alone.
2. Keep B-fc0f as a real workflow-friction follow-up, because validate/lock
   behavior directly affects runtime closure.
3. Register the Tier-C experiment exception before any duplicate cleanup.
4. Build CP-0 read-only report first.
5. Add CP-1 runtime closure checks before new hard gates.
6. Add CP-2 consumption projection after the report can already explain current
   runtime state and after Proof Admissibility exposes the needed waterline or
   diagnostics.
7. Only then consider CP-5A runtime enforcement and CP-5B queue guards.
