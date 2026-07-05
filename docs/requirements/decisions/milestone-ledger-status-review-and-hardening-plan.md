# Milestone Ledger Status Review And Hardening Plan

Status: document review plan
Created: 2026-07-05
Short name: Milestone Ledger Status Review
Primary review target: ProofStory milestone ledger and read-only milestone status

## Purpose

Review and harden the existing Proofbound milestone-ledger flow before opening
any broader implementation work.

The canonical Proofbound root already contains milestone-ledger and milestone
status surfaces:

- `milestone_ledger_set`
- `milestone_ledger_add`
- `milestone_ledger_get`
- `milestone_status`
- `milestone_closeout`

This plan is therefore not a from-scratch implementation plan. It is a
truth-first document review and hardening plan that checks whether the existing
implementation matches the intended safety boundary:

- status reporting stays read-only;
- milestone ledger writes stay explicit and pre-implementation;
- missing milestone ledgers block only where policy requires them;
- legacy or ordinary single-outcome stories are not retroactively broken;
- agents gain structured progress and handoff state without confusing
  milestone progress with lifecycle DONE.

## Current Implementation Inventory

The current codebase already has these implementation anchors:

| Surface | Current role |
|---|---|
| `packages/main/src/handlers/proofstory.ts` | Implements `milestone_ledger_set`, `milestone_ledger_add`, and `milestone_ledger_get`. |
| `packages/main/src/core/types.ts` | Defines `MilestoneLedgerData`, `MilestoneLedgerItem`, ledger state, and milestone status types. |
| `packages/main/src/handlers/milestone-status.ts` | Implements `milestone_status` and read-only argument-boundary checks. |
| `packages/main/src/core/milestone-status.ts` | Builds and renders grouped milestone status reports and missing-ledger diagnostics. |
| `packages/main/src/core/command-policy.ts` | Classifies ledger writes as story-scoped gate evidence and status reads as read-only. |
| `docs/requirements/decisions/proofstory-intent-collision-execution-plan.md` | Defines the broader ProofStory intent and milestone ledger contract. |

## Review Questions

The document review story should answer these questions before further
implementation:

1. Does the current read-only `milestone_status` boundary reject every
   mutation-like input before reading story facts?
2. Are `milestone_ledger_set` and `milestone_ledger_add` limited to the right
   lifecycle phases and ownership class?
3. Does missing-ledger behavior distinguish optional ordinary stories from
   milestone-triggered or opt-in stories?
4. Does the milestone ledger schema contain enough information for future
   progress reporting without inventing hidden sub-objectives?
5. Do current tests prove that status reporting does not create, repair,
   overwrite, or promote milestone facts?
6. Does any current path imply that milestone progress can satisfy Story DONE,
   Authority DONE, full Authority DONE, or production readiness?

## Non-Goals

The review story must not:

- implement new commands;
- rewrite ProofStory milestone contracts;
- change lifecycle gates;
- advance unrelated stories or bypass this review story's lifecycle gates;
- launch reviewers for implementation work;
- claim that milestone status replaces `lifecycle_check`, review assurance,
  validation, delivery checks, or DONE gates.

## Milestone Breakdown

This review plan has 8 milestones and 43 sub-objectives.

| Milestone | Title | Sub-objectives | Status | Output |
|---|---|---:|---|---|
| M0 | Review scope and source inventory | 5 | planned | trusted source map |
| M1 | Read-only status boundary review | 6 | planned | boundary finding or pass |
| M2 | Ledger write contract review | 6 | planned | write-surface finding or pass |
| M3 | Missing-ledger policy review | 6 | planned | missing-state matrix |
| M4 | Schema and progress-model review | 6 | planned | schema adequacy finding |
| M5 | Test and negative-control review | 6 | planned | test-gap list |
| M6 | Agent capability impact review | 4 | planned | capability claim boundary |
| M7 | Review outcome and next story decision | 4 | planned | pass/findings/follow-up story |

## M0. Review Scope And Source Inventory

Goal: establish the canonical facts before judging gaps.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M0.a | Confirm this review uses the canonical Proofbound root, not the retired Orchestrate root. | planned | `lattice session_brief` output |
| M0.b | Inventory command surfaces for milestone ledger and status. | planned | `rg` transcript |
| M0.c | Inventory source docs that define ProofStory milestone behavior. | planned | doc refs |
| M0.d | Inventory existing tests or smokes covering milestone ledger/status. | planned | test refs |
| M0.e | Record any stale or retired-root documents that should not drive implementation truth. | planned | review note |

Acceptance:

- reviewers agree on which source files and docs are authoritative;
- stale retired-root planning prose cannot override current code facts.

## M1. Read-Only Status Boundary Review

Goal: verify `milestone_status` is an observer, not a repair command.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M1.a | Check allowed argument keys for `milestone_status`. | planned | source review |
| M1.b | Verify unexpected keys fail before story reads. | planned | negative test or source proof |
| M1.c | Verify missing ledger produces a report, not a write. | planned | smoke or source proof |
| M1.d | Verify status output does not launch commands or reviewers. | planned | source review |
| M1.e | Verify status output does not write evidence, summaries, review passes, or lifecycle facts. | planned | source review |
| M1.f | Verify status output does not claim DONE or production readiness. | planned | output review |

Acceptance:

- `milestone_status` is confirmed read-only, or findings identify exact gaps.

## M2. Ledger Write Contract Review

Goal: verify ledger mutation is explicit, scoped, and phase-gated.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M2.a | Review `milestone_ledger_set` lifecycle phase policy. | planned | command policy |
| M2.b | Review `milestone_ledger_add` lifecycle phase policy. | planned | command policy |
| M2.c | Review ownership classification for ledger writes. | planned | command policy |
| M2.d | Review ledger hash and candidate/confirmed state behavior. | planned | source review |
| M2.e | Review whether direct writes can accidentally become confirmed gate evidence. | planned | source review |
| M2.f | Review whether existing rows can be silently overwritten in unsafe ways. | planned | negative test or finding |

Acceptance:

- ledger writes are explicit pre-implementation facts, not status-report side
  effects.

## M3. Missing-Ledger Policy Review

Goal: verify missing ledgers block only when required.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M3.a | Review ordinary single-outcome story behavior when no milestone ledger exists. | planned | fixture or source proof |
| M3.b | Review structural or semantic milestone trigger behavior. | planned | ProofStory diagnostics |
| M3.c | Review candidate versus confirmed ledger requirements. | planned | source review |
| M3.d | Review DEV admission behavior for missing required ledgers. | planned | gate/source review |
| M3.e | Review REVIEW/DONE behavior for incomplete or stale milestone facts. | planned | gate/source review |
| M3.f | Verify missing-ledger next actions are specific and non-mutating in status output. | planned | output snapshot |

Acceptance:

- missing-ledger behavior is neither too lax for milestone-triggered work nor
  too strict for ordinary legacy or single-outcome stories.

## M4. Schema And Progress-Model Review

Goal: verify the ledger can support honest progress reporting.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M4.a | Review required milestone fields: id, source requirement, claim, doneMeans, required evidence. | planned | type/source review |
| M4.b | Review checklist and verification-intent binding fields. | planned | type/source review |
| M4.c | Review status values and whether they are sufficient for progress tables. | planned | source review |
| M4.d | Review parent and assigned-child story support. | planned | source review |
| M4.e | Check that prose-only text cannot produce hidden detailed milestone claims. | planned | doc/source review |
| M4.f | Identify any schema additions needed for future grouped status reports. | planned | finding or pass |

Acceptance:

- the schema supports progress reporting without false precision.

## M5. Test And Negative-Control Review

Goal: verify unsafe behavior is covered by tests.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M5.a | Find tests for `milestone_status` read-only behavior. | planned | test refs |
| M5.b | Find tests for missing-ledger status reports. | planned | test refs |
| M5.c | Find tests for ledger set/add/get schema behavior. | planned | test refs |
| M5.d | Find tests for milestone-triggered missing-ledger gates. | planned | test refs |
| M5.e | Find tests proving milestone status cannot satisfy DONE by itself. | planned | test refs |
| M5.f | Record any missing negative controls as review findings. | planned | finding list |

Acceptance:

- either the existing test suite proves the boundary, or the review story opens
  concrete implementation follow-ups.

## M6. Agent Capability Impact Review

Goal: state the agent-development value without overclaiming.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M6.a | Confirm structured milestone rows improve progress reporting. | planned | doc review |
| M6.b | Confirm missing-ledger gates improve unattended execution safety. | planned | doc/source review |
| M6.c | Confirm ledger refs improve host handoff and restart continuity. | planned | doc review |
| M6.d | Confirm capability claims stop short of lifecycle DONE or Authority claims. | planned | doc review |

Acceptance:

- the capability impact is specific: better progress contract, safer execution
  admission, cleaner handoff, and less false DONE risk.

## M7. Review Outcome And Next Story Decision

Goal: close the document review with an explicit decision.

Sub-objectives:

| ID | Sub-objective | Status | Evidence needed |
|---|---|---|---|
| M7.a | Summarize all pass/finding outcomes. | planned | review summary |
| M7.b | Decide whether implementation work is needed or current implementation is sufficient. | planned | decision note |
| M7.c | If gaps exist, draft a narrow implementation story scope. | planned | story proposal |
| M7.d | If no gaps exist, mark the review as documentation-only completion. | planned | closure note |

Acceptance:

- the review produces either a clean pass or a bounded follow-up story, not an
  ambiguous implementation request.

## Agent Development Capability Impact

When the milestone-ledger/status boundary is correct, agent development gains a
stronger progress substrate:

- agents can report milestone progress from structured facts instead of chat
  memory;
- unattended execution can fail closed when required milestone intent is absent;
- handoffs between Codex CLI, Claude Code CLI, and Antigravity CLI have a shared
  milestone state to inspect;
- status reports can be useful without mutating workflow state;
- milestone completion remains distinct from lifecycle DONE, reducing false
  completion claims.

This strengthens agent autonomy, but only because it also strengthens stop
conditions. The capability is not "agents can declare themselves done"; it is
"agents can know what they are doing, explain where they are, and stop before
executing without required intent structure."

## Success Criteria

This review succeeds when:

- the canonical implementation inventory is recorded;
- the read-only report boundary is verified or specific gaps are filed;
- ledger write contracts are verified or specific gaps are filed;
- missing-ledger behavior is verified for ordinary, triggered, candidate, and
  confirmed cases;
- test coverage gaps are listed as concrete follow-ups;
- agent capability impact is documented without lifecycle overclaim.
