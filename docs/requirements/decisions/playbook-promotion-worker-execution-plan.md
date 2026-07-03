# Playbook Promotion Worker Execution Plan

Status: revised draft after Claude CLI + agy CLI audit; V1 M3-M6 plus M5.5
implemented by B-6241. B-7ee1 adds evidence-activated advisory
candidate-to-active apply. Trial serving, matched-control serving, and timers
remain future work.

## 1. Why This Document Exists

Proofbound already has the first half of the playbook learning loop:

- `playbook_propose` can distil a resolved finding into a staged proposal.
- `playbook_approve` can turn a reviewed proposal into a `candidate` playbook.
- `playbook_activate` can explicitly turn a `candidate` into an `active`
  advisory runtime playbook.
- Runtime memory consumption can surface `active` playbooks while keeping them
  non-authoritative and `gateEvidence:false`.

The missing half is lifecycle governance after a candidate is created. If
candidate playbooks depend on a human remembering to activate, reject, archive,
or mark their source non-promotable, the system keeps the same failure shape
that runtime memory was designed to fix: useful experience exists on disk, but
the workflow does not reliably consume or curate it.

This document defines a scoped promotion-worker plan that closes that loop
without weakening Proofbound's evidence model.

Short version:

> Story DONE should trigger non-blocking learning settlement. A promotion worker
> should then use explicit outcome evidence to recommend activation, reject,
> archive, recommend demotion, or mark playbook sources as non-promotable. The
> first version uses a simple absolute-threshold evaluator. A separate
> `playbook_auto_promotion_apply` command may activate only evidence-qualified
> advisory candidates; matched control groups, trial traffic, and timers are
> future extensions.

## 2. Audit-Driven Scope Correction

Claude CLI and agy CLI both agreed with the safety direction and both rejected
the original scope as too heavy for a local developer workflow.

Accepted from the original draft:

- playbooks remain `authority=non_authoritative`;
- learning artifacts remain `gateEvidence:false`;
- DONE can trigger learning settlement but cannot depend on it;
- a promotion worker cannot create review, validation, delivery, DONE, receipt,
  release, or production evidence;
- blocking lifecycle policy is separate from playbook promotion.

Changed in this revision:

- V1 no longer requires matched candidate-vs-control aggregation.
- V1 no longer requires 5% trial traffic.
- V1 no longer requires periodic timer execution.
- V1 no longer auto-promotes to active by default.
- V1 must define the source of outcome verdicts before any evaluator consumes
  them.
- V1 must specify concurrency, retention, and host-neutral schema rules before
  writing `.lattice/learning/*` files.

## 3. Problem

The current playbook lifecycle has two real gaps:

1. Candidates can remain candidates forever.
2. The existing `usage` shape is not enough to decide whether a playbook is
   useful, noisy, too narrow, stale, or harmful.

Current state:

| Surface | Current behavior | Gap |
|---|---|---|
| `playbook_propose` | Creates a proposal from a resolved finding | No automatic later settlement |
| `playbook_approve` | Creates `status:"candidate"` | Candidate may remain inert indefinitely |
| `playbook_activate` | Explicit human activation boundary | Good for override, unreliable as the normal path |
| Runtime matching | Only `active` playbooks surface | Correct safety boundary, but no candidate learning path |
| `PlaybookUsage` | `surfacedCount`, `resolvedHits`, `dismissedHits` | Raw, unmatched, and not currently updated by real consumers |
| Story DONE | Has the fullest lifecycle facts | Does not currently settle playbook outcomes |

The practical failure modes are:

- "Only born, never retired": candidates accumulate without graduation or
  rejection.
- "Only stored, not learned": completed stories do not feed back into playbook
  quality.
- "Human activation dependency": good candidates may never become active because
  no one remembers the explicit activation command.
- "Raw-counter bias": a playbook can look successful simply because it was
  present during easy or unrelated work.
- "Repeated bad distillation": the same source experience can keep generating
  rejected candidates unless the source is marked non-promotable.

## 4. Design Principles

This plan follows Proofbound's core constraints:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness and workflow correctness issues.
4. Preserve consistency of logic across lifecycle, memory, and proof surfaces.
5. Keep playbooks non-authoritative: `gateEvidence:false` remains load-bearing.
6. Do not let a learning worker block DONE or create production authority.
7. Build V1 around a small deterministic loop before introducing A/B or traffic
   allocation machinery.
8. Keep host identity host-neutral and registry-derived, not hardcoded into a
   closed product enum.

## 5. Target Outcome

The target V1 loop is:

```text
Story DONE
  -> durable DONE proof is committed
  -> best-effort learning settlement runs after DONE proof
  -> outcome ledger records explicit signals
  -> promotion sweep evaluates candidates and active playbooks
  -> dry-run/apply records recommendation or state transition
```

V1 supports:

- candidate surfacing in read-only inspection/status surfaces;
- explicit outcome recording;
- deterministic absolute-threshold evaluation;
- reject / archive / demote / mark non-promotable;
- optional explicit activation through existing `playbook_activate`;
- promotion recommendation rows for candidates that look strong enough.

V1 does not require:

- low-traffic trial serving;
- matched candidate-vs-control experiments;
- timer registration;
- blanket or timer-driven `candidate -> active` mutation.

V1 closes the assessment loop. B-7ee1 then closes the guarded advisory
activation loop through `playbook_auto_promotion_apply`: promotion sweep remains
recommendation-only, while the separate apply command consumes reviewed policy,
current candidate digest, applied `recommend_activate` decision, explicit
exposure/outcome evidence, clean lineage, and rollback readiness. The apply
command remains non-authoritative and never writes gate evidence.

`playbook_promotion_observe` is an evidence-gathering surface for M7/M8
readiness: it reports current candidates, explicit candidate-consumption
outcomes, and handled/unhandled recommendation rows. It is read-only and does
not activate, trial-serve, schedule, or automatically promote playbooks.

The lifecycle boundary is:

```text
Story lifecycle = prove the current task is complete.
Promotion worker = learn from completed work after the proof is recorded.
```

## 6. Non-Goals

The first implementation must not:

- let playbooks satisfy `verificationEvidence`, `review_pass_set`,
  `delivery_check_set`, DONE-required validation, receipt verification, release,
  or production authority;
- make playbook promotion a DONE gate;
- automatically create blocking lifecycle policy;
- infer success from raw counters alone;
- require matched control samples before the system can make any useful V1
  decision;
- write every story lesson into a global/project active playbook;
- require a daemon for ordinary Proofbound operation;
- hardcode a closed set of host products into the outcome schema;
- create unbounded learning files without retention or compaction strategy.

## 7. Core Concepts

### 7.1 V1 Status Model

V1 can use the existing `PlaybookStatus` plus adjacent promotion metadata:

| Status / metadata | Meaning | Runtime behavior |
|---|---|---|
| `proposed` | Proposal file awaiting review | Never surfaced |
| `candidate` | Approved but not active | Never surfaced in runtime packs by default |
| `active` | Advisory runtime guidance | May surface in runtime packs |
| `rejected` | Evaluated as not useful or harmful | Never surfaced; row retained |
| `archived` | No longer applicable or superseded | Never surfaced; row retained |
| `non_promotable` source | Source is not suitable for playbook abstraction | Prevents repeated generation from that source |

If direct `PlaybookStatus` expansion is too disruptive, V1 may store
`rejected` and `archived` in promotion metadata, and may preserve the legacy
storage/action name `non_deducible` for non-promotable source records, while
leaving existing playbook rows intact.

### 7.2 Candidate Surfacing In V1

V1 may show candidates in read-only inspection surfaces such as:

- `playbook_promotion_status`;
- `session_brief` advisory section when explicitly configured;
- health output;
- dry-run sweep output.

This is not runtime advice. It must render as pending learning material, not as
established active guidance.

Candidate playbooks must never appear in
`MemoryFreshnessPack.results.playbookIds` or in the active runtime guidance
section. If rendered in `session_brief`, they must appear only in a separate
`pendingLearning` / `promotionRecommendations` section clearly labeled as not
runtime advice. The boundary is:

```text
active playbook = runtime guidance
candidate playbook = pending learning material
```

### 7.3 Active Is Advisory Only

Promotion to `active` means the playbook can surface by default in runtime
memory packs. It does not mean:

- review passed;
- validation passed;
- delivery was checked;
- DONE is ready;
- production authority is established.

The memory pack remains:

```text
authority=non_authoritative
gateEvidence=false
```

### 7.4 Demotion Is As Important As Promotion

An active playbook can become stale or harmful. V1 must support at least a
recommendation path for:

- `active -> archived` when a source is superseded;
- `active -> rejected` or `active -> demote-recommended` when explicit outcome
  evidence says it caused noise, wrong claims, or repeated dismissal.

Automatic demotion may be safer than automatic promotion because it reduces
behavior-shaping surface. Still, any state mutation must be auditable and
idempotent.

### 7.5 Blocking Policy Is A Separate Track

If a playbook pattern should ever block a lifecycle action, that must be handled
by a separate story that updates process-fact / command-policy infrastructure.
The promotion worker cannot create blocking policy.

## 8. DONE Trigger Contract

Story DONE is the natural trigger for learning settlement because it has the
fullest set of lifecycle facts. The hook must be architected so it cannot
weaken or delay DONE.

Load-bearing ordering:

```text
DONE gate passes
  -> DONE lifecycle mutation / merge / summary is durably committed
  -> worktree cleanup is complete or recoverable
  -> best-effort learning settlement runs
  -> settlement failure is recorded as advisory health/audit information only
```

The settlement hook must:

- run after DONE proof is durable;
- be wrapped in `try/catch`;
- have a hard timeout;
- be idempotent under `done_recover`;
- use stable idempotency keys;
- avoid acquiring the main lifecycle write lock;
- use a learning-store-specific lock or atomic append semantics;
- never mutate story phase, checklist, review, validation, delivery, or DONE
  evidence.

If settlement fails, DONE remains DONE. The failure is visible through
`playbook_promotion_status` / health output and can be retried manually.

## 9. Outcome Verdict Sources

Outcome verdict source is load-bearing. V1 must define it before aggregation or
evaluation can be trusted.

### 9.1 Allowed Verdict Sources

V1 accepts only explicit or mechanically derived signals:

| Verdict | Allowed source |
|---|---|
| `helped` | explicit `playbook_outcome_record` by operator/reviewer, or delivery/review text structured through an approved field saying the playbook prevented a repeat issue |
| `neutral` | DONE settlement observed no positive or negative signal |
| `dismissed` | explicit operator/reviewer mark that the playbook was irrelevant or noisy |
| `harmful` | explicit operator/reviewer mark, or a reviewer finding that the playbook caused a wrong claim, false DONE, false block, or misleading guidance |
| `unknown` | incomplete settlement data; must not count as positive evidence |

Unknown and neutral records can support retention and health diagnostics, but
they must not promote a playbook by themselves.

A candidate cannot receive `helped` from DONE settlement unless the event
records a concrete exposure mode other than `none` and a structured verdict
source. DONE success alone cannot settle a candidate as `helped`.
DONE experience seeds create candidate playbooks only; DONE success alone never records helped and never activates runtime guidance.

### 9.2 Signals That Must Not Count As Positive

The following are not sufficient evidence of usefulness:

- playbook was merely surfaced;
- story reached DONE;
- validation passed;
- no reviewer filed a finding;
- the main agent claimed the playbook was useful in prose without a structured
  outcome field.

This avoids a self-referential feedback loop where the same agent shaped by the
playbook declares the playbook successful without independent or explicit
signal.

## 10. Storage, Concurrency, And Retention

### 10.1 Storage Scope

V1 learning artifacts live under:

```text
.lattice/learning/
```

They are runtime learning artifacts, not material proof. The runtime artifact
registry must exclude them from material hash and gate evidence consumption.

Storage policy must be explicit:

- local-only learning is acceptable for V1;
- if team-wide aggregation is desired, it must be a separate sync/export
  mechanism, not accidental Git conflict on JSONL files;
- committed summary reports may exist, but raw local outcome ledgers should not
  be treated as source-of-truth project requirements.

### 10.2 Concurrency

Parallel worktrees can finish stories at the same time. Learning writes must
therefore use one of:

- learning-store-specific file lock;
- atomic append with line-level validation and fsync where available;
- atomic temp-file rewrite with compare-and-swap digest;
- existing main-write-lock only if it is proven not to contend with DONE and
  explicitly scoped outside lifecycle mutation.

V1 should prefer a dedicated learning-store lock so promotion settlement cannot
deadlock with lifecycle DONE.

### 10.3 Retention And Compaction

Append-only learning files must not grow forever.

V1 must define:

- maximum local raw ledger age or size;
- compaction into aggregate summaries;
- preservation of decision log rows needed for audit;
- health warning when compaction is overdue;
- corruption handling for partial/truncated JSONL lines.

Suggested first policy:

```text
raw outcomes: keep 90 days or a configured max byte size
decision log: keep applied decisions indefinitely, compact dry-run rows
aggregates: regenerate from retained raw rows + decision summaries
```

## 11. Host-Neutral Schema Rule

Host may be a matching dimension, but the schema must not hardcode a closed enum
of current products.

Use an open value:

```ts
host?: string;
hostProvider?: string;
hostCapabilityId?: string;
```

The capability registry or runtime host policy layer can normalize values such
as Codex CLI, Claude Code CLI, and Antigravity. The outcome ledger itself should
remain host-neutral so adding a future host does not require a schema migration.

## 12. V1 Data Model

### 12.1 Outcome Ledger

Add an append-only local learning ledger, for example:

```text
.lattice/learning/playbook-outcomes.jsonl
```

Suggested schema:

```ts
interface PlaybookOutcomeEvent {
  schemaVersion: 'proofbound.playbook-outcome.v1';
  eventId: string;
  idempotencyKey: string;
  observedAt: string;
  storyId: string;
  playbookId: string;
  playbookStatusAtObservation: 'candidate' | 'active';
  exposureMode: 'candidate-inspection' | 'active-advisory' | 'none';
  consumer:
    | 'session_brief'
    | 'story_create'
    | 'story_advance'
    | 'done_prepare'
    | 'done_closure'
    | 'final_response_check'
    | 'reviewer'
    | 'delivery'
    | string;
  context: {
    storyPhase?: string;
    storyType?: string;
    fileKinds: string[];
    triggerClasses: string[];
    host?: string;
    hostProvider?: string;
    hostCapabilityId?: string;
  };
  outcome: {
    verdict: 'helped' | 'neutral' | 'dismissed' | 'harmful' | 'unknown';
    verdictSource:
      | 'operator'
      | 'reviewer'
      | 'delivery-reviewer'
      | 'done-settlement'
      | 'health-scan'
      | string;
    causedNoise: boolean;
    causedWrongClaim: boolean;
    preventedRepeatFinding: boolean;
    note?: string;
  };
  bindings: {
    headHash?: string;
    storyFilesHash?: string;
    materialHash?: string;
    summaryDigest?: string;
    deliveryCheckDigest?: string;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
}
```

### 12.2 Promotion Decision Log

Add an append-only decision log:

```text
.lattice/learning/playbook-promotion-decisions.jsonl
```

Each row records:

- playbook id;
- evaluated status;
- aggregate digest;
- action: `recommend_activate`, `reject`, `hold`, `archive`,
  `recommend_demote`, plus non-promotable source marking through the legacy
  compatibility action `mark_non_deducible`;
- reason codes;
- before and after metadata;
- worker version;
- dry-run or applied;
- no PII, no prompt text, no secret material.

### 12.3 Non-Promotable Source Registry

Add a small registry keyed by source experience/finding signature:

```text
.lattice/learning/non-deducible-sources.json
```

The file path keeps the legacy compatibility name `non_deducible`; operator
docs and output should describe the concept as `non_promotable`.

Purpose:

- prevent the same source experience from repeatedly generating failed
  candidates;
- preserve why it failed;
- allow explicit human override if a future story has better evidence.

## 13. V1 Aggregation And Evaluator

V1 uses an absolute-threshold evaluator. Matched candidate-vs-control is a
future quality improvement, not a V1 blocker.

### 13.1 Aggregate Shape

```ts
interface PlaybookPromotionAggregate {
  playbookId: string;
  status: 'candidate' | 'active';
  decisiveSamples: number;
  helpedCount: number;
  dismissedCount: number;
  harmfulCount: number;
  wrongClaimCount: number;
  neutralCount: number;
  unknownCount: number;
  contextClassCount: number;
  sourceRejectedSiblingCount: number;
  aggregateDigest: string;
}
```

Unknown rows are counted for observability but excluded from positive promotion
evidence.

Definitions:

```text
decisiveSamples = helpedCount + dismissedCount + harmfulCount
```

`neutralCount` and `unknownCount` are observability only and are excluded from
promotion denominators. A playbook must not be recommended for activation merely
because it appeared many times without an explicit negative signal.

### 13.2 Evaluator

The evaluator must be a pure function:

```ts
evaluatePlaybookPromotion(aggregate, config) -> decision
```

Suggested V1 decisions:

```ts
type PromotionDecision =
  | 'recommend_activate'
  | 'reject'
  | 'hold'
  | 'archive'
  | 'recommend_demote'
  | 'mark_non_deducible'; // legacy compatibility action for non_promotable source marking
```

V1 promotion recommendation criteria:

- decisive samples meet configured minimum;
- helped count meets configured minimum;
- harmful and wrong-claim counts are zero;
- dismissal rate is below the configured ceiling;
- context class count meets a small diversity floor;
- source is not superseded or deprecated.

Suggested conservative defaults:

```text
minDecisiveSamples: 3
minHelpedCount: 2
minContextClasses: 2
maxDismissalRate: 0.30
maxHarmfulCount: 0
maxWrongClaimCount: 0
```

These defaults are intentionally lower than an online A/B system because local
developer workflows are sparse. They should be configurable.

### 13.3 Reject / Archive / Demote

Reject a candidate when:

- harmful or wrong-claim evidence exists;
- dismissal/noise rate is above threshold;
- repeated explicit feedback says it is too vague or not operationally
  checkable;
- source is superseded and no longer useful.

Recommend demotion or archive for active playbooks when:

- harmful or wrong-claim evidence exists;
- source has been superseded;
- repeated dismissals show the active guidance is now noise.

### 13.4 Non-Promotable Sources

Mark a source as non-promotable when:

- the same source experience/finding has produced 3 rejected candidates; or
- reviewers repeatedly judge the abstraction too vague, too local, or not
  operationally checkable; or
- the source is a one-off environment/tool incident that should remain
  dev-memory rather than a process playbook.

`playbook_propose` must consult the non-promotable source registry before
creating a new proposal. The registry may remain stored at the legacy
compatibility path `.lattice/learning/non-deducible-sources.json`. When the
source signature is marked non-promotable, the command must refuse or warn
instead of silently generating another candidate, unless the caller supplies an
explicit override flag and reason.

## 14. Future Matched-Control Track

Matched candidate-vs-control can improve confidence later, but it is not V1.

Future prerequisites:

- enough outcome volume to populate buckets;
- a real hold-out/control mechanism;
- explicit product decision that withholding candidate guidance is acceptable;
- documented matching dimensions;
- proof that matched-control decisions outperform the V1 evaluator.

When implemented, matched aggregation should be `preferred when available`, not
the only path to make any promotion decision.

## 15. Commands

### 15.1 `playbook_outcome_record`

Purpose: append a learning outcome event.

Properties:

- writes only to `.lattice/learning/playbook-outcomes.jsonl`;
- validates schema fail-closed;
- requires `authority:"non_authoritative"` and `gateEvidence:false`;
- refuses events that claim proof, DONE, or production authority;
- writes through the learning-store concurrency mechanism.

### 15.2 `playbook_promotion_sweep`

Purpose: evaluate affected candidates/active playbooks and produce decisions.

Suggested flags:

```bash
lattice playbook_promotion_sweep --dryRun
lattice playbook_promotion_sweep --apply
lattice playbook_promotion_sweep --playbookId=PB-123 --dryRun
lattice playbook_promotion_sweep --since=2026-07-01T00:00:00.000Z --dryRun
```

Rules:

- default is dry-run;
- `--apply` is required for mutation;
- apply is idempotent;
- apply writes a decision log row for every evaluated idempotency key;
- V1 apply may write recommendations, rejected/archive metadata, demotion
  recommendations, and non-promotable source records stored under the legacy
  compatibility naming/path;
- promotion sweep apply does not activate candidates; activation is handled only
  by the separate evidence-gated `playbook_auto_promotion_apply` command;
- apply cannot mutate story lifecycle state;
- apply cannot write review, validation, delivery, or DONE evidence.

### 15.3 `playbook_promotion_status`

Purpose: inspect current promotion posture.

Output:

- candidates by status;
- active playbooks with recent negative signals;
- pending settlement / queue count;
- latest decisions;
- rejected/non-promotable sources;
- retention/compaction warnings;
- evidence-activation readiness and blocker state.

## 16. Feature Flags And Rollout

Suggested V1 flags:

| Flag | Default | Meaning |
|---|---|---|
| `PLAYBOOK_PROMOTION_SWEEP_ENABLED` | off for apply, dry-run available | Allows sweep apply mode |
| `PLAYBOOK_DONE_SETTLEMENT_ENABLED` | default-on, explicit opt-out with `false` / `0` / `no` / `off` | Allows post-DONE learning settlement health rows |

Future flags:

| Flag | Default | Meaning |
|---|---|---|
| `PLAYBOOK_TRIAL_SERVING_ENABLED` | off | Allows trial playbooks to surface at bounded traffic |
| `PLAYBOOK_PROMOTION_TIMER_ENABLED` | off | Allows periodic timer registration |

Evidence-activated advisory promotion is not controlled by a default-off
ordinary-use flag. `playbook_auto_promotion_apply --apply` may activate only
candidate playbooks that satisfy the reviewed activation policy, current
candidate digest, applied `recommend_activate` decision, explicit exposure,
structured outcome evidence, clean source lineage, and rollback/demotion
readiness. It remains non-authoritative and never writes gate evidence.

Fail-closed rules:

- promotion sweep apply remains disabled unless
  `PLAYBOOK_PROMOTION_SWEEP_ENABLED` is explicitly true-like;
- DONE settlement is default-on when
  `PLAYBOOK_DONE_SETTLEMENT_ENABLED` is absent or malformed, and is disabled
  only by explicit opt-out values (`false`, `0`, `no`, or `off`);
- dry-run remains available when apply is disabled;
- blocking policy promotion is never controlled by these flags because it is out
  of scope.

## 17. Observability

Every applied decision should emit:

- structured local log line;
- decision log row;
- status summary.

Metrics/counters are optional in V1. If added, they must be local diagnostics,
not a dependency for correctness.

No PII, prompt text, tokens, secrets, or raw user content should be logged.

## 18. Safety Boundaries

Load-bearing invariants:

1. Learning artifacts remain runtime artifacts, not material proof.
2. `gateEvidence:false` is required on learning events.
3. Promotion decisions cannot satisfy lifecycle gates.
4. DONE can enqueue or record learning settlement, but cannot depend on the
   worker's success.
5. The worker cannot file findings, review passes, delivery checks, validation
   evidence, or DONE-required evidence.
6. `active` means advisory runtime guidance only.
7. `blocking` requires a separate reviewed story and process-fact registration.
8. All writes are append-only or state transitions that preserve prior rows.
9. Stale/malformed candidate rows fail closed.
10. The worker must be idempotent under repeated runs.
11. The learning store must not deadlock lifecycle DONE.
12. Host identity remains open/registry-derived.

## 19. Milestones

### M0. Red/Repro: Prove The Open Loop

Goal: prove the current gap before implementation.

Deliverables:

- red test showing candidates can remain candidates indefinitely;
- red test showing `PlaybookUsage` counters alone are not incremented by real
  runtime consumers;
- red test showing no promotion decision log exists;
- red test showing source experiences can be repeatedly distilled without a
  non-promotable stop condition.

Exit criteria:

- failures are reproducible on the current codebase;
- failures distinguish current safety behavior from missing closure behavior.

### M1. Learning Store Discipline

Goal: make learning writes safe before adding more learning files.

Deliverables:

- learning-store-specific lock or atomic append/rewrite discipline;
- runtime artifact registry coverage;
- retention/compaction policy;
- host-neutral schema conventions.

Tests:

- parallel append cannot corrupt JSONL;
- malformed/truncated rows are skipped with diagnostics;
- runtime material hash excludes learning artifacts;
- host field accepts unknown future host strings;
- retention health warning fires when configured bounds are exceeded.

### M2. Outcome Ledger

Goal: add append-only outcome recording with explicit verdict sources.

Deliverables:

- `PlaybookOutcomeEvent` schema;
- `playbook_outcome_record`;
- verdict-source validation;
- strict validation against authority/gate claims.

Tests:

- valid outcome appends;
- malformed outcome rejects;
- inherited/prototype-polluted fields cannot masquerade as outcome fields;
- `gateEvidence:true` rejects;
- unknown/neutral rows do not count as positive promotion evidence;
- no story evidence file is written.

### M3. DONE Settlement Hook

Goal: make Story DONE record learning settlement without blocking DONE.

Deliverables:

- post-DONE best-effort settlement hook;
- hard timeout and try/catch;
- idempotency key;
- visible warning when settlement fails;
- no main lifecycle lock acquisition.

Tests:

- DONE success does not depend on promotion success;
- settlement runs only after DONE proof is durable;
- failed settlement is visible but non-blocking;
- repeated `done_recover` does not duplicate events;
- settlement cannot mutate story phase or gate evidence.

### M4. V1 Aggregate And Evaluator

Goal: decide recommend_activate/reject/hold/archive/recommend_demote/
non_promotable source marking from explicit outcomes.

Deliverables:

- pure aggregate function;
- pure evaluator;
- configurable thresholds;
- reason codes;
- fixture datasets proving decision soundness.

Tests:

- recommend_activate boundary;
- reject boundary;
- hold due to low sample;
- archive due to superseded source;
- recommend_demote for harmful active playbook;
- non-promotable after repeated rejected candidates;
- harmful/wrong-claim prevents activation recommendation.

### M5. Sweep Command

Goal: inspect and apply V1 decisions.

Deliverables:

- `playbook_promotion_sweep --dryRun`;
- `playbook_promotion_sweep --apply`;
- decision log;
- idempotency.

Tests:

- dry-run writes nothing;
- apply writes exactly one decision row per idempotency key;
- repeated apply is stable;
- stale candidate digest fails closed;
- unrelated playbooks are preserved.

### M5.5. Proposal Guard For Non-Promotable Sources

Goal: stop repeated failed distillation at the proposal boundary.

Deliverables:

- `playbook_propose` consults the non-promotable source registry, stored under
  the legacy compatibility path/name `non_deducible`;
- marked sources refuse or warn before proposal creation;
- override requires an explicit flag and reason;
- override events are auditable.

Tests:

- non-promotable source blocks or warns on new proposal;
- explicit override with reason succeeds;
- override without reason rejects;
- unmarked source keeps existing proposal behavior.

### M6. Candidate Inspection And Status

Goal: make pending candidates visible without treating them as active guidance.

Deliverables:

- `playbook_promotion_status`;
- optional session/advisory rendering of pending candidates;
- clear label that candidates are not active runtime guidance.

Tests:

- candidate appears in status but not runtime memory active hits;
- active playbook still appears in runtime memory pack;
- rejected/archived/non-promotable sources never surface as active guidance.

### M7. Future Trial / Matched-Control Spike

Goal: decide whether traffic-based trial serving is justified.

Deliverables:

- spike report using real or simulated outcome volumes;
- matched-control feasibility analysis;
- recommendation to proceed, defer, or reject.

Tests:

- sample volume estimate is realistic;
- control mechanism is explicit;
- trial traffic cannot surface when flag is off.

### M8. Evidence-Activated Advisory Apply And Future Timer

Goal: close the guarded advisory activation loop without changing promotion
sweep semantics or lifecycle authority.

Deliverables:

- promotion sweep remains recommendation-only and records applied
  `recommend_activate` decisions when explicitly applied;
- `playbook_auto_promotion_apply` is the separate evidence-activated apply
  writer for candidate-to-active advisory activation;
- apply requires reviewed policy, current candidate digest, an applied
  `recommend_activate` decision, explicit non-DONE exposure/outcome evidence,
  clean source lineage, and rollback/demotion readiness;
- apply writes non-authoritative, `gateEvidence:false` activation audit rows;
- optional periodic timer registration remains future work.

Tests:

- DONE-settlement-labelled rows cannot satisfy activation recommendation or
  eligibility thresholds;
- stale candidate digests fail closed;
- malformed activation audit rows fail closed without activating a candidate;
- advisory activation remains non-authoritative and `gateEvidence:false`;
- future timer registration, if added, is visible and bounded;
- demotion recommendations surface harmful active guidance.

## 20. Acceptance Criteria

V1 is complete when:

1. Learning-store writes are concurrency-safe and material-hash excluded.
2. A story DONE can trigger learning settlement after durable DONE proof without
   blocking DONE.
3. Outcome events are recorded in an append-only non-authoritative ledger.
4. Outcome verdict sources are explicit and validated.
5. Unknown/neutral rows cannot promote a playbook by themselves.
6. The evaluator can recommend activation, reject, hold, archive, recommend
   demotion, and mark sources non-promotable.
7. Dry-run and apply modes are deterministic and idempotent.
8. Applied decisions are auditable.
9. No promotion path can satisfy review, validation, delivery, DONE, receipt,
   release, or production authority.
10. Rejected and archived rows are retained.
11. Repeated bad distillation from the same source is stopped by
    `non_promotable` source records, stored under the legacy compatibility
    name/path `non_deducible`.
12. Candidate playbooks never enter active runtime memory pack results.
13. `playbook_propose` consults non-promotable source records and requires an
    explicit override reason to bypass them; the storage/API compatibility name
    may remain `non_deducible`.

Future completion for V2+ requires separate acceptance criteria for trial
serving, matched control, timers, and any timer-driven or trial-serving
promotion variants.

## 21. Suggested Implementation Order

Recommended sequence:

1. M0 red/repro.
2. M1 learning-store discipline.
3. M2 outcome ledger.
4. M4 V1 aggregate/evaluator.
5. M5 dry-run/apply sweep.
6. M3 DONE settlement hook.
7. M6 candidate inspection/status.
8. M7 trial/matched-control spike.
9. M8 evidence-activated advisory apply; timer registration remains a separate
   future extension only if the simple loop is insufficient.

M3 can move earlier if the team wants settlement data sooner, but the safest
order is to establish concurrency and outcome validation before wiring DONE.

## 22. Open Questions

1. Should rejected/archive/non-promotable state extend `PlaybookStatus`
   directly, or live in adjacent promotion metadata with legacy storage
   compatibility?
2. What minimum explicit signal should count as `helped` without adding reviewer
   burden?
3. Should local-only learning be enough for V1, or is an export/import summary
   needed for multi-host aggregation?
4. What retention limit is acceptable for local raw outcome ledgers?
5. Should candidate inspection appear in `session_brief`, or only in
   `playbook_promotion_status`?
6. What review path should future timer-driven, trial-serving, or materially
   different promotion policies require before they can change active advisory
   behavior?

## 23. Relationship To Existing Plans

This plan extends, but does not replace:

- `playbook-runtime-memory-consumption-execution-plan.md`, which focuses on
  active playbook consumption;
- `dev-memory.md`, which defines non-authoritative experience capture;
- `decision-doc-promotion-execution-plan.md`, which promotes durable decisions
  into project documentation.

The promotion worker is the learning-loop closure layer between experience
capture and active runtime consumption. V1 closes the loop conservatively; later
milestones may add traffic experiments only when local evidence shows the simple
loop is insufficient.
