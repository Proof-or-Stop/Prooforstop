# Missing Scope Check Guidance Execution Plan

Date: 2026-06-12

## Purpose

This document defines an executable plan for a future Lattice CLI improvement:
make `missing_scope_check` failures more actionable when `story_review` blocks
PLAN progress because the story is missing PLAN scope evidence.

This is a documentation and execution-plan artifact only. It does not implement
the CLI change. It does not complete the future implementation story.

The plan is intentionally conservative:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Follow consistency of logic.

## Problem Statement

`scope_check_save` already exists. The missing capability is not a missing CLI
command.

The real observed problem is guidance/actionability:

- `story_review` can report `missing_scope_check`.
- The missing artifact is `scope-check.json`, the PLAN gate evidence produced by
  a scope reviewer through `scope_check_save`.
- Operators can misread the blocker as a content problem in the planned
  document or as a missing Lattice feature.
- The next action is not obvious enough: run a scope-plan review, then persist
  the reviewer result with `scope_check_save`.

The future implementation should make this failure state explain itself without
weakening the gate.

## Correct Mental Model

`scope_check_save` and `scope_contract_check` are related but different.

`scope_check_save` is PLAN gate evidence:

- it belongs before DEV;
- it records a reviewer-written scope assessment;
- it produces or updates the `scope-check.json` PLAN artifact;
- it lets `story_review` decide whether the story scope is understood and
  bounded enough to proceed.

`scope_contract_init_from_plan` and `scope_contract_check` are later lifecycle
guards:

- they protect DEV/REVIEW/TEST/DONE file and scope boundaries;
- they do not replace PLAN scope review;
- they should not be presented as the fix for `missing_scope_check`.

The future CLI guidance must preserve this distinction.

## Non-Goals

The future implementation must not:

- weaken the PLAN gate;
- bypass `story_review`;
- auto-generate a passing `scope_check_save` result;
- let the main implementation agent self-sign scope review evidence;
- treat a prompt, chat message, or free-form prose as gate evidence;
- convert `scope_contract_check` into a substitute for `scope_check_save`;
- claim Authority Server completion;
- set or imply `receiptVerified=true`, `authorityDone=true`,
  `productionDone=true`, or `fullAuthorityDone=true`;
- create a broad lifecycle assistant or general optimization framework;
- change unrelated review lanes, DONE gates, or Authority receipt semantics.

## Host-Neutral Boundary

This improvement is a Lattice CLI Non-authority ergonomics improvement.

The local CLI may provide:

- clearer `missing_scope_check` text;
- exact next-action commands;
- lane or reviewer hints;
- examples of valid `scope_check_save` payload shape;
- a reminder that scope evidence must be reviewer-written;
- links to relevant local docs.

The local CLI may not provide:

- Authority Server receipt proof;
- production gate approval;
- server-side proof that the scope review is accepted;
- a claim that an Authority Server has verified the story.

Authority completion remains receipt-backed. If a future Authority Server path
consumes PLAN scope evidence, that must be implemented as a separate
server-side contract with verified receipts. This document does not claim that
such Authority behavior exists.

## Future Implementation Plan

### Phase 1. Inspect The Existing Surfaces

Goal: identify the narrowest place to improve actionability.

Inspect only the surfaces that already produce or explain `missing_scope_check`:

- the `story_review` handler and PLAN gate failure builder;
- the scope check schema and `scope_check_save` handler;
- `session_brief` next-step rendering when a story is in PLAN;
- command help for `scope_check_save`;
- process-fact registry entries related to scope review evidence, if any;
- existing tests or smokes for PLAN review blockers.

The implementation story should record the exact touched files in its checklist.
If inspection shows the message is already generated in one canonical helper,
prefer changing that helper over adding duplicate wording elsewhere.

### Phase 2. Choose Narrow Touchpoints

Goal: update guidance consistently without inventing a new workflow.

Preferred touchpoints, in order:

1. the canonical `missing_scope_check` failure text;
2. `story_review` hint text when this blocker is present;
3. `session_brief` next step only if it already consumes PLAN blockers;
4. `scope_check_save --help` only if the help currently omits the PLAN gate
   relationship.

Avoid new command surfaces unless inspection proves existing surfaces cannot
express the next action.

The future implementation should keep the message factual:

```text
PLAN review is blocked because scope-check.json is missing. scope_check_save
exists; run a scope-plan reviewer and persist its result with scope_check_save.
The implementation agent must not self-sign this evidence.
```

If the CLI prints a command example, it should be a shape example, not a fake
passing review:

```bash
lattice scope_check_save \
  --storyId=B-xxxx \
  --features='[
    {
      "feature":"Explain missing_scope_check as missing PLAN evidence",
      "covered_by":["story_review missing_scope_check guidance"],
      "status":"covered",
      "excluded_by":[],
      "source":"story_review PLAN blocker"
    },
    {
      "feature":"Authority Server receipt-backed completion",
      "covered_by":[],
      "status":"excluded",
      "excluded_by":["out of scope for local CLI guidance"],
      "source":"Authority boundary"
    }
  ]' \
  --summary='{"total":2,"covered":1,"excluded":1,"gaps":0,"orphanSuspect":0,"drift":0}' \
  --openQuestions='[]'
```

The exact payload must match the current `scope_check_save --help` schema at
implementation time. Do not copy this illustrative shape blindly if the schema
has changed.

### Phase 3. Update Guidance Consistently

Goal: make the same facts appear wherever the operator sees the blocker.

The wording should consistently state:

- `scope_check_save` exists;
- the missing artifact is `scope-check.json`;
- the failure is a PLAN gate evidence blocker;
- the next actor is a scope-plan reviewer, not the main implementation agent;
- this does not weaken or skip the PLAN review;
- this is local CLI guidance, not Authority completion.

The guidance should avoid:

- saying "create scope-check.json manually";
- suggesting direct edits under story metadata paths;
- implying a reviewer pass can be invented from the main agent's own judgment;
- suggesting `scope_contract_check` as the fix;
- suggesting Authority Server proof exists.

### Phase 4. Add Tests And Smokes

Goal: prove the behavior change without broadening the lifecycle model.

Minimum verification:

- a unit or smoke test where `story_review` encounters missing scope evidence
  and emits the improved `missing_scope_check` guidance;
- a negative assertion that the guidance does not say or imply that the main
  agent may self-sign scope review;
- a negative assertion that the guidance does not claim Authority Server
  receipt verification or production completion;
- a command help or snapshot test if `scope_check_save --help` is changed;
- existing lifecycle tests still pass.

Recommended commands for the future story:

```bash
npm --prefix packages/main run build
npm --prefix packages/main test -- --runInBand
node packages/main/dist/cli.js story_review --help
node packages/main/dist/cli.js scope_check_save --help
```

If the repository has a targeted smoke for PLAN review blockers, use that
instead of adding a broad full-suite dependency. Do not create a fixture-only
proof if the changed surface is a CLI message path.

### Phase 5. Review

Goal: verify the implementation changed only the real correctness issue.

Reviewers must check:

- the message identifies the missing artifact as `scope-check.json`;
- the message says `scope_check_save` exists;
- the next action points to a reviewer-written scope check;
- no auto-generation or self-signing path was introduced;
- no gate was weakened;
- no Authority Server completion claim was added;
- wording remains consistent across `story_review`, `session_brief`, and help
  surfaces that were touched.

### Phase 6. TEST And DONE

Goal: complete the future implementation through normal Lattice lifecycle.

The future implementation story must:

- run `lattice validate`;
- refresh stale verification evidence if needed;
- complete REVIEW with reviewer-run evidence;
- complete delivery check;
- write summary;
- advance to DONE only after gates pass.

For high-risk or lifecycle/gate/process-fact changes, run the stronger
three-round two-host audit before DONE. For a very small annotation-compliance,
typo-only, or wording-only change, one two-host audit round may be enough if
the story is explicitly classified as low risk in `story-lifecycle.md` and does
not touch gate semantics.

## Two-Host Audit Protocol

The audit uses two host perspectives against the same artifact or implementation
diff. The hosts do not become Authority Server proof. They are local
Non-authority review evidence unless a separate receipt-backed Authority path is
run.

### Shared Audit Rules

Every round must enforce:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Follow consistency of logic.

Each host must separate:

- blocking correctness findings;
- non-blocking observations;
- rejected optimization suggestions;
- Authority boundary concerns.

### Claude-Style Host Prompt

```text
You are the Claude-style host reviewer for the same artifact/diff.

Audit only real correctness issues in the missing_scope_check guidance plan or
implementation. Do not optimize for optimization and do not optimize
arbitrarily. Enforce consistency of logic.

Check that:
- scope_check_save is treated as an existing command;
- scope-check.json is the missing PLAN evidence artifact;
- the main implementation agent cannot self-sign scope review;
- the PLAN gate is not weakened;
- scope_contract_check is not confused with scope_check_save;
- local CLI Non-authority guidance is not described as Authority Server proof;
- no receiptVerified, productionDone, authorityDone, or fullAuthorityDone claim
  is made without receipt-backed Authority Server evidence.

Return:
- PASS or BLOCKED;
- blocking findings with exact evidence;
- non-blocking observations;
- any suggestions rejected because they are arbitrary optimization.
```

### Codex-Style Host Prompt

```text
You are the Codex-style host reviewer for the same artifact/diff.

Audit the mechanical Lattice CLI correctness of the missing_scope_check
guidance plan or implementation. Do not optimize for optimization and do not
optimize arbitrarily. Only report real correctness issues. Follow consistency
of logic.

Check that:
- the changed surfaces are the narrowest necessary touchpoints;
- story_review/session guidance remains consistent with scope_check_save help;
- no handler path auto-creates passing scope-check.json evidence;
- tests or smokes cover the missing_scope_check message;
- negative tests or review checks protect against main-agent self-signing and
  Authority overclaim;
- local Non-authority evidence remains distinct from receipt-backed Authority
  Server proof.

Return:
- PASS or BLOCKED;
- blocking findings with file/line or command evidence;
- non-blocking observations;
- verification gaps;
- recommendations limited to real correctness issues.
```

## Audit Incorporation Rules

After the two-host audit:

- accept findings only when they identify real correctness issues;
- reject style-only or broad optimization requests unless they remove a real
  ambiguity in the lifecycle model;
- record rejected suggestions with a short rationale;
- update this document or the future implementation only for accepted findings;
- rerun the relevant verification command after every accepted change.

For this documentation story, accepted findings should be incorporated into this
document before it is handed to the Lattice execution flow.

### Accepted Audit Finding

The two-host audit found one blocking correctness issue: the original
`scope_check_save` example used an unsupported `agent` / `status` / `items` /
`excluded` shape. This document now uses the current `storyId` / `features` /
`summary` / optional `openQuestions` schema from `scope_check_save --help`.
No other blockers were reported, and the Non-authority / Authority Server
boundary remains unchanged.

## Verification Plan For This Document

For this document-only story:

```bash
git diff --check
rg -n "scope_check_save|scope-check.json|Authority|Non-authority|missing_scope_check|follow-up" \
  docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md
```

Checklist evidence should confirm:

- the document exists;
- it says `scope_check_save` exists;
- it identifies `scope-check.json` as the missing artifact;
- it excludes auto-generation and main-agent self-signing;
- it preserves the Non-authority / Authority Server boundary;
- it includes follow-up Lattice execution commands.

For the future implementation story:

```bash
npm --prefix packages/main run build
npm --prefix packages/main test -- --runInBand
lattice validate --story=B-xxxx --json
```

Add or replace targeted smoke commands after Phase 1 inspection identifies the
actual touched files.

## Rollback Plan

For this document-only story:

- revert only this document commit if the plan is rejected;
- do not delete or alter existing scope gate artifacts;
- do not modify CLI code as rollback, because this story does not modify CLI
  code.

For the future implementation story:

- revert the narrow guidance change if tests or review show the wording is
  misleading;
- preserve the existing PLAN gate behavior;
- remove only new tests tied to the reverted wording;
- do not remove `scope_check_save`;
- do not relax `story_review` blockers.

## Final Lattice Execution Handoff

This document does not implement the missing guidance improvement. It hands the
work to a future implementation story.

Proposed follow-up story intent:

```text
Improve missing_scope_check guidance ergonomics so story_review and related
operator surfaces explain that scope_check_save exists, scope-check.json is the
missing PLAN evidence artifact, and a scope-plan reviewer must persist the
review result without weakening gates or claiming Authority completion.
```

Example creation command:

```bash
lattice story_create '{
  "name":"scope-check-missing-guidance",
  "title":"Improve missing_scope_check guidance ergonomics",
  "description":"Make missing_scope_check PLAN blockers actionable by explaining that scope_check_save exists, scope-check.json is the missing PLAN evidence artifact, and the next action is reviewer-written scope_check_save evidence. Do not weaken PLAN gates, auto-generate evidence, or claim Authority Server completion.",
  "type":"chore",
  "priority":"high",
  "checklist":[
    {
      "title":"Inspect existing missing_scope_check and scope_check_save guidance surfaces",
      "context":"Identify the narrow canonical touchpoints for story_review blocker text, session guidance, and command help without changing gate semantics.",
      "relatedDocs":["docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md"]
    },
    {
      "title":"Implement narrow missing_scope_check guidance improvements",
      "context":"Update only the surfaces needed to explain scope-check.json, scope_check_save, reviewer-written evidence, and Non-authority boundaries.",
      "relatedDocs":["docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md"]
    },
    {
      "title":"Add targeted tests or smokes for the improved guidance",
      "context":"Cover the actionable message and negative cases for self-signing, gate weakening, and Authority overclaim.",
      "relatedDocs":["docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md"]
    },
    {
      "title":"Run review, validation, delivery, summary, and DONE closure",
      "context":"Complete the implementation through normal Lattice lifecycle and do not claim implementation completion before DONE.",
      "relatedDocs":["docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md"]
    }
  ],
  "background":"## Trigger Event\nA PLAN review blocker reported missing_scope_check. The command scope_check_save already exists; the missing artifact is scope-check.json. The user confusion is guidance/actionability, not missing CLI capability.\n\n## Key Insights\nPLAN scope evidence must remain reviewer-written and gate-consumed. Local CLI guidance is Non-authority and must not be described as receipt-backed Authority Server proof.\n\n## Solution Tradeoffs\nPrefer narrow wording and help updates over a new lifecycle assistant. Do not weaken gates or auto-generate evidence.\n\n## Conversational Texture\nThe user wants Lattice to execute this plan later, but this document itself is not the implementation."
}'
```

Then execute through the normal lifecycle:

```bash
lattice story_advance --storyId=B-xxxx --phase=INIT_CHECK
cd /Users/jek/Documents/Work/Orchestrate/.worktrees/B-xxxx
lattice story_advance --storyId=B-xxxx --phase=PLAN
lattice understanding_set '{...}'
lattice decision_set '{...}'
lattice scope_check_save '{... reviewer-written scope plan result ...}'
lattice story_review --storyId=B-xxxx
lattice story_advance --storyId=B-xxxx --phase=DEV
```

Implementation is not complete until the follow-up story reaches DONE through
Lattice REVIEW, TEST, delivery, summary, and final DONE gates.
