# Decision Doc Promotion Execution Plan

Date: 2026-06-14

## Purpose

This document defines an execution plan for a future Proof-or-Stop capability:
promote long-lived story decisions into project-level decision documents under
the canonical Proof-or-Stop path:

```text
docs/requirements/decisions/*.md
```

The capability is intentionally explicit and controlled. Proof-or-Stop should not
write every `decision_set` result into project docs. It should provide a
mechanical path for an operator, reviewer, or agent to say: this story decision
is no longer just local story evidence; it is now a durable project rule.

Once a decision document is created or updated under
`docs/requirements/decisions/*.md`, the change is governance/documentation
material for diagnostics and reviewer context. It does not by itself trigger the
local 3-round, 2-host DONE quorum; review escalation is required only when the
first lifecycle REVIEW round records at least two countable reviewer problems.

This is a planning artifact only. It does not implement the CLI change, add
commands, or authorize this story to edit source-code surfaces outside its
declared material scope.

## Problem Statement

Proof-or-Stop currently has two decision layers:

| Layer | Current artifact | Lifetime |
| --- | --- | --- |
| Story-scoped structured decision | `.proof-or-stop/story/actives/<storyId>/decision.json` | Evidence for one story |
| Project-level durable decision | `docs/requirements/decisions/*.md` | Long-lived project policy |

The gap is the promotion path between those layers.

Today, a story can record a good `decision.json`, but that decision may remain
buried in story metadata. Future developers then have to reconstruct durable
project rules from old story history. Conversely, manually creating a decision
doc creates governance and diagnostic material, but it does not by itself
trigger DONE 3x2 review escalation. Proof-or-Stop also does not help operators decide
when and how a story decision should become such a document.

The missing capability is not another free-form doc writer. The missing
capability is a controlled promotion workflow:

```text
decision_set
  -> decision_doc_proposal
  -> review / operator confirmation
  -> decision_doc_save
  -> docs/requirements/decisions/<slug>.md
  -> normal lifecycle gates; DONE 3x2 only if the first REVIEW round
     has at least two countable reviewer problems
```

## Design Principles

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix the real governance gap.
4. Follow consistency of logic.
5. Preserve the distinction between story evidence and project policy.
6. Treat decision-doc writes as high-impact workflow facts.
7. Never imply Authority Server receipt completion from local review-escalation
   quorum evidence.

## Target Capability

Add a first-class decision document promotion flow with two write commands and
one optional read command:

```text
decision_doc_proposal
decision_doc_save
decision_doc_preview  (optional read-only helper)
```

The proposal command records a durable-decision proposal inside the story.
The save command materializes an accepted proposal into the canonical decision
doc directory.

The save command is the only command in this plan that writes
`docs/requirements/decisions/*.md`.

## Non-Goals

The future implementation must not:

- automatically save every `decision_set` result as a decision doc;
- promote temporary implementation choices into durable policy without an
  explicit proposal;
- let `decision_doc_save` expand the story scope during DEV without scope
  contract `allowedCreate`/`allowedModify` coverage or a mechanically valid
  accepted/approved scope extension;
- create or update decision docs outside `docs/requirements/decisions/*.md`;
- bypass the review escalation DONE gate when the first-round problem threshold
  actually fires;
- weaken `story_review`, REVIEW, TEST, delivery-check, or DONE gates;
- let INIT reviewers expand story scope by writing decision docs;
- use prose-only review comments as review-escalation quorum evidence;
- treat local host output as Authority Server receipts;
- set or imply `receiptVerified=true`, `authorityDone=true`,
  `fullAuthorityDone=true`, or `productionDone=true`;
- silently overwrite existing decision docs;
- solve project-specific custom decision-doc paths in the first version.
- widen the current story's source-code scope; future implementation work
  requires its own story scope, checklist, review, and validation evidence.

## Canonical Path

First version supports only direct Markdown files under:

```text
docs/requirements/decisions/*.md
```

Examples:

```text
docs/requirements/decisions/session-ownership-and-write-leases.md
docs/requirements/decisions/lifecycle-gate-receipt-consumption.md
docs/requirements/decisions/decision-doc-promotion.md
```

Nested directories and alternate paths are out of scope for the first version.
If future projects need custom decision-doc paths, add an explicit
`proof-or-stop.config.json` setting in a separate story.

## Proposed CLI Surface

### `decision_doc_proposal`

Purpose: create or update a story-local proposal for a durable decision doc.

Example:

```bash
proof-or-stop decision_doc_proposal '{
  "storyId": "B-xxxx",
  "slug": "decision-doc-promotion",
  "title": "Promote long-lived story decisions into decision docs",
  "sourceDecision": "decision.json",
  "decision": "Long-lived project decisions must be promoted through a proposal/save flow before becoming decision docs.",
  "context": "Story-local decision.json is not discoverable enough for durable project policy.",
  "scope": "Applies to decisions that affect future Proof-or-Stop behavior, workflow gates, developer obligations, or project architecture.",
  "nonGoals": [
    "Do not auto-save every story decision",
    "Do not write outside docs/requirements/decisions/*.md",
    "Do not claim Authority Server completion"
  ],
  "chosenApproach": "Use an explicit proposal artifact and a separate save command.",
  "alternatives": [
    {
      "name": "Auto-save all decision_set artifacts",
      "pros": ["No extra command"],
      "cons": ["Pollutes long-lived docs", "Turns temporary choices into policy"]
    },
    {
      "name": "Manual docs only",
      "pros": ["Simple"],
      "cons": ["No structured promotion path", "Easy to forget durable decisions"]
    }
  ],
  "operationalRules": [
    "Promotion requires explicit operator or reviewer intent",
    "Saved docs must use the canonical decisions directory",
    "Saved docs are governance and diagnostic material, not automatic DONE 3x2 triggers"
  ],
  "verificationRequirements": [
    "Preview output must match the saved Markdown",
    "DONE escalation must depend on the first REVIEW round countable reviewer problem threshold",
    "Local quorum must remain separate from Authority receipt completion"
  ],
  "risks": [
    "Agents may over-promote temporary design choices",
    "Existing docs may be overwritten without enough review"
  ]
}'
```

Expected behavior:

- Requires an existing story.
- Requires an existing `decision.json` unless `sourceDecision` is explicitly
  set to `"manual"`.
- Requires the intended decision-doc target to be covered by the story scope
  contract: `allowedCreate` for new docs or `allowedModify` for updates. If the
  target doc is not covered, the story must use a mechanically valid
  accepted/approved scope extension before save.
- Validates `slug`, title, decision, context, scope, non-goals, chosen approach,
  alternatives, operational rules, verification requirements, and risks.
- Writes a story-local artifact, for example:

```text
.proof-or-stop/story/actives/<storyId>/decision-doc-proposals.json
```

- Does not write `docs/requirements/decisions/*.md`.
- Does not satisfy any DONE gate by itself.

### `decision_doc_preview`

Purpose: render the Markdown that would be written by a proposal.

This command is optional in the first implementation but useful for review.
It should be read-only.

Example:

```bash
proof-or-stop decision_doc_preview '{
  "storyId": "B-xxxx",
  "proposalId": "DDP-001"
}'
```

Expected behavior:

- Reads the proposal artifact.
- Renders the target Markdown to stdout.
- Reports the target path.
- Reports whether the target file already exists.
- Does not write files.
- Does not mutate story metadata.

### `decision_doc_save`

Purpose: materialize an accepted proposal into
`docs/requirements/decisions/<slug>.md`.

Example:

```bash
proof-or-stop decision_doc_save '{
  "storyId": "B-xxxx",
  "proposalId": "DDP-001",
  "mode": "create",
  "confirm": true,
  "expectedProposalDigest": "<reviewed proposalDigest>",
  "expectedSourceDecisionDigest": "<reviewed sourceDecisionDigest>"
}'
```

Expected behavior:

- Requires `confirm: true`.
- Requires a valid proposal.
- Requires non-blank `expectedProposalDigest` from the reviewed proposal and
  refuses save when it differs from the current proposal digest.
- For proposals sourced from `decision.json`, requires non-blank
  `expectedSourceDecisionDigest` from the reviewed source decision and refuses
  save when it differs from the current source decision digest.
- For manual-source proposals, refuses any supplied
  `expectedSourceDecisionDigest` because there is no `decision.json` anchor to
  review.
- Requires `mode: "create"` when the target file does not exist.
- Requires `mode: "update"` when the target file already exists.
- Refuses overwrite unless `mode: "update"` is explicit.
- Writes only:

```text
docs/requirements/decisions/<slug>.md
```

- Records a process event and story metadata linking:
  - story id;
  - proposal id;
  - target path;
  - source decision digest;
  - proposal digest;
  - rendered doc digest;
  - current HEAD and material hash.
- Verifies that the reviewed proposal digest and, when applicable, reviewed
  source decision digest are still fresh at save time. If `decision.json` or
  the proposal changed after review, the command must fail closed and ask for a
  refreshed proposal or explicit reviewer re-approval.
- Verifies that the target path is covered by the story scope contract
  (`allowedCreate` for creates or `allowedModify` for updates), or by an
  mechanically valid accepted/approved scope extension. The save command must
  not become a back door for expanding story scope during DEV.

The write itself does not complete the story. It changes a decision doc, so the
change is governance and diagnostic material for reviewers and status commands.
It does not by itself make DONE require 3x2; DONE escalation is required only
when the first lifecycle REVIEW round records at least two countable reviewer
problems.

## Proposal Artifact Shape

Suggested story-local artifact:

```ts
interface DecisionDocProposalFile {
  schemaVersion: 'lattice.decision_doc_proposals.v1';
  storyId: string;
  proposals: DecisionDocProposal[];
}

interface DecisionDocProposal {
  id: string;                 // DDP-001
  slug: string;               // lowercase kebab-case, no extension
  targetPath: string;         // docs/requirements/decisions/<slug>.md
  title: string;
  status: 'proposed' | 'saved' | 'superseded' | 'rejected';
  sourceDecision: 'decision.json' | 'manual';
  sourceDecisionDigest?: string;
  decision: string;
  context: string;
  scope: string;
  nonGoals: string[];
  chosenApproach: string;
  alternatives: Array<{
    name: string;
    pros: string[];
    cons: string[];
  }>;
  operationalRules: string[];
  verificationRequirements: string[];
  risks: string[];
  createdAt: string;
  updatedAt: string;
  savedAt?: string;
  savedCommit?: string;
}
```

## Generated Markdown Template

`decision_doc_save` should render a stable template:

```markdown
# <Title>

Status: accepted
Source story: B-xxxx
Source proposal: DDP-001
Created: YYYY-MM-DD

## Decision

<Decision>

## Context

<Context>

## Scope

<Scope>

## Non-Goals

- <Non-goal>

## Options Considered

### <Option name>

Pros:
- <Pro>

Cons:
- <Con>

## Chosen Approach

<Chosen approach>

## Operational Rules

- <Rule>

## Verification Requirements

- <Requirement>

## Risks

- <Risk>

## Supersession

If this decision changes, update this file through a Proof-or-Stop story. Because
this file is under `docs/requirements/decisions/*.md`, the edit is governance
and diagnostic material. DONE requires local review-escalation quorum only if
the first lifecycle REVIEW round records at least two countable reviewer
problems.
```

## Validation Rules

`decision_doc_proposal` must fail when:

- `storyId` is missing or unknown;
- the story lacks `decision.json` and `sourceDecision !== "manual"`;
- `slug` is empty, contains path separators, contains `..`, starts with a dot,
  or is not lowercase kebab-case;
- `title`, `decision`, `context`, `scope`, or `chosenApproach` is too short;
- `nonGoals` is empty;
- `alternatives` has fewer than two entries;
- an alternative lacks pros or cons;
- `operationalRules` is empty;
- `verificationRequirements` is empty;
- `risks` is empty.

`decision_doc_save` must fail when:

- `confirm !== true`;
- proposal id is missing or unknown;
- proposal status is `rejected` or `superseded`;
- `expectedProposalDigest` is missing, blank, or no longer matches the reviewed
  proposal;
- `sourceDecision === "decision.json"` and `expectedSourceDecisionDigest` is
  missing, blank, or no longer matches the reviewed source decision;
- `sourceDecision === "manual"` and `expectedSourceDecisionDigest` is supplied;
- source decision digest no longer matches the current `decision.json`, unless
  the proposal is refreshed and reviewed again;
- target path is outside `docs/requirements/decisions/*.md`;
- target path is not covered by the scope contract's `allowedCreate` or
  `allowedModify`, or by a mechanically valid accepted/approved scope
  extension;
- target file exists and `mode !== "update"`;
- target file does not exist and `mode !== "create"`;
- story phase is INIT reviewer context attempting to expand scope;
- git material state cannot be read;
- the command would write any file other than the target decision doc and its
  story-local metadata.

## Lifecycle And Gate Interaction

The promotion flow must reuse the existing Proof-or-Stop lifecycle.

Expected lifecycle:

```text
PLAN:
  - story records decision_set
  - story records decision_doc_proposal when needed
  - story scope contract covers the intended decision-doc path in
    `allowedCreate` or `allowedModify`, or a mechanically valid
    accepted/approved scope extension is in place

DEV:
  - implementation may call decision_doc_save
  - target decision doc is created or updated
  - save refuses paths not covered by the scope contract or a mechanically valid
    accepted/approved scope extension

REVIEW:
  - reviewers inspect the generated doc
  - reviewers check whether promotion is justified

TEST:
  - proof-or-stop validate checks verification coverage and evidence freshness

DONE:
  - decision-doc changes remain visible as governance/diagnostic material
  - DONE requires 3 distinct rounds x 2 independent PASSing hosts only when
    the first lifecycle REVIEW round has at least two countable reviewer
    problems for the current material
```

This plan must not add a second quorum implementation. It should consume the
unified review-escalation evaluator for DONE enforcement and keep any
decision-doc change detector read-only for diagnostics and migration reporting.

## Process Fact Contract

Because the save command writes durable project policy, it is a process fact.
Because the proposal is consumed by the save command, it must also be treated
as a signed or digest-bound workflow artifact rather than ordinary memory.

Required registry updates in the implementation story:

- `COMMAND_POLICIES`
  - `decision_doc_proposal`: metadata-write, story-scoped, allowed in PLAN/DEV.
  - `decision_doc_preview`: read-only, all phases.
  - `decision_doc_save`: gateEvidence, story-scoped mutating, allowed in DEV.
- `PROCESS_FACT_LEVELS`
  - proposal: L4 if `decision_doc_save` consumes it to write durable project
    policy; otherwise the save handler must not trust it as gate evidence.
  - save: L4, category `decision-doc-promotion`, visible to diagnostics and
    reviewers; it must not make the changed file an always-on quorum trigger.
- `process-fact-registry`
  - register proposal artifact if introduced, including digest/freshness
    semantics and the save-command consumer.
  - register save command semantics and artifact relationship.
- `scripts/verify-process-fact-contract.mjs`
  - assert command policy, process fact level, owner, artifact semantics, and
    Authority boundary text.

Authority boundary:

- `decision_doc_save` is local workflow evidence only.
- It does not create Authority Server receipts.
- It does not set `authorityDone`, `fullAuthorityDone`, or `productionDone`.

## Reviewer Checklist

Reviewers should verify:

- The proposed decision is actually long-lived project policy.
- The proposal is not just implementation detail.
- Scope and non-goals are explicit.
- The target decision-doc path is covered by the scope contract's
  `allowedCreate`/`allowedModify` or a mechanically valid accepted/approved
  scope extension before save.
- The proposal digest and source decision digest are fresh at save time.
- Alternatives include real cons, not ceremonial alternatives.
- Operational rules are executable by future developers.
- Verification requirements are explicit enough for a future story to test.
- Generated Markdown is clear enough to be read without story history.
- The save command wrote only the canonical decision doc path.
- The saved decision doc is treated as governance and diagnostic material, not
  as an automatic DONE 3x2 trigger.
- Local host verdict quorum is not described as Authority receipt completion.

## Implementation Phases

### Phase 1. Inspect Existing Decision And Doc Surfaces

Inspect:

- `decision_set` / `decision_get` handlers;
- story store read/write conventions;
- command policy and phase tools;
- diagnostic decision-doc change detector;
- story lifecycle docs;
- process fact registry and verifier script;
- existing docs execution-plan style.

Output:

- exact file touchpoints;
- command schemas;
- proposal artifact path;
- risks for phase permissions and owner lease.

### Phase 2. Add Proposal Artifact And Renderer

Implement:

- proposal schema and validators;
- slug normalization and path validation;
- proposal id allocation;
- Markdown renderer;
- read-only preview function if included.

Tests:

- valid proposal writes story-local artifact;
- invalid slug refused;
- missing decision refused unless manual source is explicit;
- proposal stores source decision digest and proposal digest;
- proposal with empty verification requirements is refused;
- renderer output is deterministic.

### Phase 3. Add Save Command

Implement:

- `decision_doc_save` handler;
- strict target path enforcement;
- create/update mode checks;
- process event recording;
- metadata update after save;
- no arbitrary file writes.

Tests:

- create new decision doc;
- refuse overwrite without `mode: "update"`;
- refuse path traversal;
- refuse non-canonical directory;
- refuse a target path outside scope contract `allowedCreate`/`allowedModify`
  and without a mechanically valid accepted/approved scope extension;
- refuse missing, blank, or stale reviewed proposal/source-decision digest
  anchors;
- save marks proposal saved.

### Phase 4. Wire CLI, Policy, And Registry

Update:

- CLI schemas and help text;
- registry command mapping;
- phase command availability;
- command ownership contract;
- process fact registry;
- process fact contract verifier.

Tests:

- `proof-or-stop decision_doc_proposal --help`;
- `proof-or-stop decision_doc_save --help`;
- command ownership smoke;
- process fact contract verifier.

### Phase 5. Gate Integration Regression

Do not add a new DONE gate. Instead prove that saved decision docs flow through
the unified review-escalation policy and do not create an always-on quorum
trigger.

Tests:

- save a decision doc in a fixture story;
- confirm changed files include `docs/requirements/decisions/<slug>.md`;
- confirm DONE is not blocked solely because the decision doc changed;
- confirm DONE is blocked without fresh 3x2 host verdict quorum only when the
  first REVIEW round has at least two countable reviewer problems;
- confirm DONE passes after valid quorum when that escalation trigger fired;
- confirm stale digest, duplicate host, duplicate round, non-pass decision, and
  prose-only review pass do not satisfy quorum.

### Phase 6. Documentation And Operator Guidance

Update docs to explain:

- `decision_set` is story-local evidence;
- `decision_doc_proposal` is a controlled promotion request;
- `decision_doc_save` writes durable project policy;
- saved decision docs are governance and diagnostic material; they do not by
  themselves trigger DONE 3x2;
- not every decision should become a decision doc.

Potential docs:

- `docs/requirements/decisions/story-lifecycle.md`;
- `docs/requirements/decisions/lifecycle-gate-receipt-consumption.md`;
- a new or updated decision-doc promotion document.

## Test Plan

Minimum tests for the implementation story:

- Happy path: `decision_set` -> proposal -> preview -> save -> doc exists.
- Edge: no `decision.json` and no manual source -> refused.
- Edge: target exists with `mode: "create"` -> refused.
- Edge: target missing with `mode: "update"` -> refused.
- Edge: proposal was reviewed but `decision.json` changed before save ->
  refused until refreshed.
- Edge: `decision_doc_save` omits or blanks `expectedProposalDigest` -> refused.
- Edge: `decision_doc_save` omits `expectedSourceDecisionDigest` for a
  `decision.json` proposal -> refused.
- Adversarial: slug with `../` -> refused.
- Adversarial: path outside `docs/requirements/decisions/*.md` -> refused.
- Adversarial: target path not covered by scope contract `allowedCreate` /
  `allowedModify` or a mechanically valid accepted/approved scope extension ->
  refused.
- Adversarial: proposal with empty non-goals -> refused.
- Adversarial: proposal with empty verification requirements -> refused.
- Adversarial: only one alternative with no cons -> refused.
- Regression: `decision_set` alone does not write a decision doc.
- Regression: `decision_doc_proposal` alone does not write a decision doc.
- Gate: `decision_doc_save` does not by itself make DONE require 3x2; DONE
  escalation still depends on the first lifecycle REVIEW round having at least
  two countable reviewer problems.
- Authority boundary: local save/quorum cannot set Authority or production
  completion fields.

## Rollout Plan

1. Implement behind normal CLI command availability, not a feature flag.
2. Keep first version path-fixed to `docs/requirements/decisions/*.md`.
3. Ship with command help that warns against over-promotion.
4. Let the unified review-escalation gate enforce multi-host review only when
   the first REVIEW round countable-problem threshold fires.
5. After usage stabilizes, consider a separate story for configurable
   decision-doc directories.

## Shipped Decisions

- `decision_doc_proposal` is allowed in PLAN and DEV because proposal refreshes
  may be needed after implementation discoveries.
- `decision_doc_save` requires `confirm:true`, a reviewed
  `expectedProposalDigest`, and, for `decision.json` proposals, a reviewed
  `expectedSourceDecisionDigest`. It does not require a separate scope-plan
  reviewer acknowledgement; scope is enforced through the scope contract or a
  mechanically valid accepted/approved scope extension.
- Updates to an existing decision doc are guarded by explicit `mode:"update"`;
  the first shipped version does not require a separate `supersession` field.
- Proposal artifacts are L4 digest-bound process facts registered for
  `decision_doc_save` consumption. They are not cryptographically signed.
- `decision_doc_preview` is an optional read-only convenience command. Save
  freshness is anchored by the reviewed proposal/source digests, not by a
  mandatory preview event.

These are implementation choices. The core requirement is stable: durable
project decisions need an explicit promotion path, and saved decision docs must
remain governance and diagnostic material unless the first REVIEW round
countable-problem threshold triggers 3x2 review escalation.

## Acceptance Criteria

The future implementation is complete when:

- developers can create a story-local decision-doc proposal from a story
  decision;
- developers can preview the generated Markdown;
- developers can save the proposal only into
  `docs/requirements/decisions/*.md`;
- invalid paths and accidental overwrites are refused;
- target paths outside PLAN scope or accepted scope extension are refused;
- stale proposal/source-decision digests are refused;
- saved decision docs remain diagnostic/governance material; DONE escalation
  still depends on the first-round countable reviewer problem threshold;
- process fact registry and contract verifier cover the new commands;
- tests cover happy, edge, adversarial, and gate integration cases;
- docs explain when to promote a decision and when not to;
- local workflow evidence remains explicitly separate from Authority Server
  receipts and production completion.
