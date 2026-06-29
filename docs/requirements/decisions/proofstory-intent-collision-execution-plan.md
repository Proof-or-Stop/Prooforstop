# ProofStory Intent-Collision Execution Plan

> Status: execution plan.
> Date: 2026-06-29.
> Scope: Proofbound story intake, PLAN, pre-DEV proof contract, red evidence,
> disposable spike evidence, verificationIntent, REVIEW critic, and DONE
> evidence boundaries.

## One-Sentence Decision

ProofStory belongs inside the Story lifecycle as a pre-DEV contract layer:

```text
raw request
  -> story draft or story container
  -> progressive intent hardening classification
  -> original intent snapshot
  -> milestone ledger when the request has multiple required outcomes
  -> intent understanding
  -> intent collision
  -> verificationIntent
  -> ProofStory contract
  -> red evidence and spike when required
  -> ProofStory gate
  -> DEV
  -> REVIEW critic
  -> TEST
  -> DONE
```

The raw request is not executable. The Story container may exist before the
intent is fully understood, but DEV must not start until the intent and
ProofStory contract are mechanically sufficient.

## Proof-Stop Loop Principle

Proofbound should be proof-stop by default. Every lifecycle transition either
produces admissible proof for the next phase or stops and loops back to the
earliest layer that owns the missing proof.

```text
missing proof
  -> stop current progression
  -> classify the missing proof
  -> loop to the owner layer
  -> refresh the proof
  -> retry the transition
```

This is not a blind retry loop. The loop target is determined by the proof gap:

| Missing proof | Stop before | Loop owner |
|---|---|---|
| Original intent unclear | ProofStory / DEV | intent understanding and intent collision |
| Milestone ledger incomplete | DEV / DONE | original intent snapshot and milestone ledger |
| Checklist does not cover milestones | DEV / DONE | checklist and verificationIntent authoring |
| Scope narrowed without confirmation | DEV / DONE | scope shrinkage decision and user confirmation |
| Red evidence missing | DEV | red evidence |
| Spike unresolved | DEV | spike evidence |
| verificationIntent lacks evidence | REVIEW / TEST | DEV evidence work |
| Reviewer finding confirmed | TEST | DEV repair and REVIEW rebind |
| TEST evidence failed or stale | DONE | DEV repair or evidence refresh |
| DONE intent equivalence failed | DONE | ProofStory, checklist, delivery check, or user confirmation |

The invariant is:

```text
proof missing -> stop
proof classified -> targeted loop
proof refreshed -> continue
```

## Progressive Intent Hardening

Intent validation must be progressive. Every story gets the smallest useful
intent contract, and additional proof layers are added only when ambiguity,
risk, multi-deliverable scope, or DONE equivalence requires them.

The goal is not to make every small task pay for the full ProofStory surface.
The goal is to prevent scope shrinkage and wrong-problem implementation without
turning intent validation into ceremony.

| Layer | Trigger | Required contract |
|---|---|---|
| Intent MVP | Default for every story | Source text, normalized expected outcome, and one acceptance claim |
| Milestone Intent | Multiple deliverables, numbered list, explicit count, "all milestones", "all remaining items", complete subsystem removal, end-to-end product behavior, or explicit multi-part DONE request | Milestone ledger and checklist-to-ledger coverage |
| Collision Intent | Ambiguous, consequential, high-risk, scope-changing, or user-impactful interpretation | Intent collision with `pass`, `revise_intent`, `human_gate`, or `stop` |
| ProofStory Intent | Bug fix, regression fix, behavior change, security/auth/session change, lifecycle gate, benchmark claim, or unclear ownership | Acceptance contract, verificationIntent binding, risk policy, and red/spike policy when triggered |
| DONE Intent Equivalence | Any story entering DONE gets a lightweight check; milestone, shrinkage, or high-assurance stories get a strict gate | Actual delivery compared with the original snapshot and required milestone ledger, if one exists |

This progressive model has four rules:

- do not require a milestone ledger for ordinary single-outcome tasks;
- do not require red evidence or spike evidence unless the risk policy triggers
  them;
- do not trigger milestone intent from keywords alone; require a structural or
  semantic signal such as an explicit count, a list, a subsystem removal claim,
  or an end-to-end product behavior claim;
- do not allow DONE when the delivered outcome is narrower than the frozen
  original intent unless the user explicitly confirmed a scope-shrinkage
  decision.

## Problem

The current lifecycle already has strong post-implementation controls:
verificationIntent, verificationEvidence, reviewer lanes, TEST validation,
delivery check, and DONE summary. The remaining lifecycle gap is earlier:

- a raw user request can be turned into a story before the system proves it
  understood the user intent;
- red evidence can be written against the wrong problem;
- spike exploration can chase the wrong code path;
- verificationIntent can describe a technically convenient test rather than the
  user's actual goal;
- a narrow DONE can be mistaken for the user's full multi-milestone DONE;
- scope can shrink silently from "complete removal" or "all milestones done" to
  a narrower implementation such as "retire the main-path semantics";
- REVIEW can later certify an implementation that is internally consistent but
  pointed at the wrong outcome.

REVIEW critic and intent critic are both needed because they protect different
failure modes:

| Mechanism | Phase | Question | Main failure prevented |
|---|---|---|---|
| Intent critic / collision | PLAN, before ProofStory gate | Did we understand the user's intent correctly? | Implementing, testing, or spiking the wrong problem |
| REVIEW critic / completeness critic | REVIEW, after implementation | Did the implementation or evidence miss something? | False DONE, missed paths, weak evidence, integration gaps |

The B-576e incident class is the motivating example for the intent-fidelity
layer: a narrower DONE can satisfy a story checklist while still failing the
user's original multi-milestone request. The lifecycle therefore needs a
machine-checkable representation of the original intent, not only the current
checklist.

## Current Baseline

The current active lifecycle is:

```text
INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE
```

Current relevant facts:

- `understanding_set` records `task`, `outcome`, `facts`, `constraints`,
  `unknowns`, and `touchpoints` in PLAN.
- `verificationIntent` is filled on checklist items in PLAN and is consumed by
  DEV/REVIEW/TEST through `verificationEvidence`.
- `grill_start` / `grill_record` / `grill_close` are PLAN-only planning context
  commands. They clarify intent but do not currently provide gate evidence.
- `story_review` already reviews the PLAN package before DEV.
- REVIEW has reviewer lanes such as concept, quality, test-coverage, behavior,
  and docs. It can be extended with a completeness-critic orchestration.

This plan does not remove any of those controls. It adds an explicit pre-DEV
ProofStory contract and an intent-collision gate between understanding and DEV.

## Target Lifecycle

### Normal Story Path

```text
story_create or story_draft
  -> INIT / INIT_CHECK
  -> PLAN
       -> classify progressive intent hardening level
       -> original_intent_snapshot_set
       -> milestone_ledger_set when the request contains multiple deliverables
       -> understanding_set
       -> intent_collision_set
       -> decision_set when required
       -> checklist + verificationIntent
       -> proofstory_contract_set
       -> red_evidence_* when required
       -> spike_* when required
       -> intent_coverage_check
       -> proofstory_gate_check
       -> story_review
  -> DEV
  -> REVIEW
       -> reviewer lanes
       -> completeness critic when required
  -> TEST
  -> DONE
```

### Why Story Before ProofStory

Story creation is allowed to create a controlled container. It is not permission
to implement. The Story container gives the system a durable place for:

- raw request text;
- original intent snapshot;
- milestone ledger;
- user-visible outcome;
- intent questions and answers;
- risk signals;
- candidate scope;
- ProofStory contract;
- red and spike evidence;
- reviewer and gate artifacts.

The gate boundary is not "story exists". The gate boundary is:

```text
ProofStory gate passed -> DEV may start
```

## Artifact Model

The ProofStory layer should write one canonical structured artifact:

```text
.lattice/story/actives/<storyId>/proofstory.json
```

The artifact must be written only by CLI handlers. Direct file editing is not a
valid path.

### Intent Fidelity Layer

ProofStory includes an intent-fidelity layer before red evidence, spike
evidence, and DEV. Its job is to make the user's requested outcome
machine-checkable and non-shrinkable.

Progressive intent hardening controls how much of this layer is required. The
original intent snapshot is universal. The milestone ledger, collision artifact,
red evidence, spike evidence, and DONE equivalence checks are activated by
clear triggers rather than by default ceremony.

| Mechanism | Solves |
|---|---|
| `originalIntentSnapshot` | Freezes the user's original words and key requirements so later agents do not rely on memory |
| `milestoneLedger` | Turns requests such as "all five milestones are DONE" into a countable delivery table |
| `intentCoverageCheck` | Checks that checklist items and verificationIntent entries cover every milestone |
| `scopeShrinkageGuard` | Prevents silently narrowing "fully remove X" into "retire main-path X semantics" |
| DONE intent equivalence gate | Checks that the actual completed result is equivalent to the original intent, not only checklist-done |

Milestone intent should not be triggered by isolated wording alone. A phrase
such as "complete this small typo fix" is still a single-outcome Intent MVP
task. The milestone ledger is triggered by keyword plus structure or semantics:
multiple deliverables, numbered lists, explicit counts, "all milestones", "all
remaining items", complete removal of a subsystem, end-to-end product behavior,
or any other wording that can be silently narrowed.

### Original Intent Snapshot

The original intent snapshot is created before checklist authoring. It stores
the user's original words plus a normalized, reviewable interpretation.

For Intent MVP, the semantic payload is intentionally tiny:

```json
{
  "sourceText": "user's original request",
  "normalizedOutcome": "observable outcome the user expects",
  "acceptanceClaim": "single claim that proves the outcome"
}
```

Handlers may add metadata such as `storyId`, `requestHash`, or timestamps, but
facts, constraints, unknowns, and touchpoints are not required for the Intent
MVP path. When a trigger escalates the story, the snapshot can expand into the
more detailed shape below.

```json
{
  "storyId": "B-xxxx",
  "sourceText": "user's original request",
  "requestHash": "sha256:...",
  "keyRequirements": [
    {
      "id": "REQ-001",
      "text": "first user requirement",
      "kind": "milestone",
      "mustRemainCovered": true
    }
  ],
  "absoluteWording": [
    {
      "term": "all five milestones",
      "meaning": "every ledger item must have delivery evidence before DONE"
    }
  ],
  "forbiddenShrinkage": [
    "Do not replace complete removal with main-path retirement unless the user confirms the shrinkage."
  ]
}
```

### Milestone Ledger

When the user provides multiple required outcomes, the system must compile them
into a milestone ledger before checklist finalization.

```json
{
  "storyId": "B-xxxx",
  "milestones": [
    {
      "id": "M1",
      "sourceRequirementId": "REQ-001",
      "claim": "first required milestone",
      "doneMeans": "observable completion rule",
      "requiredEvidence": ["verificationIntent", "test", "delivery-check"],
      "checklistRefs": ["CHK-001"],
      "verificationIntentRefs": ["CHK-001:happy:0"],
      "status": "covered"
    }
  ]
}
```

The milestone ledger is not a planning convenience. It is a gate-consumed
contract. Every checklist item that implements part of a multi-milestone
request must reference one or more ledger items. A ledger item without checklist
coverage is an intent coverage gap.

### Intent Coverage Check

`intentCoverageCheck` verifies the graph:

```text
originalIntentSnapshot.keyRequirements
  -> milestoneLedger.milestones
  -> checklist.items
  -> verificationIntent
  -> verificationEvidence
  -> delivery-check docsPromises / realMachineTests
```

Coverage must be checked at two points:

- before DEV, to prevent implementation of an incomplete contract;
- before DONE, to prevent checklist completion from being mistaken for original
  intent completion.

### Scope Shrinkage Guard

Any narrowing of the original intent must create a scope-shrinkage decision:

```json
{
  "storyId": "B-xxxx",
  "sourceRequirementId": "REQ-001",
  "originalScope": "fully remove Authority Server semantics",
  "proposedScope": "retire Authority Server semantics from the main CLI path",
  "reason": "bounded migration slice",
  "userConfirmed": true,
  "confirmedAt": "2026-06-29T00:00:00.000Z",
  "replacementMilestones": ["M1", "M2"]
}
```

If `userConfirmed` is not true, the guard must treat the shrinkage as unresolved.
Reviewer or agent judgment is not enough to shrink the user's stated intent.

### DONE Intent Equivalence Gate

DONE requires more than checklist completion, but the check must remain
proportional. Every story gets a lightweight equivalence check that verifies the
summary covers the original snapshot. Stories with milestone ledgers, scope
shrinkage, or high-assurance classification get a strict equivalence gate that
compares the actual delivered result against the frozen original intent:

```text
actual delivery is DONE
  only if every required milestone is covered
  AND every accepted scope shrinkage has explicit user confirmation
  AND summary/delivery evidence describes the same outcome as the snapshot
```

The gate should fail when:

- any required milestone is uncovered;
- any milestone is marked "not applicable" without a shrinkage decision;
- the summary claims a narrower outcome than the snapshot;
- delivery-check verifies only a subset of the ledger;
- the work says "DONE" while the original request said "all milestones DONE".

### ProofStory Contract Schema

```json
{
  "storyId": "B-xxxx",
  "version": 1,
  "intentHardening": {
    "level": "milestone_intent",
    "triggers": ["multiple_deliverables", "explicit_done"],
    "requiredArtifacts": [
      "originalIntentSnapshot",
      "milestoneLedger",
      "intentCoverageCheck"
    ],
    "mode": "warn"
  },
  "originalIntentSnapshot": {
    "sourceText": "original user request",
    "requestHash": "sha256:...",
    "keyRequirements": ["REQ-001"],
    "forbiddenShrinkage": ["no unconfirmed scope narrowing"]
  },
  "milestoneLedger": {
    "required": true,
    "milestones": [
      {
        "id": "M1",
        "sourceRequirementId": "REQ-001",
        "claim": "first required milestone",
        "checklistRefs": ["CHK-001"],
        "verificationIntentRefs": ["CHK-001:happy:0"],
        "status": "covered"
      }
    ]
  },
  "scopeShrinkage": {
    "decisions": [
      {
        "id": "SS-001",
        "sourceRequirementId": "REQ-001",
        "originalScope": "original requested scope",
        "proposedScope": "narrower accepted scope",
        "userConfirmed": true
      }
    ]
  },
  "intentUnderstanding": {
    "task": "what problem the user wants solved",
    "userOutcome": "what the user expects to observe",
    "nonGoals": ["what this story will not do"],
    "facts": ["known facts"],
    "constraints": ["hard constraints"],
    "unknowns": ["open questions that remain before implementation"],
    "touchpoints": ["likely files or subsystems"]
  },
  "intentCollision": {
    "status": "pass",
    "questions": [
      {
        "id": "IC-001",
        "claim": "the user wants X, not Y",
        "counterInterpretation": "the request may instead mean Y",
        "resolution": "why X is accepted",
        "evidenceRefs": ["conversation:...", "doc:..."]
      }
    ],
    "critic": {
      "agent": "lattice-intent-critic",
      "round": "2026-06-29T00:00:00.000Z",
      "result": "pass"
    }
  },
  "acceptanceContract": {
    "criteria": [
      {
        "id": "A1",
        "claim": "observable user-facing claim",
        "milestoneRefs": ["M1"],
        "evidenceType": "command_receipt",
        "verifier": "validate",
        "intentRefs": ["CHK-001:happy:0"]
      }
    ]
  },
  "verificationIntentBindings": [
    {
      "itemId": "CHK-001",
      "intentRef": "CHK-001:happy:0",
      "criterionId": "A1",
      "milestoneId": "M1",
      "lane": "happy"
    }
  ],
  "intentCoverageCheck": {
    "status": "pass",
    "uncoveredMilestones": [],
    "unconfirmedShrinkage": [],
    "checkedAt": "2026-06-29T00:00:00.000Z"
  },
  "redEvidence": {
    "required": true,
    "items": [
      {
        "id": "R1",
        "reason": "bug/regression/behavior-change requires a failing baseline",
        "command": "npm test -- tests/foo.test.ts",
        "expectedBefore": "fail",
        "observedBefore": "fail",
        "baselineHead": "abc1234",
        "receiptHash": "sha256:..."
      }
    ]
  },
  "spikeEvidence": {
    "required": true,
    "items": [
      {
        "id": "S1",
        "question": "which code path owns the behavior?",
        "filesInspected": ["src/foo.ts"],
        "finding": "the behavior is owned by foo()",
        "recommendedScope": ["src/foo.ts", "tests/foo.test.ts"],
        "disposable": true,
        "promotedToImplementation": false
      }
    ]
  },
  "scopeContract": {
    "allowedPaths": ["src/foo.ts", "tests/foo.test.ts"],
    "protectedPaths": ["migrations/**"],
    "dependencyPolicy": {
      "newDependenciesAllowed": false,
      "reason": "existing code path is sufficient"
    }
  },
  "riskClassification": {
    "level": "standard",
    "reasons": ["behavior_change"]
  },
  "minimalityCheck": {
    "noChangeNeededChecked": true,
    "existingCodeChecked": true,
    "stdlibOrNativeChecked": true,
    "existingDependencyChecked": true,
    "newAbstractionAllowed": false,
    "justification": "patch existing path directly"
  },
  "gate": {
    "status": "admit_dev",
    "checkedAt": "2026-06-29T00:00:00.000Z",
    "headHash": "abc1234",
    "materialHash": "sha256:...",
    "issues": []
  }
}
```

## Intent Critic / Collision

Intent collision is a PLAN-phase review of the interpretation, not of the
implementation. It should run after `understanding_set` and before red evidence,
spike, and verificationIntent are considered complete.

### Inputs

- raw request;
- current story title and description;
- `understanding_set` artifact;
- checklist draft, if present;
- related docs;
- user-provided constraints;
- known non-goals;
- risk signals.

### Required Questions

The intent critic must attempt to falsify the current interpretation:

- What else could the user mean by this request?
- Which interpretation would produce a different implementation?
- Which interpretation would produce a different red test?
- Which interpretation would produce a different spike path?
- Which user-visible outcome would prove the current interpretation wrong?
- What is explicitly out of scope?
- What question must be asked to the user if ambiguity remains?

### Output States

| State | Meaning | Gate effect |
|---|---|---|
| `pass` | Current interpretation is sufficiently grounded | Can continue |
| `revise_intent` | Understanding or acceptance needs revision | Block DEV |
| `human_gate` | User clarification is required | Block DEV |
| `stop` | Request is not justified or should not be implemented | Block DEV |

### Command Proposal

```text
intent_collision_start
intent_collision_record
intent_collision_resolve
intent_collision_set
intent_collision_get
```

MVP may reuse the existing `grill_*` planning commands as the conversation
container, but the gate-consumed collision result should be a separate signed
artifact. `grill.json` remains planning context; `intent-collision.json` is the
gate artifact.

## VerificationIntent Placement

`verificationIntent` remains checklist-scoped and is still authored in PLAN. The
new rule is that it must be downstream of intent collision:

```text
understanding_set -> intent_collision_set -> verificationIntent
```

This prevents the test intent from becoming the first interpretation of the user
request. It also gives the coverage reviewer a clearer contract: every
verification intent should map back to an accepted user-intent claim.

### Binding Rule

Every must-priority `verificationIntent` should bind to one acceptance criterion:

```text
verificationIntent.intentRef -> acceptanceContract.criteria[].id
```

The coverage reviewer then checks two links:

- `verificationIntent` is covered by `verificationEvidence`;
- `verificationIntent` is justified by `acceptanceContract`.

## Red Evidence

Red evidence proves the problem or behavior gap existed before the fix. It must
not be created before intent collision has passed, because a red test for the
wrong interpretation is misleading evidence.

### Required When

Red evidence is required for:

- bug fixes;
- regression fixes;
- behavior changes;
- test repairs;
- security/auth/session changes;
- performance or benchmark claims;
- any task whose value claim is "this was broken and is now fixed".

Red evidence is not required by default for:

- docs-only edits;
- copy edits;
- internal refactors with no behavior claim;
- new feature work where no previous failing behavior is claimed.

### Valid Red Evidence

Valid red evidence must include:

- command;
- baseline head or material snapshot;
- expected-before result;
- observed-before result;
- reason this red maps to the accepted intent;
- receipt or transcript digest.

### Invalid Red Evidence

Invalid examples:

- a failing command that does not map to the accepted user intent;
- a red test authored after implementation without a baseline binding;
- a test that fails because of environment setup rather than the target problem;
- a natural-language assertion without command or transcript.

## Spike Evidence

Spike evidence is disposable exploration used to answer uncertainty before DEV.
It must not silently become implementation.

### Required When

Spike evidence is required when:

- code path ownership is unknown;
- runtime behavior is unclear;
- the change crosses multiple modules;
- external API behavior is unknown;
- the minimal patch is not obvious;
- protected paths may be touched;
- a new dependency or abstraction is being considered.

### Spike Rules

- Spike work is read-only by default.
- Any temporary code must be discarded before DEV unless explicitly promoted.
- Promotion requires a recorded reason and scope update.
- Spike findings can inform scope and acceptance, but do not satisfy
  verificationEvidence.
- Spike output can classify a blocker, but a blocker-classification verdict does
  not count as a passing verification result.

### Command Proposal

```text
spike_start
spike_result_set
spike_discard
spike_promote
spike_get
```

## ProofStory Gate

The ProofStory gate is the hard boundary before DEV.

### Required Inputs

The gate must require:

- progressive intent hardening classification;
- original intent snapshot;
- milestone ledger for multi-deliverable requests;
- `understanding_set`;
- intent collision result when hardening policy requires collision;
- acceptance contract;
- intent coverage check;
- verificationIntent bindings;
- scope contract;
- risk classification;
- minimality check;
- red evidence when policy requires it;
- spike evidence when policy requires it.

### Gate Outputs

| Output | Meaning | Next step |
|---|---|---|
| `admit_dev` | Contract is sufficient | `story_advance -> DEV` may proceed |
| `revise_proofstory` | Contract is incomplete or inconsistent | Stay in PLAN |
| `human_gate` | User decision required | Stay in PLAN |
| `stop` | Work should not proceed | Discard or park story |

### Blocking Conditions

Block DEV when:

- no original intent snapshot exists;
- required artifacts for the selected progressive hardening level are missing;
- a multi-deliverable request has no milestone ledger;
- no accepted intent collision result exists when collision is required;
- acceptance criteria are not executable or inspectable;
- checklist items do not cover required milestone ledger items;
- required red evidence is missing;
- required spike evidence is missing or unresolved;
- scope is too broad;
- scope has been narrowed without a user-confirmed shrinkage decision;
- protected paths are required without approval;
- verificationIntent does not bind to acceptance criteria;
- minimality check is missing for high-risk or large-diff tasks;
- risk classification and required assurance path disagree.

## REVIEW Critic / Completeness Critic

REVIEW critic remains post-implementation. It does not replace the intent
critic. Its job is to ask what the implementation review missed:

- a fifth code path to the same sink;
- an unverified claim;
- a modality not run;
- an interaction between changes;
- stale or weak evidence;
- docs that promise more than the implementation delivers.

The existing REVIEW reviewer lanes continue to own the ledger evidence through
`review_run_start`, `finding_add`, and `review_pass_set`. The completeness critic
may be implemented first as an orchestration role that records confirmed
findings through an existing real reviewer lane, then later as a dedicated lane.

## Risk-Adaptive Assurance

Not every story should pay the same cost.

| Path | Applies to | Intent validation | Red evidence | Spike | REVIEW critic |
|---|---|---|---|---|---|
| Fast | docs-only, copy, low-risk small edits | Intent MVP | usually no | usually no | baseline REVIEW or none by policy |
| Standard | normal bug, feature, small refactor | Intent MVP plus triggered collision when ambiguity, user impact, behavior change, or multi-path interpretation exists | required when bug/regression/behavior-change | required when code path unclear | baseline REVIEW |
| High-assurance | auth, security, payment, migration, lifecycle gates, proof gates | independent intent collision required | required | required | completeness critic + escalation policy |

High-assurance stories should also be eligible for existing 3x2 / degraded 3x1
review escalation when the review-escalation policy triggers.

## Command Family

### New Commands

```text
original_intent_snapshot_set
original_intent_snapshot_get
milestone_ledger_set
milestone_ledger_add
milestone_ledger_get
intent_coverage_check
scope_shrinkage_decision_set
scope_shrinkage_decision_get
done_intent_equivalence_check

intent_collision_start
intent_collision_record
intent_collision_resolve
intent_collision_set
intent_collision_get

proofstory_contract_set
proofstory_contract_get
proofstory_gate_check

acceptance_contract_set
acceptance_criterion_add
acceptance_evidence_bind

red_evidence_create
red_evidence_validate
red_evidence_get

spike_start
spike_result_set
spike_discard
spike_promote
spike_get

minimality_check_set
minimality_alternative_record
risk_classify
assurance_level_set
```

The MVP should not add a standalone hardening command. The hardening level can
be derived by `proofstory_gate_check --dryRun`, stored in
`proofstory_contract_set`, and rendered by existing diagnostics. If a later
implementation needs an explicit command, it should be introduced only after the
observe/warn rollout proves the extra surface is useful.

### Existing Commands To Reuse

```text
story_create
story_draft
understanding_set
decision_set
checklist_update
testintent_handoff
story_review
review_run_start
finding_add
review_pass_set
validate
done_required_validate
summary_set
delivery_check_set
```

## Storage And Process Facts

New gate-consumed artifacts:

```text
.lattice/story/actives/<storyId>/intent-collision.json
.lattice/story/actives/<storyId>/proofstory.json
.lattice/story/actives/<storyId>/original-intent-snapshot.json
.lattice/story/actives/<storyId>/milestone-ledger.json
.lattice/story/actives/<storyId>/intent-coverage-check.json
.lattice/story/actives/<storyId>/scope-shrinkage-decision.json
.lattice/story/actives/<storyId>/done-intent-equivalence.json
.lattice/story/actives/<storyId>/red-evidence.json
.lattice/story/actives/<storyId>/spike.json
.lattice/story/actives/<storyId>/acceptance-contract.json
.lattice/story/actives/<storyId>/minimality-check.json
```

Every artifact consumed by a phase gate must be registered as a process fact and
covered by the process-fact contract tests. Prompt-only rules are not enough.

Required registry additions:

- command policies for new commands;
- phase allowlist entries;
- process fact levels for gate-consumed artifacts;
- static contract verification in the process-fact contract script;
- freshness / hash semantics where artifacts affect DEV admission.

## Milestones

### M0: Documentation And Vocabulary

Deliver:

- this execution plan;
- prompt vocabulary: "Story container", "Intent Collision", "ProofStory
  Contract", "Original Intent Snapshot", "Milestone Ledger", "Intent Coverage
  Check", "Scope Shrinkage Guard", "Progressive Intent Hardening", "Intent
  MVP", "Red Evidence", "Spike Evidence", "ProofStory Gate";
- updated guide text explaining that ProofStory is pre-DEV, not pre-intent.

Acceptance:

- docs state that intent validation starts from a minimum useful contract and
  hardens only when triggers require it;
- docs state that isolated keywords are not enough to create milestone intent;
- docs state that intent collision comes before red/spike;
- docs state that milestone coverage protects multi-deliverable user intent;
- docs state that REVIEW critic and intent critic are separate;
- docs do not claim ProofStory replaces REVIEW, TEST, or DONE evidence.

### M1: Original Intent Snapshot And Milestone Ledger

Deliver:

- `original_intent_snapshot_set`;
- `milestone_ledger_set`;
- `milestone_ledger_add`;
- immutable source request hash and key requirement ids;
- checklist-to-ledger reference diagnostics.

Acceptance:

- a single-outcome story can use Intent MVP without creating a milestone
  ledger;
- a request such as "complete this small typo fix" remains Intent MVP unless it
  has a structural multi-deliverable signal;
- a request with five milestones produces five machine-countable ledger rows;
- a checklist item can reference the milestone rows it delivers;
- a missing milestone reference is reported before DEV.

### M2: Read-Only Diagnostics

Deliver:

- `proofstory_gate_check --dryRun`;
- `intent_collision_get`;
- `proofstory_contract_get`;
- `intent_coverage_check --dryRun`;
- diagnostics that report missing intent collision, missing acceptance binding,
  missing milestone coverage, missing red evidence, missing spike evidence, and
  scope ambiguity;
- diagnostics that report the selected hardening level, trigger reasons, and
  would-block artifacts.

Acceptance:

- existing stories are not blocked;
- dry-run output explains exactly what would block a future DEV admission.

### M3: Intent Collision Artifact

Deliver:

- `intent_collision_set`;
- signed or hash-bound `intent-collision.json`;
- PLAN-only mutation policy;
- story_review advisory rendering.

Acceptance:

- a story with unresolved critical ambiguity reports `human_gate`;
- a story with accepted collision can proceed to the next ProofStory checks;
- corrupt or tampered collision artifacts fail closed when consumed.

### M4: ProofStory Contract And Gate

Deliver:

- `proofstory_contract_set`;
- `acceptance_contract_set`;
- `acceptance_evidence_bind`;
- `intent_coverage_check`;
- `proofstory_gate_check`;
- PLAN -> DEV gate integration behind warn mode first.

Acceptance:

- hardening level controls which artifacts are required;
- missing acceptance contract blocks in enforce mode;
- missing milestone coverage blocks in enforce mode;
- verificationIntent without acceptance binding is reported;
- scope contract and minimality check are included in the gate result.

### M5: Scope Shrinkage Guard And DONE Intent Equivalence

Deliver:

- `scope_shrinkage_decision_set`;
- `done_intent_equivalence_check`;
- TEST/DONE pre-check rows for milestone coverage and unconfirmed shrinkage;
- delivery-check integration that verifies docs promises against milestone rows.

Acceptance:

- narrowing a requirement requires explicit user confirmation;
- ordinary single-outcome DONE uses lightweight summary-to-snapshot equivalence;
- milestone, shrinkage, and high-assurance DONE use strict equivalence gating;
- a story cannot reach DONE when any required milestone lacks evidence;
- DONE summary cannot claim a narrower result than the original snapshot unless
  a shrinkage decision is confirmed.

### M6: Red Evidence

Deliver:

- `red_evidence_create`;
- `red_evidence_validate`;
- baseline head/material binding;
- transition relation to current green evidence.

Acceptance:

- bug-fix stories without required red evidence cannot enter DEV in enforce mode;
- docs-only stories are not forced to create red evidence;
- red evidence for the wrong acceptance criterion is rejected.

### M7: Spike Evidence

Deliver:

- `spike_start`;
- `spike_result_set`;
- `spike_discard`;
- `spike_promote`;
- disposable-code policy checks.

Acceptance:

- unresolved required spike blocks DEV in enforce mode;
- spike code cannot be silently carried into implementation;
- promoted spike findings update scope and are auditable.

### M8: REVIEW Completeness Critic Integration

Deliver:

- documented REVIEW critic orchestration in active prompts;
- optional `lattice-review-completeness` lane or MVP provenance through existing
  real reviewer lanes;
- gate behavior for critic-confirmed findings.

Acceptance:

- critic-confirmed findings reopen REVIEW;
- refuted critic findings are not written as blocking findings;
- reviewer evidence remains bound to reviewRunId and fresh material hash.

### M9: Risk-Adaptive Enforcement

Deliver:

- fast / standard / high-assurance policy;
- per-story assurance level;
- config flags for warn/enforce rollout.

Acceptance:

- low-risk docs-only story avoids unnecessary red/spike overhead;
- standard stories require intent collision only when ambiguity, user impact,
  behavior change, or multi-path interpretation triggers it;
- standard bug/regression/behavior-change stories still require red evidence;
- high-assurance stories require intent collision, red evidence, spike,
  stronger REVIEW critic, and applicable escalation policy.

## Verification Matrix

| Scenario | Expected result |
|---|---|
| Raw request with no understanding | DEV blocked |
| Single-outcome low-risk request | Intent MVP is sufficient; no milestone ledger required |
| "Complete this small typo fix" with no multi-deliverable structure | Intent MVP is sufficient; no milestone ledger required |
| Standard feature with clear single interpretation | Intent collision is not required by default |
| Request says "five milestones DONE" but ledger has four rows | DEV blocked |
| Ledger has five rows but checklist covers only four | DEV blocked |
| Collision is required but unresolved | DEV blocked |
| Intent collision passes but no acceptance contract | DEV blocked |
| Bug fix has acceptance contract but no red evidence | DEV blocked |
| New feature has no prior failing behavior claim | Red evidence not required by default |
| Unknown code path with no spike | DEV blocked for standard/high-assurance |
| verificationIntent has no acceptance binding | DEV blocked or warned during rollout |
| REVIEW critic finds missed path | REVIEW reopens |
| REVIEW critic finding is refuted | Finding is not stored as blocking evidence |
| DONE summary claims a narrower result than the original snapshot | DONE blocked unless shrinkage is user-confirmed |
| Scope is narrowed from full removal to main-path retirement | Human-confirmed scopeShrinkageDecision required |
| Docs-only fast path | Lightweight intent check, no forced red/spike |

## Migration Strategy

Roll out in three modes:

| Mode | Behavior |
|---|---|
| `observe` | Render diagnostics only; no gate blocks |
| `warn` | Gate reports would-block status but permits DEV |
| `enforce` | ProofStory gate blocks DEV when required evidence is missing |

Initial default should be `observe` or `warn`. Enforce should be enabled first
for high-assurance categories such as lifecycle gates, proof gates, auth,
security, payment, migration, and destructive operations.

Progressive hardening should roll out in the same order:

1. observe selected hardening level and missing artifacts;
2. warn when a story would need milestone, collision, red, spike, or DONE
   equivalence proof;
3. enforce only the triggered layer, not the full ProofStory surface for every
   story.

## Non-Goals

- Do not move REVIEW critic before DEV.
- Do not force every story into the full hardening path.
- Do not require milestone ledgers for ordinary single-outcome tasks.
- Do not make red evidence mandatory for all stories.
- Do not let spike evidence count as passing verificationEvidence.
- Do not let natural-language grill notes satisfy a gate by themselves.
- Do not create a second lifecycle state machine outside the Story lifecycle.
- Do not treat local ProofStory evidence as production completion.
- Do not allow checklist completion to replace original intent equivalence.
- Do not allow an agent to shrink user scope without explicit user confirmation.

## Final Target

Proofbound should present the lifecycle as:

```text
one-line request
  -> story container
  -> progressive intent hardening
  -> original intent snapshot
  -> milestone ledger when triggered
  -> intent-collided ProofStory
  -> evidence-bounded DEV
  -> critic-reviewed implementation
  -> validated TEST
  -> local DONE
```

The product claim is not "one-line to code". The product claim is:

```text
one-line to intent-collided ProofStory to evidence-gated DONE
```
