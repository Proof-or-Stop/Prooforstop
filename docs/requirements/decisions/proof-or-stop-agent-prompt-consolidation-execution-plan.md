# Proof-or-Stop Agent Prompt Consolidation Execution Plan

**Status:** proposal / execution plan
**Scope:** canonical agent prompt templates under `packages/main/templates/agents/*.md`
**Origin:** manual audit of the current 16 Proof-or-Stop agent prompts and the
current lifecycle contract (`INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST
-> DONE`).

This document is a planning artifact. It is not gate evidence, not proof that
the prompt refactor has been implemented, and not a basis for relaxing review,
verification, delivery, or DONE requirements.

## Problem Statement

Proof-or-Stop currently exposes 16 agent prompt templates, but their role
boundaries have drifted across lifecycle generations:

- Some prompts still describe the legacy `testIntent` / `TEST_CASE_REVIEW`
  flow, while the current flow uses `verificationIntent` and
  `verificationEvidence`.
- Several reviewers independently perform the same
  `doc-promise-undelivered` reverse check, creating duplicate finding risk.
- Some prompts directly reference or edit story files under `docs/story/...`,
  which conflicts with the current CLI-mediated story artifact discipline.
- Some reviewers duplicate work now handled by CLI gates, especially channel
  validation and concept residue scanning.
- Product, delivery, evaluator, behavior, and implementation reviewers overlap
  without a single ownership rule for "user value closed" versus "behavior
  correct" versus "delivery promises verified".
- One active evaluator prompt (`proof-or-stop-evaluator-cli`) does not include the
  same load-bearing runtime guide as the other core prompts.

The goal is to make the 16 prompts easier for agents to drive correctly without
weakening any process fact, evidence, reviewer, or DONE gate.

Naming note: all canonical agent role IDs in the target state use the
**`proof-or-stop-*` prefix**. Current package filenames, host shims, reviewer
lanes, and in-flight evidence may still contain legacy role IDs such as
`lattice-*`, `product-reviewer`, `implementation-reviewer`, `test-intent`, or
`test-case-reviewer` until the implementation migration lands. Those names are
treated as transitional aliases only. CLI commands such as `lattice validate`
and `lattice agent_prompt` remain command names and are not renamed by this
document.

## Three-Host Review Consensus

Codex CLI, Claude Code CLI, and Antigravity CLI (`agy`) reviewed the prior plan
from independent angles. The common verdict was **pass-with-changes**: the plan
is directionally correct, but several facts must become implementation
requirements instead of prose intentions.

Consensus blockers folded into this revision:

- The `proof-or-stop-*` rename cannot be documentation-only. The migration must
  update or alias prompt registry entries, template filenames/frontmatter, host
  shims, Codex manifests, reviewer lane parsing, review-run signatures, quorum
  consumers, and process-fact registry entries.
- `proof-or-stop-product-reviewer` cannot be folded or downgraded until the INIT
  gate contract that currently expects product-style review output is migrated
  or proven obsolete.
- `init-self-check.json` is treated as a possible fresh-context / anti
  self-exemption fence. If removed from prompt instructions, an equivalent
  CLI-mediated signed artifact must preserve the same gate semantics.
- Evaluator output must be decided early: raw JSON is advisory only, while the
  existing `evaluate_save` / `eval-evidence.json` path is the only current
  structured evaluator sink unless a later story deliberately replaces it.
- DEV evidence writes must have one canonical path. New prompts should prefer
  `verification_evidence_add`; `checklist_update verificationEvidence` is
  compatibility behavior unless the CLI policy says otherwise.

## Evidence-Based Assessment Of Follow-Up Suggestions

The follow-up recommendations are useful, but they should not be applied
verbatim. The table below records the project evidence used for this revision
and the resulting judgment.

| Suggestion | Project evidence | Judgment for this plan |
|---|---|---|
| Split gates into hard gates, reviewer gates, and advisory lanes. | `packages/main/src/core/machine.ts` has phase guards for INIT_CHECK, DEV entry, REVIEW entry, REVIEW->TEST, and DONE. `packages/main/src/handlers/transition-orchestrator.ts` additionally runs REVIEW->TEST CLI preflight, `lattice validate`, and DONE pre-merge gates. | Accepted with correction: do not list only four hard gates. DEV->REVIEW is also a hard checklist/evidence gate. |
| Treat reviewer output as lane-scoped only after `review_run_start`. | `packages/main/src/core/review-run.ts` restricts `REVIEW_RUN_LANES`; `packages/main/src/handlers/finding.ts` only treats `agent.startsWith('lattice-review-')` as reviewer evidence; `packages/main/src/core/reviewer-quorum.ts` maps active reviewers to lanes. | Accepted. This is exactly why M0.5 must normalize role IDs across review-run, finding/pass, quorum, and process-fact readers before new prompt writes. |
| Keep evaluator/product/implementation advisory unless they have a structured sink. | `packages/main/src/handlers/evaluate.ts` already has `evaluate_save`, and `packages/main/src/core/done-oracle.ts` consumes `eval-evidence.json` when workflow policy requires evaluator evidence. `proof-or-stop-product-reviewer` is required by INIT via `REQUIRED_INIT_CHECK_AGENTS` in `packages/main/src/core/init-check-gate.ts`. `proof-or-stop-implementation-reviewer` is not in `REVIEW_RUN_LANES`. | Partially accepted. Raw evaluator JSON remains advisory; `evaluate_save` evidence can be gate-consumed by policy. Product reviewer cannot be downgraded until INIT is migrated. Implementation reviewer should be folded/retired for Proof-or-Stop rather than kept as a third code-review lane. |
| Add artifact schema / writer / reader / freshness table. | `packages/main/src/cli/command-schemas.ts`, `packages/main/src/handlers/checklist.ts`, `packages/main/src/handlers/delivery-check.ts`, `packages/main/src/core/evidence-freshness.ts`, and `packages/main/src/core/delivery-check-hash.ts` already define real fields and freshness behavior. | Accepted. The plan now documents current writer/reader/freshness contracts and marks gaps where implementation must harden them. |
| Split M0.5/M1/M2/M3/M4 into smaller rollback points. | M0.5 touches registry, host adapters, review-run lanes, process-fact registry, and in-flight evidence readers. M4 touches direct file access, CLI read APIs, writers, INIT self-check, channel retirement, and static scans. | Accepted. The plan now requires read-path aliasing before canonical writes, and direct-write bans before read replacement / INIT self-check changes. |
| Add alias sunset policy. | `packages/main/src/handlers/agent-prompt.ts` currently exact-matches template basenames; `packages/main/src/core/prompt-registry.ts` uses filename-derived `agentId`; process-fact registry still lists legacy lanes. | Accepted. Compatibility is read-only/legacy-write-forbidden and must have a removal condition. |
| Move speed metrics earlier than M9. | `packages/main/src/handlers/reviewer-list.ts` computes baseline reviewers and routing reasons today; M3/M6/M8 can measure reviewer count and full-scan decisions before E2E rollout. | Accepted. M1/M3/M6/M8 now include measurable speed/routing exit criteria, with M9 retaining final comparison. |
| Add a bounded search / memory budget before broad spec scans. | Current `session_brief` renders Memory Runtime Preflight as `authority=non_authoritative` and `gateEvidence=false`; this story's 3x2 review also recorded that an initial in-repo Codex run was interrupted for over-broad scanning. M6 already narrows full decisions-directory scans. | Accepted with boundary. Memory/playbook preflight is advisory only; agents must build a `candidateSpecSet` before broad scan; full `decisions/*.md` scan remains available only as a recorded escalation path. |

## B-2861 3x2 Review Follow-Up Ledger

This section records the explicit 3x2 review requested for the large document
change. The three hosts were Codex CLI, Claude Code CLI, and Antigravity CLI
(`agy`), each covering two lenses. These review outputs are design input, not
gate evidence; accepted items below are folded into this document only when
they are supported by current project code or CLI documentation.

| Host | Lens A | Lens B | Review status | Limitation |
|---|---|---|---|---|
| Codex CLI | Gate/process/evidence admissibility. | Agent-role isolation, naming, and overlap. | Completed from a prepared local evidence pack after an initial in-repo Codex run was interrupted for over-broad scanning. | Evidence pack cited exact current code facts; it did not write story artifacts or inspect additional files. |
| Claude Code CLI | Product/workflow UX. | Feasibility, scope, and consolidation risk. | Completed read-only against the worktree and current code references. | Produced advisory findings; final acceptance remains this document's owner responsibility. |
| Antigravity CLI (`agy`) | Execution-table completeness. | Parallel development and performance. | Completed read-only against the worktree and current code references. | Some "block" labels were reclassified as future implementation constraints because this story is document-only. |

| Optimization / finding | 3x2 source | Decision | Applied document change | Reason and evidence |
|---|---|---|---|---|
| Name the exact reviewer-lane prefix risk instead of saying "readers" generically. | Codex A/B, Claude B, Agy B. | Accepted. | M0.5 now calls out `REVIEW_RUN_LANES`, `isReviewerAgent`, `resolveReviewRunLane`, and the mirrored `agent.startsWith('lattice-review-')` classification. | `packages/main/src/core/review-run.ts` currently accepts only `lattice-review-*` lanes; missing this predicate would make new `proof-or-stop-*` reviewer writes inadmissible. |
| Add INIT required-agent normalization to the rename scope. | Codex A, Claude B, Agy B. | Accepted. | M0.5 and artifact tables now include `REQUIRED_INIT_CHECK_AGENTS` / `init-check-gate.ts`. | `packages/main/src/core/init-check-gate.ts` currently requires `lattice-review-story-init` and `product-reviewer`; product reviewer cannot be folded before this is migrated. |
| Clarify retired channel reviewer behavior. | Claude B, Codex B. | Accepted. | Channel is now explicitly legacy-read-compatible during the alias window, not an active route or new-write lane. | `lattice-review-channel` is still in `REVIEW_RUN_LANES`; removing routing without read compatibility could break in-flight evidence. |
| Align planning ledger state with the real milestone UX. | Claude A, Codex A. | Accepted. | The milestone vocabulary now uses the six UX row states from `milestone_status`; prompt routing status is separated from milestone row status. | `docs/CLI.md` defines Done, In Progress, Pending Review, Not Started, Blocked, and Failed; the prior `not_applicable` planning state had no renderer contract. |
| Clarify progress UX for reviewer pass/finding changes. | Codex A, Agy A. | Accepted with scope boundary. | Mandatory Progress UX now says `finding_add` / `review_pass_set` are not currently auto-appended and require either host follow-up or a later CLI auto-append/status aggregation story. | `packages/main/src/cli-engine.ts` auto-appends milestone status for checklist/evidence/story/delivery/summary commands, not reviewer pass/finding commands; `milestone_status` reads story/checklist/ledger/summary. |
| Add DONE-required evidence to final-gate contracts. | Agy A. | Accepted. | Artifact schema and delivery contract now mention `done_required_validate` / `done-required-evidence.json` when project policy configures DONE-required commands. | AGENTS and CLI docs require fresh DONE-required evidence only when `doneRequiredCommands` / policy are configured; prompts must not invent it otherwise. |
| Treat `scope-check.openQuestions` as non-tamper-evident until hardened. | Codex B, Agy A. | Accepted as warning; code change deferred. | The scope artifact row now says prompts must not rely on unsigned `openQuestions` as tamper-evident blockers unless resolved through a structured command or signature-domain update. | `scope-check.ts` passes `openQuestions` through outside the signature domain; process-fact registry records that choice. |
| Split M0.5 into smaller, rollback-safe implementation stories. | Claude A, Agy B. | Accepted. | Added a story breakdown and parallel execution plan with 26 recommended stories and explicit serial/parallel boundaries. | M0.5 touches registry, host shims, review-run lanes, init gate, process-fact registry, and legacy evidence readers; one giant story would be hard to review or revert. |
| Add bounded search / memory budget for broad scans. | User follow-up, owner analysis. | Accepted. | Added a Search / Memory Budget Contract and expanded M6 around `candidateSpecSet`, full-scan escalation reasons, and token/search metrics. | Memory Runtime Preflight is explicitly non-authoritative and not gate evidence; over-broad scanning was already observed as a review execution risk. The plan now keeps full scan as an escalation path instead of a default. |
| Immediately update runtime code in this story. | Agy A/B. | Rejected for this story. | No runtime code changes are included here. | B-2861 scope is a document review and optimization story; code changes belong in the later implementation stories described by the plan. |

## Design Principles

- Keep one canonical prompt body source: `packages/main/templates/agents/*.md`.
- Separate lifecycle lanes by phase: INIT, PLAN, DEV, REVIEW, TEST, DONE.
- Assign each repeated check to one owner prompt or one CLI gate.
- Prefer CLI gates for mechanical facts; prompts should route to gates and
  record structured evidence, not re-implement gate logic in prose.
- Keep legacy prompts available only when they are explicitly marked legacy or
  migrated to the current verification model.
- Avoid direct story-file reads/writes in prompts where a CLI command exists.
- Make reviewer output machine-consumable: `review_run_start`,
  `finding_add`, `review_pass_set`, `scope_check_save`, `init_check_set`, or
  `delivery_check_set` as appropriate.
- Do not treat prompt text as evidence. Gates consume structured facts.

## Gate Tier Model

The gate model is three-tiered, but the hard-gate set is derived from the
current machine and transition code rather than from prompt prose.

| Tier | What belongs here | Current code evidence | Rule |
|---|---|---|---|
| Hard lifecycle gates | INIT->INIT_CHECK, DEV entry, DEV->REVIEW, REVIEW->TEST, TEST->DONE. | `core/machine.ts` `getGuardFailureReason`; `handlers/transition-orchestrator.ts` phase gate calls; `core/done-oracle.ts` DONE checklist rows. | These gates consume CLI/store facts only. Prompt text, raw transcripts, and free-form summaries cannot satisfy them. |
| Reviewer gates | Current-round reviewer findings/passes bound to `review_run_start`. | `core/review-run.ts`, `handlers/finding.ts`, `core/reviewer-quorum.ts`. | A finding/pass counts only for its normalized lane and current signed review run. |
| Advisory or policy-gated lanes | Raw evaluator JSON, product review prose, implementation-review prose, medium/low INIT issues, routing hints. | `handlers/evaluate.ts` raw `evaluate` is L0; `evaluate_save` is L4; `core/init-check-gate.ts` distinguishes required agents and blocking severities. | Advisory outputs may guide humans. They become gate evidence only through an explicit structured writer and policy consumer. |

## Mandatory Progress UX Contract

Every human-facing state change must show the user the current progress view.
This is a host/CLI output contract, not a per-agent hand-rendering duty.

Current code-backed evidence:

- `lattice milestone_status` is an L0 read-only progress projection over the
  existing milestone ledger, checklist, verification intent/evidence, story
  phase, and summary facts.
- The CLI already auto-appends the rendered milestone status table after
  configured story-scoped mutating commands that update milestone ledgers,
  checklist state, verification evidence, story phase, delivery checks, or
  summaries.
- Current reviewer commands (`finding_add`, `review_pass_set`, and
  `review_run_start`) are **not** in the auto-append set, and the current
  `milestone_status` projection does not read findings or review passes
  directly. If reviewer pass/finding changes must become mandatory progress UX,
  a later implementation story must either add those commands to the append set
  and/or aggregate reviewer state into the status projection.
- The rendered UX has six user-facing row states: Done, In Progress, Pending
  Review, Not Started, Blocked, and Failed.
- Standalone `lattice milestone_status` with no `milestone-ledger.json` renders
  a normal `Milestone Status - <storyId>` report with `Ledger: missing` and a
  blocked current row. The distinct `Checklist-derived ledger (no milestone
  ledger set)` block is the CLI auto-append fallback for configured mutating
  commands when no real ledger is available. Neither path may fake a real
  milestone ledger.

Rules for this prompt consolidation:

| Situation | Required behavior |
|---|---|
| A command changes story phase, checklist status, milestone ledger, verification evidence, delivery check, or summary state. | The user must see current progress UX in the same human-facing interaction. Prefer the CLI auto-append path. |
| A command changes reviewer pass/finding state. | Current code does not auto-append progress UX for this path. Until a later implementation story changes that, the host must show reviewer impact through normal review output and run `lattice milestone_status --storyId=<id>` before a human-facing handoff when progress state is relevant. |
| The command output already includes `Milestone Status - <storyId>` or `Checklist-derived ledger (no milestone ledger set) - <storyId>`. | Do not duplicate the table. The UX requirement is satisfied. |
| A progress-relevant state-changing command, handoff, or final response does not auto-append progress UX but the response is human-facing. | The host/owner session must run `lattice milestone_status --storyId=<id>` and show or attach the result. This does not apply to unrelated read-only command output. |
| Output is machine JSON (`--json` / `--format=json`). | Do not inject Markdown into machine stdout. The next human-facing handoff or final response must include the progress view when progress is relevant. |
| An agent is producing findings, passes, evaluator JSON, delivery input, or implementation evidence. | The agent must not hand-write or guess milestone status. It writes structured facts; `milestone_status` renders the UX. |

Future prompt/routing work must preserve this boundary. If a new mutating
command changes a state that matters to progress, the implementation must either
add it to the CLI auto-append set or require an explicit host follow-up call to
`milestone_status`.

## Search / Memory Budget Contract

Prompt consolidation must reduce repeated broad scans without weakening scope
review. This contract applies to every agent prompt that may broad scan docs,
perform a full `docs/requirements/decisions/*.md` scan, or reverse-map a story
against historical decisions.

Rules:

- Agents that may broad scan must first consume bounded memory/playbook
  preflight when that surface is available. This is a recall and routing aid
  only.
- Memory and playbook results are advisory. They cannot satisfy hard gates,
  reviewer gates, DONE gates, delivery checks, verification evidence, or review
  escalation requirements.
- A memory/playbook no-hit is not permission to scan every decision file. The
  agent must first generate or consume a `candidateSpecSet`.
- `candidateSpecSet` sources include, in priority order:
  - explicit `relatedDocs` from checklist/story context;
  - story title, description, acceptance wording, and risk signals;
  - current diff, changed files, exported symbols, command names, config keys,
    and public docs anchors;
  - `lattice aux_doc_list` or its available replacement;
  - bounded `rg` results over docs, capped to the top N relevant documents with
    the cap recorded by the agent or routing surface.
- A full `decisions/*.md` scan is allowed only when at least one escalation
  trigger is present: high-risk story, lifecycle change, gate change,
  process-fact change, global rename, candidate ambiguity, or explicit reviewer
  escalation.
- Every full scan must record `scanEscalationReason` with the trigger, the
  failed or ambiguous candidate set, and the reviewer/host that escalated.
- REVIEW behavior must not default to full decisions-directory scanning. It
  consumes `scope_check_save` output, current diff, changed user-facing behavior,
  and `userSees` / transcript context. It escalates to full scan only through
  the rule above.
- REVIEW docs and delivery prompts may consume the same `candidateSpecSet`, but
  they must keep their owner boundaries: docs owns REVIEW doc-code drift;
  delivery owns final signed closeout and only runs docs-promise fallback when
  docs review was not routed or the candidate set is ambiguous.
- Token/search metrics belong to routing and sample-flow evidence: number of
  candidate docs, `rg` query count, memory/playbook hit count, whether a full
  scan ran, and the recorded escalation reason if it did.
- Default budget until a later story deliberately changes it:
  `candidateSpecSet <= 8` documents, `rg` query count `<= 10`, and full
  `decisions/*.md` scan `0` unless a recorded `scanEscalationReason` is present.
- Baseline REVIEW speed/cost excludes evaluator opt-in. Browser/CLI evaluator
  invocation count, token/time cost, and artifacts are reported separately so
  optional product exercise does not hide the cost of the default reviewer set.
- Default metric sink is CLI-owned routing/sample-flow evidence. Prompt prose may
  mirror the numbers for humans, but M6 exit requires machine-readable metrics in
  routing output, a sample-flow evidence artifact, or an explicitly named
  replacement CLI artifact.

This contract is not a runtime implementation by itself. M6 turns it into
prompt and routing requirements; later stories may rename fields only if the
same machine-readable facts remain available.

## Target Role Map

The consolidated system should present the 16 prompts as four classes:

| Class | Agents | Target state |
|---|---|---|
| Core lifecycle workers | `proof-or-stop-review-story-init`, `proof-or-stop-review-scope-plan`, `proof-or-stop-implementer`, `proof-or-stop-review-test-coverage`, `proof-or-stop-review-delivery` | Keep, update to current lifecycle and CLI-mediated evidence. |
| REVIEW specialist lanes | Default: `proof-or-stop-review-behavior`, `proof-or-stop-review-quality`, `proof-or-stop-review-docs`; conditional-active: `proof-or-stop-review-concept` | Keep, narrow responsibilities and remove duplicated doc-promise checks. Do not route concept review by default without a rename/removal trigger. |
| Product/evaluator/fold lanes | `proof-or-stop-evaluator`, `proof-or-stop-evaluator-cli`, `proof-or-stop-product-reviewer`, `proof-or-stop-implementation-reviewer` | Keep only with explicit advisory versus gate-evidence boundary; migrate or retire overlaps. |
| Legacy compatibility prompts | `proof-or-stop-test-intent`, `proof-or-stop-test-case-reviewer`, `proof-or-stop-review-channel` | Mark legacy/retired or migrate to current `verificationIntent` / CLI-gate model. |

## Agent Purpose And Overlap Table

| Agent | Current purpose | Problem solved | Current overlap / prompt issue | Target owner decision |
|---|---|---|---|---|
| `proof-or-stop-implementer` | DEV implementation worker that edits code, runs local checks, updates checklist state, and commits with a dedicated author. | Keeps normal-channel coding out of the main agent and creates dispatch/author evidence. | Prompt says implementer records `verificationEvidence`, but its allowed command list mainly permits status updates. It also assumes normal-channel implementer dispatch while some top-level guidance says DEV can be main-agent-led. | Keep. Clarify whether it may call `verification_evidence_add` / `checklist_update verificationEvidence`; align with channel gate policy and current DEV ownership wording. |
| `proof-or-stop-review-story-init` | INIT reviewer for background, title, description, priority, risk wording, and initial checklist sanity. | Prevents unclear or factually wrong stories from creating worktrees. | Directly reads `docs/story/...` files and instructs creating/editing `init-self-check.json`, which conflicts with CLI-mediated artifact discipline. Some scope coverage checks overlap with PLAN reviewer. | Keep. Replace direct file access with CLI read APIs where available; remove `init-self-check.json` write or add a CLI command if still required. Limit to readability/factual sanity, not requirement coverage. |
| `proof-or-stop-review-scope-plan` | PLAN reviewer mapping story/checklist coverage against decisions specs. | Catches missing or orphaned requirement coverage before DEV. | Requires reading every `decisions/*.md`, which can over-scope unrelated long-term commitments. It overlaps with `behavior` spec-boundary checks and legacy `proof-or-stop-test-intent` checklist split review. | Keep. Make it the single owner of PLAN scope coverage. Add relevance filters or CLI-provided candidate spec set; behavior reviewer should not redo full PLAN scope. |
| `proof-or-stop-review-behavior` | REVIEW reviewer for user-visible behavior, edge cases, and userSees mismatch. | Catches implementation that does not produce the promised observable behavior. | Repeats full decisions spec-boundary scanning and doc-promise reverse checks. Overlaps with `proof-or-stop-implementation-reviewer`, evaluator prompts, and delivery. | Keep. Own runtime/behavior correctness only. Remove docs-promise self-check; replace full decisions scan with current-story scope artifacts from `scope_check_save`. |
| `proof-or-stop-review-quality` | REVIEW reviewer for dead code, type safety, maintainability, I/O shell isolation, and proof metadata consistency. | Catches maintainability and narrow correctness risks not covered by lint. | Duplicates `proof-or-stop-implementation-reviewer`. Repeats docs-promise reverse checks. | Keep. Own maintainability and code-quality risks. Retire or fold `proof-or-stop-implementation-reviewer` into this lane. Remove docs-promise check. |
| `proof-or-stop-review-docs` | REVIEW reviewer for code/documentation drift around changed symbols. | Catches stale docs, bad command examples, schema mismatch, and docs/code disagreement. | Shares docs-promise checks with several other reviewers and overlaps with `delivery` docsPromises. Symbol extraction can miss behavior/config changes. | Keep. Make this the single REVIEW owner of doc-code drift and docs-promised-code-missing checks. Add non-symbol anchors for CLI commands/config/env changes. |
| `proof-or-stop-review-concept` | REVIEW reviewer for concept deletion/replacement residue. | Prevents retired terminology or old concepts from lingering after a rename/removal. | Concept residue scan can overlap with docs review and quality cleanup. It also carries docs-promise self-check unrelated to concept cleanup. | Keep as conditional/CLI-triggered lane. Own only concept residue. Remove docs-promise check. |
| `proof-or-stop-review-channel` | REVIEW reviewer for normal-channel dispatch evidence using `process-events.jsonl`. | Originally prevented main-agent self-writing in normal channel. | Top-level docs say this LLM agent is retired in favor of `lattice validate --channel`. It reads `docs/story/.../process-events.jsonl` directly and duplicates the channel CLI gate. | Retire as active reviewer. Keep only as historical compatibility prompt, or replace body with "use `lattice validate --channel`". |
| `proof-or-stop-review-test-coverage` | REVIEW reviewer for `verificationIntent` to `verificationEvidence` coverage. | Current replacement for legacy TEST_CASE_REVIEW value. | Correct high-level role, but must be stricter about starting with `review_run_start`, using current CLI shape, and never resurrecting legacy phases. | Keep. Make it the sole owner of verification coverage review. |
| `proof-or-stop-review-delivery` | TEST/DONE-adjacent delivery reviewer that verifies docs promises, real machine tests, and closing self-check. | Prevents green engineering checks from becoming false product delivery. | Overlaps with `proof-or-stop-review-docs` on docs promises and with `proof-or-stop-product-reviewer` on user-value closure. | Keep. Own final delivery artifact (`delivery_check_set`) only. Consume docs-review output when available; do not duplicate all REVIEW doc drift checks unless no docs reviewer ran. |
| `proof-or-stop-evaluator` | Browser/product evaluator using browser API. | Exercises UI like a user and scores functionality/usability. | Overlaps with `behavior` and `proof-or-stop-product-reviewer`; output is JSON text, not structured Proof-or-Stop evidence. | Keep as optional evaluator. Clarify advisory status or add a structured evidence sink if it should gate. |
| `proof-or-stop-evaluator-cli` | CLI/core evaluator using bridge API and optional CLI shell. | Exercises CLI/core behavior through user-facing interfaces. | Missing canonical load-bearing runtime guide. Overlaps with `proof-or-stop-evaluator`, behavior review, and delivery evidence. | Keep. Add canonical runtime guide and clarify whether output is advisory or gate evidence. |
| `proof-or-stop-product-reviewer` | Reviews final user-facing transcript and product closure. | Catches "engineering done but user still does not see completion". | Legacy alias `product-reviewer` mentions `testIntent`. Overlaps strongly with `proof-or-stop-review-delivery` and evaluator prompts. Mostly text output except INIT compatibility. | Either fold into `proof-or-stop-review-delivery` or mark as advisory product lane after INIT-gate compatibility is resolved. Remove `testIntent` wording. |
| `proof-or-stop-implementation-reviewer` | Reviews implementation risks, edge conditions, and maintainability. | Lightweight code review for behavior and maintainability risks. | Legacy alias `implementation-reviewer` duplicates `proof-or-stop-review-quality` and `proof-or-stop-review-behavior`; uses text output rather than structured findings and is not in current `REVIEW_RUN_LANES`. | Retire/fold into quality/behavior for Proof-or-Stop. Do not retain as a third active code reviewer in this lifecycle. |
| `proof-or-stop-test-intent` | Legacy checklist split reviewer and `testIntent` writer. | Old flow acceptance-intent generation. | Legacy alias `test-intent` conflicts with current `verificationIntent` flow and overlaps with scope-plan. | Migrate to a `proof-or-stop-verification-intent` role or mark legacy-only. Do not advertise for new stories. |
| `proof-or-stop-test-case-reviewer` | Legacy reviewer for fixture coverage of `testIntent`. | Old TEST_CASE_REVIEW coverage check. | Legacy alias `test-case-reviewer` conflicts with current `proof-or-stop-review-test-coverage`; directly reads fixture JSON; tied to legacy phase. | Mark legacy-only or replace with alias to `proof-or-stop-review-test-coverage`. |

## Detailed 16-Agent Migration Specification

This change is a lifecycle-level refactor, not a copy-edit pass. Each prompt
must have a defined phase, evidence boundary, allowed commands, output artifact,
and overlap owner. The sections below are intended to become implementation
checklist items in later stories.

### 1. `proof-or-stop-review-story-init`

Purpose:

- Independent INIT-phase reviewer.
- Checks whether a newly created story can be understood without conversation
  history.
- Verifies title, description, priority, risk wording, background readability,
  term definitions, and basic checklist sanity.

Problem it solves:

- Prevents bad story intake from creating a worktree.
- Catches vague background, undefined abbreviations, placeholder titles, empty
  checklist context, and false claims about the existing system before the
  lifecycle starts spending reviewer and implementation effort.

Required prompt changes:

- Keep `init_check_set` as the required output artifact.
- Remove direct story artifact writes such as `init-self-check.json`, or replace
  them with a CLI command if the audit record is still required.
- Prefer CLI reads (`story_get`, `checklist_get`, or a dedicated init read
  command) over direct `docs/story/...` file reads.
- Explicitly state that scope coverage belongs to `proof-or-stop-review-scope-plan`;
  INIT only checks whether the first story description and checklist are
  readable and sane.

Lifecycle impact:

- INIT remains a hard intake gate.
- INIT review no longer creates sidecar files outside CLI ownership.

### 2. `proof-or-stop-review-scope-plan`

Purpose:

- Independent PLAN-phase scope reviewer.
- Maps story description and checklist items to source-of-truth requirements.
- Persists coverage with `scope_check_save`.

Problem it solves:

- Prevents PLAN from omitting functional commitments.
- Forces explicit `covered`, `excluded`, `gap`, or `orphan-suspect`
  classification before DEV.

Required prompt changes:

- Keep it as the only owner of PLAN scope coverage.
- Replace unconditional full `decisions/*.md` scanning with a staged model:
  CLI-provided `candidateSpecSet` by default, full scan only for the
  Search / Memory Budget Contract escalation triggers: high-risk story,
  lifecycle change, gate change, process-fact change, global rename, candidate
  ambiguity, or explicit reviewer escalation.
- When memory/playbook preflight has no hit, generate or consume the bounded
  candidate set first rather than falling through to full directory scan.
- Continue forbidding reliance on checklist `context` as requirement truth.
- Make `openQuestions` the only output for contradictions that cannot be
  categorized safely.

Lifecycle impact:

- PLAN remains the scope-control phase.
- REVIEW behavior should consume the saved scope artifact instead of doing its
  own full decisions-directory review.

### 3. `proof-or-stop-implementer`

Purpose:

- DEV-phase worker for coding and focused local verification.
- Executes assigned checklist items without advancing phase.
- Records implementation progress and evidence through approved CLI commands.

Problem it solves:

- Separates implementation labor from main-agent coordination in normal-channel
  work.
- Produces dispatch, worker-result, commit-author, and checklist evidence that
  the channel gate can consume.

Required prompt changes:

- Resolve the contradiction between "record `verificationEvidence`" and the
  current whitelist that mostly allows checklist status updates.
- Add the exact allowed command for evidence, likely
  `verification_evidence_add` or `checklist_update verificationEvidence`.
- Clarify when the implementer is required: normal channel / risk-signaled
  story / operator policy, not every tiny express edit.
- Keep hard prohibitions on `story_advance`, `story_create`, destructive git,
  and direct story-file edits.

Lifecycle impact:

- DEV work becomes auditable without requiring the main agent to write all
  code.
- Channel policy must agree across prompt, CLI gate, and top-level docs.

### 4. `proof-or-stop-review-behavior`

Purpose:

- REVIEW-phase behavior reviewer.
- Checks whether implementation behavior matches `userSees`, checklist claims,
  current-story scope, and important edge cases.

Problem it solves:

- Catches behavior that compiles but does not satisfy the promised user-visible
  outcome.
- Finds missing input validation, terminal-state handling, repeat-invocation
  bugs, and error-message defects.

Required prompt changes:

- Remove the duplicated `doc-promise-undelivered` self-check.
- Stop doing an unconditional full decisions-directory scan.
- Consume `scope_check_save` output and current checklist/userSees instead.
- If behavior review escalates to a full decisions scan, require the same
  `scanEscalationReason` triggers and metrics defined in the Search / Memory
  Budget Contract.
- Keep structured reviewer flow: `review_run_start`, then `finding_add` or
  `review_pass_set`.
- Do not own UX scoring; evaluator/product/delivery lanes handle that.

Lifecycle impact:

- REVIEW behavior becomes a precise code-behavior lane rather than a second
  PLAN scope reviewer or delivery reviewer.

### 5. `proof-or-stop-review-quality`

Purpose:

- REVIEW-phase quality reviewer.
- Checks maintainability, dead code, unused imports, type safety, error
  handling, shell/I/O layering, and narrow proof metadata consistency.

Problem it solves:

- Catches risks that a behavior reviewer or typechecker may miss.
- Keeps codebase maintainable while avoiding style-only findings.

Required prompt changes:

- Remove the duplicated docs-promise self-check.
- Keep proof metadata review guidance, but label it correctness review only,
  not production receipt evidence.
- Fold useful `proof-or-stop-implementation-reviewer` concerns into this prompt
  and retire that prompt from active Proof-or-Stop routing.
- Require every finding to include file path and line number.

Lifecycle impact:

- REVIEW has one owner for maintainability/code-quality risks.
- Subjective code review no longer duplicates behavior or docs lanes.

### 6. `proof-or-stop-review-docs`

Purpose:

- REVIEW-phase docs/code consistency reviewer.
- Checks whether changed symbols, CLI commands, schemas, environment variables,
  examples, and behavior paragraphs are consistent with implementation.

Problem it solves:

- Prevents documentation from promising commands or fields that do not exist.
- Prevents changed code from leaving stale documentation behind.

Required prompt changes:

- Make this the only REVIEW owner for `doc-code-drift` and
  `doc-promise-undelivered`.
- Expand anchors beyond exported symbols so CLI command registration, config
  options, env vars, and behavior paragraphs are covered.
- Keep the scope narrowed to touched symbols/docs unless the story is docs-only
  or high-risk.
- Emit structured findings with doc and source files in `files`.

Lifecycle impact:

- REVIEW docs drift becomes centralized.
- Other reviewers stop producing duplicate doc-promise findings.

### 7. `proof-or-stop-review-concept`

Purpose:

- Conditional REVIEW reviewer for concept deletion, rename, or replacement.
- Greps for residual terms after a concept is intentionally removed or renamed.

Problem it solves:

- Prevents stale vocabulary from surviving a semantic migration.
- Protects future agents from following old names and deprecated mental models.

Required prompt changes:

- Remove docs-promise self-check.
- Clarify trigger: run only when CLI preflight or diff analysis detects concept
  deletion/replacement.
- Require allowlisted backward-compat references to have explicit compatibility
  comments.
- Keep `@deprecated` handling, but avoid scanning archived evidence or unrelated
  generated outputs unless the concept is runtime-facing.

Lifecycle impact:

- Concept cleanup becomes conditional and precise.
- It no longer acts as a generic docs or quality reviewer.

### 8. `proof-or-stop-review-channel`

Purpose:

- Historically reviewed normal-channel dispatch evidence.

Problem it solved:

- Prevented normal-channel implementation from being silently performed by the
  main agent when policy required `proof-or-stop-implementer`.

Required prompt changes:

- Retire as active reviewer because channel validation is now a CLI gate:
  `lattice validate --channel --story=<id>`.
- Replace body with a compatibility notice or mark it legacy/retired in prompt
  registry metadata.
- Remove direct `process-events.jsonl` reading from active prompts.
- Update routing so no current REVIEW flow spawns it by default.

Lifecycle impact:

- REVIEW->TEST channel enforcement remains mechanical and faster.
- LLM reviewer no longer duplicates the channel gate or directly reads story
  event files.

### 9. `proof-or-stop-review-test-coverage`

Purpose:

- REVIEW-phase coverage reviewer for `verificationIntent` and
  `verificationEvidence`.

Problem it solves:

- Preserves the value of legacy TEST_CASE_REVIEW without restoring the old
  phase.
- Ensures every must intent has valid evidence or a justified waiver.

Required prompt changes:

- Make `review_run_start` the explicit first command after receiving storyId.
- Use the current validation command shape and evidence schema.
- Treat broad "validate passed" notes as insufficient unless they map to a
  concrete intentRef.
- Keep it as the only active verification-coverage reviewer.

Lifecycle impact:

- REVIEW gains coverage assurance without reintroducing TEST_CASE or
  TEST_CASE_REVIEW phases.

### 10. `proof-or-stop-review-delivery`

Purpose:

- TEST/DONE-adjacent delivery reviewer.
- Writes signed `delivery_check_set` evidence covering docs promises, real
  machine tests, and closing self-check.

Problem it solves:

- Prevents false DONE where implementation or tests are green but delivery
  claims are unsupported.
- Forces final honesty about what was actually delivered.

Required prompt changes:

- Keep `delivery_check_set` as the sole final delivery artifact.
- Define its relationship to `proof-or-stop-review-docs`: docs reviewer owns REVIEW
  doc-code drift; delivery reviewer verifies final promise fulfillment and
  machine-test presence.
- Define how evaluator transcripts may be cited as delivery evidence.
- Avoid trusting prior gate results or main-agent narrative.

Lifecycle impact:

- TEST/DONE closeout has a single delivery owner.
- Product closure and docs promises are tied to signed artifacts, not prose.

### 11. `proof-or-stop-evaluator`

Purpose:

- Browser-facing product evaluator.
- Exercises UI through browser APIs and scores functionality/usability.

Problem it solves:

- Catches issues visible only when using the application like a user.
- Provides concrete item-level observations instead of code-review speculation.

Required prompt changes:

- Clarify two-layer output: evaluator raw JSON is advisory, while parsed
  `evaluate_save` output (`eval-evidence.json`) is the current structured sink
  when workflow policy requires evaluator evidence.
- Align with `proof-or-stop-review-delivery` so evaluator transcripts can be cited
  without being overstated.
- Keep "do not read code" boundary.

Lifecycle impact:

- Browser product exercise becomes an optional or structured validation lane,
  not an ambiguous reviewer substitute.

### 12. `proof-or-stop-evaluator-cli`

Purpose:

- CLI/core-logic product evaluator.
- Exercises bridge API and optional CLI shell like a user would.

Problem it solves:

- Catches command/core workflow defects not visible in source review.
- Verifies state transitions, errors, reset behavior, replay behavior, and CLI
  shell interaction.

Required prompt changes:

- Add canonical load-bearing runtime guide; remove unexpanded
  `lattice:start-slot`.
- Clarify advisory raw JSON versus `evaluate_save` structured evidence status.
- Align scoring and evidence language with `proof-or-stop-evaluator`.
- Keep source-code reading prohibited unless a future gate role explicitly
  requires otherwise.

Lifecycle impact:

- CLI/core projects gain a product exercise lane with the same process guidance
  as browser projects.

### 13. `proof-or-stop-product-reviewer`

Purpose:

- Reviews whether final user-facing output closes the loop.
- Legacy alias: `product-reviewer`.

Problem it solves:

- Catches cases where engineering is complete but the user still does not have
  a satisfying final result.

Required prompt changes:

- Remove `testIntent` references.
- Do not fold or downgrade this prompt until the INIT gate no longer depends on
  product-style intake output, or the dependency is proven obsolete by
  tests and process-fact registry evidence.
- Decide one of two futures:
  - fold into `proof-or-stop-review-delivery`, or
  - mark as advisory product acceptance reviewer.
- If retained as active evidence, require structured pass/finding artifacts.
- Keep non-mechanical user approval clearly labeled as non-mechanical.

Lifecycle impact:

- User-value closure no longer floats between product, evaluator, behavior, and
  delivery prompts.

### 14. `proof-or-stop-implementation-reviewer`

Purpose:

- Lightweight implementation risk reviewer.
- Legacy alias: `implementation-reviewer`.

Problem it solves:

- Catches concrete code risks, edge omissions, and maintainability concerns.

Required prompt changes:

- Retire from active Proof-or-Stop routing and fold useful checks into
  `proof-or-stop-review-quality` and `proof-or-stop-review-behavior`.
- If a future non-Proof-or-Stop project needs this prompt, treat that as a
  separate registry status, not as a third active code reviewer here.
- Remove legacy `testIntent` references.
- Keep output limited to implementation-layer risks if retained.

Lifecycle impact:

- REVIEW no longer has two informal code-review prompts with overlapping
  authority.

### 15. `proof-or-stop-test-intent`

Purpose:

- Legacy checklist split reviewer and `testIntent` writer.
- Legacy alias: `test-intent`.

Problem it solved:

- Generated old acceptance criteria before implementation and forced edge /
  adversarial thinking.

Required prompt changes:

- Do not use as-is for new stories.
- Choose one target:
  - migrate to `proof-or-stop-verification-intent` and write
    `verificationIntent`, or
  - mark as legacy-only for old stories.
- If migrated, remove TEST_CASE vocabulary and use current intent priority,
  type aliases, waiver expectations, and checklist update commands.
- Keep adversarial stance, but route scope coverage to
  `proof-or-stop-review-scope-plan`.

Lifecycle impact:

- PLAN intent generation becomes compatible with current gates.
- New stories stop writing obsolete `testIntent` fields.

### 16. `proof-or-stop-test-case-reviewer`

Purpose:

- Legacy reviewer for fixture/test coverage of `testIntent`.
- Legacy alias: `test-case-reviewer`.

Problem it solved:

- Ensured old fixture cases covered old testIntent lanes before TEST_CASE_REVIEW
  could pass.

Required prompt changes:

- Do not use as-is for new stories.
- Replace with an alias to `proof-or-stop-review-test-coverage` or mark legacy-only.
- Remove instruction paths tied to TEST_CASE_REVIEW for new flow.
- Do not instruct direct fixture JSON reading unless a legacy fixture
  maintenance story explicitly needs it.

Lifecycle impact:

- Verification coverage review moves to REVIEW through
  `proof-or-stop-review-test-coverage`.
- Legacy fixture maintenance remains possible but cannot leak into new stories.

## Lifecycle Flow After Consolidation

The consolidated prompt system changes the practical flow as follows:

| Phase | Current confusion | Consolidated owner |
|---|---|---|
| INIT | INIT reviewer and product-style review can both write init checks; story files may be read/written directly. | `proof-or-stop-review-story-init` owns INIT sanity through CLI artifacts only after `proof-or-stop-product-reviewer` INIT dependency is migrated or proven obsolete. |
| PLAN | Legacy `proof-or-stop-test-intent` and `scope-plan` both review checklist quality/scope. | `proof-or-stop-review-scope-plan` owns requirement coverage; optional migrated `proof-or-stop-verification-intent` owns verification intent only. |
| DEV | Main agent versus implementer ownership is inconsistent across docs/prompts. | `proof-or-stop-implementer` is used exactly when channel policy requires worker evidence; express/fast behavior is documented mechanically. |
| REVIEW | Behavior, quality, docs, concept, channel, `proof-or-stop-implementation-reviewer`, and `proof-or-stop-test-case-reviewer` overlap. | REVIEW lanes are behavior, quality, docs, concept-conditional, and test-coverage; channel is CLI gate; legacy reviewers are not active. |
| TEST | Delivery, `proof-or-stop-product-reviewer`, evaluator, and validation evidence boundaries are blurry. | `proof-or-stop-review-delivery` owns signed delivery check; evaluators provide advisory or structured transcripts; product-style review is folded or advisory. |
| DONE | Text claims can look like product acceptance. | DONE consumes structured validation, delivery, review, and evidence artifacts only. |

## New Flow Execution Table

Prompt count: **16 canonical agent prompt templates**.

This table is the execution control sheet for the prompt refactor. It should be
kept in sync with registry metadata once M1 adds structured prompt status.

### Milestone Ledger State Vocabulary

Use the same six-state vocabulary as the current `lattice milestone_status`
human UX for prompt-consolidation milestone tracking. Prompt status such as
`active`, `conditional`, `advisory`, `folded`, `retired`, `legacy`, or
`not_routed` is registry/routing metadata, not a milestone row state. The
user-visible progress UX must come from `lattice milestone_status`, not from
agents translating these states by hand.

| State | Meaning |
|---|---|
| `not_started` | No implementation story has started for this milestone row. Renders as Not Started. |
| `in_progress` | A story is actively changing this prompt, routing, or test surface. Renders as In Progress. |
| `pending_review` | Prompt/routing changes appear implemented, but review, validation, adapter verification, or rollout evidence is still missing. Renders as Pending Review. |
| `blocked` | Work cannot proceed without an open decision, missing CLI API, failing gate, or unresolved finding. Renders as Blocked. |
| `failed` | A required verification, adapter check, lifecycle sample, or gate test failed. Renders as Failed. |
| `done` | Prompt/routing changes passed the relevant registry, process-fact, adapter, and representative lifecycle checks. Renders as Done. |

Important ledger rule:

- Individual agents should **not** manually write milestone ledger status as
  free text.
- Agents should emit their normal structured artifact (`init_check_set`,
  `scope_check_save`, `finding_add`, `review_pass_set`,
  `verification_evidence_add`, evaluator transcript, or `delivery_check_set`).
- The owner session / CLI should derive milestone ledger state from those
  artifacts plus story phase and validation evidence.
- If a prompt is advisory-only, it may output a status suggestion, but that
  suggestion is not gate evidence unless a structured evidence sink consumes it.
- Retired, legacy-only, folded, skipped, or conditional prompts should be
  represented as routing/status metadata with an explicit reason. They must not
  be marked `done` merely because they were skipped.

### Agent Execution Matrix

| Agent prompt | Flow phase | Capability | Problem solved | Inputs | Outputs / evidence | Current status | Ledger policy | Overlap isolation |
|---|---|---|---|---|---|---|---|---|
| `proof-or-stop-review-story-init` | INIT | Intake readability and factual sanity review. | Stops unclear or false story background before worktree creation. | `storyId`, background/title/description/checklist via CLI, relevant docs/source for factual spot checks. | `init_check_set` with issues or empty pass. | Active, needs artifact-discipline rework. | Ledger derives INIT readiness from `init_check_set`; agent should not write sidecar ledger files. | Must not own PLAN scope coverage or product acceptance. |
| `proof-or-stop-review-scope-plan` | PLAN | Requirement-to-checklist coverage mapping. | Prevents omissions, unexplained exclusions, and orphaned requirements. | `storyId`, story description, checklist titles/excludes, candidate requirements docs. | `scope_check_save` with feature statuses and open questions. | Active, needs scan-narrowing rework. | Ledger derives PLAN scope state from `scope_check_save` and resolved open questions. | Sole owner of PLAN scope; behavior reviewer consumes its artifact instead of rescanning everything. |
| `proof-or-stop-implementer` | DEV | Code/test/docs implementation for assigned CHKs. | Produces auditable worker implementation and verification evidence. | `storyId`, assigned item, plan section, allowed files, required docs, current failure/reviewer context. | Commits, checklist status, `verificationEvidence` or `verification_evidence_add`, local command notes. | Active, needs command whitelist alignment. | Ledger derives DEV item progress from checklist/evidence/commits; implementer does not advance phase. | Must not review, accept, create stories, or run phase advancement. |
| `proof-or-stop-review-behavior` | REVIEW | Functional behavior and edge-case review. | Catches code that does not produce promised behavior. | Current diff, checklist title/userSees, saved scope artifact, relevant source files. | `review_run_start`, then `finding_add` or `review_pass_set`. | Active, needs overlap cleanup. | Ledger derives reviewer lane state from signed review run and finding/pass. | Does not own docs promises, full PLAN scope, UX scoring, or delivery closeout. |
| `proof-or-stop-review-quality` | REVIEW | Code quality, maintainability, type safety, layering. | Catches dead code, unsafe casts, swallowed errors, and maintainability risks. | Current diff, changed files, source reads, narrow proof metadata context. | `review_run_start`, then `finding_add` or `review_pass_set`. | Active, needs duplicate doc-check removal. | Ledger derives reviewer lane state from signed review run and finding/pass. | Owns quality only; behavior correctness and docs drift belong elsewhere. |
| `proof-or-stop-review-docs` | REVIEW | Docs/code consistency and docs promise verification. | Prevents docs from promising nonexistent commands/fields/behavior and prevents stale docs. | Current diff, changed symbols, changed docs, command/config/env anchors, related source files. | `review_run_start`, then `finding_add` or `review_pass_set`. | Active, should become sole REVIEW docs owner. | Ledger derives docs-review state from signed review run and finding/pass. | Owns REVIEW doc drift; delivery owns final delivery promise artifact. |
| `proof-or-stop-review-concept` | REVIEW conditional | Concept deletion/rename residue scan. | Prevents stale concepts and retired terminology from surviving migrations. | Current diff, deleted/replaced concept terms, repository grep results. | `review_run_start`, then `finding_add` or `review_pass_set`. | Conditional-active, not default-routed; needs trigger/overlap cleanup. | When no trigger exists, routing metadata records `not_routed` with reason; milestone rows use the real UX states only when a story owns concept work. | Only owns concept residue, not generic docs or quality review. |
| `proof-or-stop-review-channel` | REVIEW replaced by CLI | Historical dispatch/channel evidence review. | Previously detected normal-channel main-agent self-writing. | Story/checklist/process events in old prompt. | Historically `finding_add`/`review_pass_set`; target is no LLM output. | Retired / CLI-replaced. | Routing metadata marks it retired/CLI-only; channel status comes from `lattice validate --channel`, not a milestone `done` row. | Isolated into CLI gate; no active reviewer overlap. |
| `proof-or-stop-review-test-coverage` | REVIEW | `verificationIntent` to `verificationEvidence` coverage audit. | Ensures must intents have concrete evidence or waiver. | `storyId`, checklist, validation coverage output, evidence records. | `review_run_start`, then coverage findings or `review_pass_set`. | Active, needs first-command/CLI-shape hardening. | Ledger derives verification coverage state from review run plus validation evidence. | Sole owner of verification coverage; legacy test-case reviewer is not active. |
| `proof-or-stop-review-delivery` | TEST / DONE closeout | Signed delivery promise and machine-test review. | Prevents false DONE and unsupported final delivery claims. | `storyId`, current diff, docs promises, tests/transcripts, source grep proof. | `delivery_check_set`, or refusal with explicit reason. | Active, needs docs/product boundary clarification. | Ledger derives delivery state from signed `delivery_check_set`; refusal maps to `blocked`. | Owns final delivery artifact; docs reviewer owns REVIEW doc drift. |
| `proof-or-stop-evaluator` | TEST optional/policy-gated | Browser/UI product exercise via browser API. | Finds user-visible UI defects through actual operation. | `serveUrl`, checklist, browser status/DOM/actions/console. | Raw JSON report; optional `eval-evidence.json` via `evaluate_save`. | Optional raw lane; policy-gated only after `evaluate_save`. | Ledger ignores raw JSON; persisted `eval-evidence.json` is consumed only by evaluator policy. | Does not replace behavior review or delivery check. |
| `proof-or-stop-evaluator-cli` | TEST optional/policy-gated | CLI/core product exercise via bridge API and CLI shell. | Finds workflow/state-transition defects through user-facing APIs. | `serveUrl`, checklist, bridge state/events, optional CLI shell command. | Raw JSON report; optional `eval-evidence.json` via `evaluate_save`. | Optional raw lane, missing runtime guide; policy-gated only after `evaluate_save`. | Ledger ignores raw JSON; persisted `eval-evidence.json` is consumed only by evaluator policy. | Does not replace test coverage or behavior review. |
| `proof-or-stop-product-reviewer` | INIT/TEST/DONE advisory or folded | User-value closure and possible INIT compatibility review. | Catches "engineering done but user still wonders what happened"; may satisfy current INIT compatibility until migrated. | `storyId`, intake or outcome transcript, summary, optional transcript diff. | Text today; target is folded delivery input or structured product pass/finding if retained. | Advisory/fold candidate, INIT dependency unresolved. | Routing metadata marks advisory/folded unless converted to structured artifact or folded into delivery; INIT dependency blocks downgrade. | Must not duplicate delivery or evaluator ownership. |
| `proof-or-stop-implementation-reviewer` | REVIEW folded/retired | Lightweight implementation risk review. | Finds concrete code risks outside fixture/product concerns. | Checklist, implementation files, test/reviewer hints. | Text today; no current structured Proof-or-Stop reviewer lane. | Fold/retire target. | Routing metadata marks folded/retired for new Proof-or-Stop flow; no milestone row should imply it ran. | Fold into behavior/quality; do not keep a third active code-review lane. |
| `proof-or-stop-test-intent` | PLAN legacy | Legacy `testIntent` authoring and checklist split review. | Old acceptance-intent generation. | Story description, checklist id/title/context. | Legacy `checklist_update testIntent`; target migration is `verificationIntent`. | Legacy-migrate candidate. | Routing metadata marks legacy-only for new flow; migration story tracks replacement. | Replace with `proof-or-stop-verification-intent` authoring or legacy-only banner. |
| `proof-or-stop-test-case-reviewer` | Legacy TEST_CASE_REVIEW | Legacy fixture coverage review for `testIntent`. | Old fixture-vs-intent assurance. | Checklist/testIntent, fixture files, legacy testintent records. | Legacy `testintent_record` and `testintent_check`. | Legacy/replace candidate. | Routing metadata marks legacy-only for new flow; coverage state comes from `proof-or-stop-review-test-coverage`. | Must not run in new flow; alias or legacy-only. |

### Exact Contract Summary

These contracts are implementation requirements, not explanatory prose. If a
prompt emits a gate-consumed fact, the CLI must accept the canonical
`proof-or-stop-*` role and normalize any legacy alias before writing or reading
that fact.

| Prompt | Trigger | Required first command | Allowed writes | Required output | Canonical agent/lane | Blocking semantics |
|---|---|---|---|---|---|---|
| `proof-or-stop-review-story-init` | INIT before INIT_CHECK. | `lattice story_get` plus `lattice checklist_get`, or a future `lattice init_context_get`. | `init_check_set` only. | Signed INIT pass/issues; equivalent fresh-context fence if `init-self-check.json` is removed. | `proof-or-stop-review-story-init`; legacy `lattice-review-story-init` accepted read-only during alias window. | High/critical INIT issues block INIT_CHECK. Missing fresh-context fence blocks if the current gate requires it. |
| `proof-or-stop-review-scope-plan` | PLAN before DEV. | `lattice story_get` plus `lattice checklist_get`, or a future `lattice scope_context_get`. | `scope_check_save` only. | Requirement coverage map with `covered`, `excluded`, `gap`, `orphan-suspect`, and open questions. | `proof-or-stop-review-scope-plan`. | Open gaps/questions block PLAN->DEV unless explicitly waived by the gate policy. |
| `proof-or-stop-implementer` | DEV when channel policy, risk, or owner dispatch requires worker evidence. | `lattice checklist_get` or assigned plan/context command. | Code/docs commits, checklist status, `verification_evidence_add`; `checklist_update verificationEvidence` is compatibility only. | Implemented checklist item plus concrete verification evidence bound to the intent. | `proof-or-stop-implementer`. | Missing required evidence blocks DEV->REVIEW/TEST through coverage and validation gates. Implementer never advances phase. |
| `proof-or-stop-review-behavior` | REVIEW when behavior/user-visible code changed. | `lattice review_run_start`. | `finding_add` or `review_pass_set`. | Behavior finding/pass bound to current review run. | `proof-or-stop-review-behavior`. | Verified open critical/high findings block REVIEW->TEST; suspected findings are advisory by evidenceState policy. |
| `proof-or-stop-review-quality` | REVIEW for changed source or process code. | `lattice review_run_start`. | `finding_add` or `review_pass_set`. | Quality finding/pass bound to current review run. | `proof-or-stop-review-quality`. | Verified open critical/high findings block REVIEW->TEST. |
| `proof-or-stop-review-docs` | REVIEW when docs, CLI commands, config, schemas, public names, or documented behavior may drift. | `lattice review_run_start`. | `finding_add` or `review_pass_set`. | Docs/code drift finding/pass. | `proof-or-stop-review-docs`. | Verified open critical/high findings block REVIEW->TEST. If this lane is not routed, delivery must run a final docs-promise fallback scan. |
| `proof-or-stop-review-concept` | REVIEW only when rename/removal/concept-deletion trigger exists. | `lattice review_run_start`. | `finding_add` or `review_pass_set`. | Concept residue finding/pass, or `not_routed` routing metadata with reason. | `proof-or-stop-review-concept`. | Triggered verified open critical/high findings block REVIEW->TEST; untriggered lane is skipped by routing metadata, not by a fake pass. |
| `proof-or-stop-review-test-coverage` | REVIEW baseline for non-trivial stories. | `lattice review_run_start`. | `finding_add` or `review_pass_set`. | `verificationIntent` to `verificationEvidence` coverage finding/pass. | `proof-or-stop-review-test-coverage`. | Missing/stale must-evidence blocks REVIEW->TEST or TEST validation. |
| `proof-or-stop-review-delivery` | TEST/DONE closeout. | `lattice validate` / `lattice done_prepare` context, and `done_required_validate` status when project policy configures DONE-required commands, then delivery evidence command. | `delivery_check_set` only. | Signed delivery pass/refusal with test/transcript/docs-promise basis. | `proof-or-stop-review-delivery`. | Refusal or stale/missing delivery evidence blocks DONE; missing fresh DONE-required evidence blocks only when that policy is configured. |
| `proof-or-stop-evaluator` | Optional UI/browser exercise. | Browser status/load command chosen by host. | No direct story writes; owner may call `evaluate_save` after parsing evaluator JSON. | Raw JSON plus optional `eval-evidence.json` through `evaluate_save`. | `proof-or-stop-evaluator`. | Raw JSON never blocks. `eval-evidence.json` can block DONE only when workflow policy requires evaluator evidence. |
| `proof-or-stop-evaluator-cli` | Optional CLI/core exercise. | Bridge/API status command or CLI shell preflight. | No direct story writes; owner may call `evaluate_save` after parsing evaluator JSON. | Raw JSON plus optional `eval-evidence.json` through `evaluate_save`. | `proof-or-stop-evaluator-cli`. | Raw JSON never blocks. `eval-evidence.json` can block DONE only when workflow policy requires evaluator evidence. |

### Artifact Schema / Writer / Reader / Freshness Table

This table records current code-backed contracts. It intentionally avoids
inventing new required fields where the CLI already has a schema.

| Artifact | Writer | Required/current schema facts | Reader / gate consumer | Freshness or anti-forgery rule | Plan action |
|---|---|---|---|---|---|
| `init-check.json` | `init_check_set`; controlled fallback `init_check_repair`. | `storyId`, `checkedAt`, `reviewRound`, `agentId`, `issues`, `agentResults`, `_hash`; required agent set currently includes `lattice-review-story-init` and `product-reviewer`. | INIT->INIT_CHECK in `core/machine.ts`; process-fact registry reviewer lanes. | `_hash` covers story background/title/description/checklist hash/reviewRound; high/critical issues block; fallback is marked with `@fallback`. | Preserve this fence while renaming to `proof-or-stop-*`; do not remove `product-reviewer` until required-agent migration passes tests. |
| `scope-check.json` | `scope_check_save`. | `features[]`, five-tier `status`, `summary`, optional `openQuestions`, `_hash`. | PLAN scope review / story review consumers. | `_hash` covers storyId/timestamp/gaps/covered/reviewRound; `openQuestions` are currently outside signature domain. | M1/M4 must decide whether `openQuestions` need stronger gate binding before prompts rely on them as blockers. Until then, prompts must treat open questions as review context or require `scope_question_resolve` / a signature-domain update before claiming tamper-evident blocker status. |
| Review run | `review_run_start`. | lane from `REVIEW_RUN_LANES`, `reviewRunId`, review round, `headHash`, `materialHash`, optional `storyFilesHash`, prompt hash, workspace binding. | `finding_add`, `review_pass_set`, REVIEW->TEST gate, quorum. | Evidence must bind to the current run/round and fresh workspace binding. Current code only accepts `lattice-review-*` lanes. | M0.5 must normalize canonical `proof-or-stop-*` roles before new reviewer evidence writes. |
| Finding / review pass | `finding_add`, `review_pass_set`. | Signed finding/pass with `agent`, `reviewRunId`, severity/category or note; `evidenceState` defaults to verified. | REVIEW->TEST in `core/machine.ts`; review escalation/floor downstream. | Reviewer evidence must pass signature/run binding; suspected/disproven findings are advisory. | Keep pass-only `finding_add` normalization, but ensure canonical role IDs are written after M0.5. |
| `verificationEvidence` | `verification_evidence_add`; legacy compatibility through `checklist_update verificationEvidence`. | `intentRef`, `kind`, `note`, optional `file`, `command`, `result`, `verdict`, `waiverType`, `attestation`, `actorTrust`, `factProvenance`; writer auto-stamps `headHash`, `materialHash`, `storyFilesHash`, `timestamp`. | DEV->REVIEW evidence gate, REVIEW coverage, `lattice validate`, DONE stale-evidence hints. | `checkEvidenceFreshnessForGit` compares current material/story files; storyFilesHash match can downgrade whole-tree drift to re-attestation advisory. | Prefer `verification_evidence_add`; document minimum fields from the existing schema, not a new ad hoc schema. |
| `test-evidence.json` | `lattice validate`. | PASS/FAIL plus head/material binding. | DONE gate and DONE pre-check. | DONE verifies PASS and recorded snapshot/material binding. | No prompt writes. Keep as CLI-owned validation evidence. |
| `done-required-evidence.json` | `done_required_validate`. | Command-set/policy result bound to current HEAD/material/storyFiles/policy when `doneRequiredCommands` or DONE-required policy is configured. | DONE-required gate only for projects that opt in. | Fresh PASS evidence is blocking only under configured policy; without policy the command is advisory/no full-suite assurance. | Delivery and final prompts may cite this evidence when present, but must not imply it exists or is required for projects without a DONE-required policy. |
| `delivery-check.json` | `delivery_check_set`. | `docsPromises`, `realMachineTests`, `closingSelfCheck`, `agentId`, `headHash`, `materialHash`, optional `storyFilesHash`, review round, `_hash`. | TEST/DONE closeout and DONE gate. | `_hash` covers promises/tests/self-check/reviewRound/materialHash/storyFilesHash; material drift is stale unless signed storyFilesHash still matches. | Delivery prompt can cite evaluator transcript only when it exists; docs fallback only when docs reviewer was not routed. |
| `eval-evidence.json` | `evaluate_save`. | Parsed evaluator JSON with `scores`, `total`, `pass`, `itemResults`, `findings`, `timestamp`. | DONE evaluator row when browser project policy requires it. | Raw evaluator JSON is not gate evidence; only persisted `eval-evidence.json` is consumed. | M1 should classify evaluator prompts as raw advisory producers plus optional `evaluate_save` evidence source, not invent a parallel sink unless replacing this one. |

### Prompt Count By Target Status

| Target status | Count | Agents |
|---|---:|---|
| Active lifecycle | 5 | `proof-or-stop-review-story-init`, `proof-or-stop-review-scope-plan`, `proof-or-stop-implementer`, `proof-or-stop-review-test-coverage`, `proof-or-stop-review-delivery` |
| Active REVIEW specialist | 3 default + 1 conditional | Default: `proof-or-stop-review-behavior`, `proof-or-stop-review-quality`, `proof-or-stop-review-docs`; conditional-active: `proof-or-stop-review-concept` |
| Optional/advisory evaluator | 2 | `proof-or-stop-evaluator`, `proof-or-stop-evaluator-cli` |
| Blocked fold/advisory decision | 1 | `proof-or-stop-product-reviewer` |
| Fold/retire decided | 1 | `proof-or-stop-implementation-reviewer` |
| Retired/legacy | 3 | `proof-or-stop-review-channel`, `proof-or-stop-test-intent`, `proof-or-stop-test-case-reviewer` |
| **Total** | **16** | All canonical prompt templates. |

### Cross-Overlap Isolation Rules

| Overlap area | Single owner after consolidation | Non-owners must do this |
|---|---|---|
| PLAN requirement coverage | `proof-or-stop-review-scope-plan` | Do not rescan all decisions; consume saved scope artifact. |
| Runtime behavior correctness | `proof-or-stop-review-behavior` | Quality/docs/evaluator lanes may cite symptoms, but should not own behavior verdicts. |
| Maintainability/code hygiene | `proof-or-stop-review-quality` | Behavior reviewer reports user-visible defects, not style/maintainability-only issues. |
| Docs/code drift and docs-promised-code-missing in REVIEW | `proof-or-stop-review-docs` | Remove `doc-promise-undelivered` checks from behavior/quality/concept/channel. |
| Concept residue | `proof-or-stop-review-concept` when triggered | Docs/quality should not duplicate concept-cleanup findings unless concept lane is not routed. |
| Channel compliance | CLI gate `lattice validate --channel` | No LLM channel reviewer in active REVIEW routing. |
| Verification coverage | `proof-or-stop-review-test-coverage` | Legacy `proof-or-stop-test-case-reviewer` is not used in new flow. |
| Product exercise transcript | `proof-or-stop-evaluator` / `proof-or-stop-evaluator-cli` if invoked | Behavior/delivery can consume transcript, not invent it. |
| Final delivery promise | `proof-or-stop-review-delivery` | Docs reviewer owns REVIEW drift; delivery owns final signed closeout. |
| Product/user-value closure | `proof-or-stop-review-delivery` or structured `proof-or-stop-product-reviewer`, pending decision | Do not let both produce independent blocking product verdicts. |

### Routing Truth Table

The routing table is intentionally conservative. It should be implemented in
CLI hints/spawn guidance after the registry knows each prompt's status.

| Situation | Required prompts | Conditional prompts | Optional prompts | Retired / CLI-only |
|---|---|---|---|---|
| INIT intake for a new story | `proof-or-stop-review-story-init` | `proof-or-stop-product-reviewer` only while INIT compatibility depends on it. | None. | No direct story-file edits. |
| PLAN scope review | `proof-or-stop-review-scope-plan` | `proof-or-stop-test-intent` only for legacy stories, or future `proof-or-stop-verification-intent` if created. | None. | Legacy `test-intent` alias warns and routes away for new stories. |
| DEV normal/risk-signaled work | `proof-or-stop-implementer` when channel policy requires worker evidence. | None. | Main-agent DEV for express/fast paths if `express-exempt` policy allows it. | No phase advancement by implementer. |
| DEV express/fast trivial work | Main agent plus CLI evidence, if policy allows. | `proof-or-stop-implementer` if risk signals, owner policy, or channel gate requires it. | None. | Express exemption must be a structured policy fact, not prompt prose. |
| REVIEW baseline for code stories | `proof-or-stop-review-test-coverage`, plus `proof-or-stop-review-behavior` and/or `proof-or-stop-review-quality` according to touched files. | `proof-or-stop-review-docs` when docs/public commands/config/schemas may drift; `proof-or-stop-review-concept` when rename/removal trigger exists. | None for implementation-reviewer; its useful checks are folded into behavior/quality. | `proof-or-stop-review-channel` replaced by `lattice validate --channel`. |
| REVIEW docs touched or public behavior documented | `proof-or-stop-review-docs`. | `proof-or-stop-review-concept` if terminology changed. | None. | If docs reviewer is not routed, delivery must run final docs-promise fallback. |
| REVIEW concept deletion/rename | `proof-or-stop-review-concept`. | `proof-or-stop-review-docs` for docs/code drift caused by the rename. | None. | Concept lane is `not_routed` with a reason when no trigger exists. |
| TEST validation | CLI `lattice validate`. | `proof-or-stop-evaluator` / `proof-or-stop-evaluator-cli` when UI/CLI user exercise is needed. | Evaluator raw JSON is advisory; persisted `eval-evidence.json` is policy-gated. | Legacy TEST_CASE prompts not used. |
| DONE closeout | `proof-or-stop-review-delivery` plus CLI `done_prepare` / DONE-required policy when configured. | `proof-or-stop-product-reviewer` only if not folded and structured. | Evaluator transcript may be consumed, not invented. | Free-text product approval is not gate evidence. |
| Legacy story already in legacy phase | Existing legacy aliases accepted under compatibility policy. | Canonical prefixed legacy prompts show legacy-only banner. | None. | New stories must not route to legacy phases. |

## Milestone Plan

### M0 - Baseline Inventory And Lockfile

**Goal:** Freeze the current 16-prompt baseline before any edits.

Subprojects:

- M0.1 Record the exact 16 prompt filenames and current template hashes from
  `promptRegistryManifest()`.
- M0.2 Capture current `lattice agent_prompt --role=<name>` output for every
  role as comparison artifacts.
- M0.3 Produce a role-overlap matrix covering phase, commands, direct file
  access, output artifact, and overlap category.
- M0.4 Add a regression check that fails if an active non-legacy prompt uses
  `testIntent` or `TEST_CASE_REVIEW` without an explicit legacy marker.
- M0.6 Add a regression check that flags prompts requiring direct writes under
  `docs/story/` unless a corresponding CLI command does not exist and the
  prompt is explicitly grandfathered.

Exit criteria:

- Every current prompt has a baseline hash and classification.
- Legacy terms are mechanically visible in the baseline report.
- No prompt content is edited in M0 except tests/docs required to record the
  baseline.

### M0.5 - Role Rename Compatibility And Dual-Prefix Window

**Goal:** Make `proof-or-stop-*` the canonical role namespace without breaking
in-flight stories or legacy evidence that still records `lattice-*` or
unprefixed role IDs.

Subprojects:

- M0.5.1 Define the canonical 16 role IDs:
  `proof-or-stop-review-story-init`, `proof-or-stop-review-scope-plan`,
  `proof-or-stop-implementer`, `proof-or-stop-review-behavior`,
  `proof-or-stop-review-quality`, `proof-or-stop-review-docs`,
  `proof-or-stop-review-concept`, `proof-or-stop-review-channel`,
  `proof-or-stop-review-test-coverage`, `proof-or-stop-review-delivery`,
  `proof-or-stop-evaluator`, `proof-or-stop-evaluator-cli`,
  `proof-or-stop-product-reviewer`, `proof-or-stop-implementation-reviewer`,
  `proof-or-stop-test-intent`, and `proof-or-stop-test-case-reviewer`.
- M0.5.2a Add legacy-alias **read path** normalization first. `agent_prompt`,
  reviewer evidence readers, quorum readers, delivery/floor consumers, and
  process-fact registry checks must keep reading existing `lattice-*` /
  unprefixed evidence.
- This read-path subproject must explicitly cover the current hardcoded role
  choke points:
  `REVIEW_RUN_LANES`, `isReviewerAgent`, `resolveReviewRunLane`,
  `finding_add` / pass-only finding reviewer classification,
  `REQUIRED_INIT_CHECK_AGENTS`, reviewer quorum/floor consumers, delivery
  consumers, and process-fact registry entries. A duplicated
  `agent.startsWith('lattice-review-')` check is a bug unless it delegates to
  the same normalization function.
- M0.5.2b Switch **new writes** to canonical `proof-or-stop-*` roles only.
  `review_run_start`, `finding_add`, `review_pass_set`, `init_check_set`, and
  `delivery_check_set` must not create new evidence under legacy names. This
  switch is blocked until M0.5.2a proves canonical roles are accepted by all
  read/gate consumers.
- M0.5.2c Rename or alias template files, YAML frontmatter, prompt registry
  entries, host shims, Codex manifests, and package prompt registry records so
  `lattice agent_prompt --role=proof-or-stop-review-quality` resolves the
  canonical prompt body.
- M0.5.3 Add role normalization for `agent_prompt`, `review_run_start`,
  `finding_add`, `review_pass_set`, pass-only finding normalization, quorum
  readers, delivery/floor consumers, and process-fact registry checks.
- M0.5.4 Keep in-flight legacy evidence readable: old `lattice-review-*`,
  `product-reviewer`, `implementation-reviewer`, `test-intent`, and
  `test-case-reviewer` values map to canonical roles for read/gate purposes
  during the compatibility window, while new writes use canonical
  `proof-or-stop-*` roles.
- M0.5.4a Treat `lattice-review-channel` as legacy read-compatible while
  in-flight evidence exists, but do not route it as an active reviewer and do
  not create new channel reviewer evidence. Channel enforcement belongs to the
  CLI gate.
- M0.5.5 Add a `lattice-residue` compatibility allowlist for static scans so
  expected legacy aliases are tracked intentionally and all other active prompt
  residues fail CI.
- M0.5.6 Add host-resolve golden fixtures for Codex, Claude Code, and
  Antigravity (`agy`) so all three resolve the same canonical role IDs before
  prompt body rewrites begin.
- M0.5.7 Define alias sunset policy:
  - legacy aliases are allowed while any non-terminal story references old role
    IDs;
  - terminal stories remain readable forever as historical evidence;
  - after migration scan reports zero non-terminal legacy role references and
    two CLI patch releases have shipped, legacy writes become hard errors;
  - `agent_prompt --role=<legacy>` moves from warn+resolve to fail with a
    replacement role.
- M0.5.8 Machine-define the migration scan scope used by M0.5.7:
  - include all non-terminal story artifact stores: review runs, review passes,
    findings, init-check, delivery-check, checklist verification evidence,
    test evidence, evaluator evidence, process events, and any configured story
    artifact store;
  - include prompt registry metadata, prompt frontmatter, package prompt
    registry, host manifests / adapter manifests, reviewer lane registry, INIT
    required-agent registry, quorum / host-verdict readers, process-fact
    registry, and static prompt assets under Codex / Claude / package templates;
  - exclude terminal DONE / DISCARDED story evidence from blocking sunset
    decisions. Terminal story evidence remains read-only historical evidence and
    must stay readable through legacy alias normalization.

Exit criteria:

- `lattice agent_prompt --role=proof-or-stop-review-quality` works.
- `lattice agent_prompt --role=lattice-review-quality` warns and resolves as a
  legacy alias, or fails with a precise replacement if no compatibility is
  needed.
- New review/finding/pass evidence is written with `proof-or-stop-*` lanes.
- Negative tests prove a `proof-or-stop-review-*` finding/pass is accepted only
  after a current signed review run, and a non-reviewer role cannot count as
  reviewer evidence.
- INIT tests prove both legacy required-agent evidence and canonical
  `proof-or-stop-review-story-init` / product-reviewer alias evidence are read
  during the compatibility window.
- Existing legacy lane evidence remains readable until the related story reaches
  terminal state.
- `lattice-review-channel` is either retained as read-only compatibility or
  removed with a migration note proving no non-terminal story still needs it.
- Host golden fixtures prove Codex, Claude Code, and Antigravity route to the
  same canonical roles.
- The alias sunset policy is encoded in tests or a machine-readable migration
  note, not only in prose.

### M1 - Role Taxonomy And Registry Metadata

**Goal:** Make the prompt registry describe whether a prompt is active,
conditional, advisory, or legacy.

Subprojects:

- M1.1 Extend prompt registry metadata with `canonicalRole`, `legacyAliases`,
  `lifecyclePhase`, `evidenceMode`, `status`, `ownerArtifact`, and
  `blockingSemantics`.
- M1.2 Classify active lifecycle prompts:
  `proof-or-stop-review-story-init`, `proof-or-stop-review-scope-plan`,
  `proof-or-stop-implementer`, `proof-or-stop-review-test-coverage`,
  `proof-or-stop-review-delivery`.
- M1.3 Classify active REVIEW specialist prompts:
  `proof-or-stop-review-behavior`, `proof-or-stop-review-quality`,
  `proof-or-stop-review-docs`, and conditional-active
  `proof-or-stop-review-concept`.
- M1.4 Decide evaluator `evidenceMode` here, not in M7: raw evaluator JSON is
  advisory, while persisted `eval-evidence.json` from `evaluate_save` is the
  current structured sink. Only add a new sink if this command is intentionally
  replaced.
- M1.5 Classify `proof-or-stop-product-reviewer` as blocked-for-fold until INIT
  compatibility is migrated or proven obsolete.
- M1.6 Classify `proof-or-stop-test-intent`,
  `proof-or-stop-test-case-reviewer`, and `proof-or-stop-review-channel` as
  legacy/retired unless migrated in later milestones.
- M1.7 Decide `scope-check.openQuestions` gate semantics before prompt rewrites:
  open questions are advisory/review context by default because they are outside
  the current signature domain; they may block only after a structured
  resolution command or signature-domain update makes the blocker tamper-evident.

Exit criteria:

- `lattice agent_prompt --role=<name>` can display role status or the registry
  exposes it to callers.
- `lattice reviewer_list` and routing docs stop treating retired prompts as
  default reviewer lanes.
- Unknown or legacy role usage produces guidance pointing to the active
  `proof-or-stop-*` role.
- Evaluator gate/advisory status is fixed before routing or prompt rewrites rely
  on evaluator output.
- `reviewer_list` or equivalent status output includes each role's status,
  routing reason, and whether the role can block a gate.

### M2 - Legacy Verification Flow Retirement Or Migration

**Goal:** Remove accidental use of the old `testIntent` flow from new stories.

Subprojects:

- M2.1 Rewrite `proof-or-stop-test-intent` as either:
  - a new `proof-or-stop-verification-intent` prompt that writes
    `verificationIntent`, or
  - a legacy-only prompt with a hard banner saying it is not for new stories.
- M2.2 Rewrite `proof-or-stop-test-case-reviewer` as either:
  - an alias/compatibility wrapper for `proof-or-stop-review-test-coverage`, or
  - a legacy-only prompt usable only for old stories already in legacy phases.
- M2.3 Update `proof-or-stop-product-reviewer` and
  `proof-or-stop-implementation-reviewer` to remove casual `testIntent`
  references.
- M2.4 Add smoke tests that scan active prompts for `testIntent`,
  `testintent_*`, `TEST_CASE`, and `TEST_CASE_REVIEW`.
- M2.5 Update examples to use `verificationIntent`,
  `verification_evidence_add`, and `proof-or-stop-review-test-coverage`.
- M2.6 Preserve `express-exempt` as a structured lifecycle fact for allowed
  fast paths; do not recreate old legacy verification bypasses in prompt prose.

Exit criteria:

- New-story prompt routing never names `proof-or-stop-test-intent`,
  `proof-or-stop-test-case-reviewer`, or their legacy aliases.
- Active prompts describe `verificationIntent` / `verificationEvidence`.
- Legacy prompts cannot be mistaken for active lifecycle prompts.
- Express/fast paths still require the configured evidence facts and do not
  silently bypass verification coverage.

### M3 - Duplicate Reviewer Responsibility Split

**Goal:** Assign each recurring review concern to one owner.

Subprojects:

- M3.1 Make `proof-or-stop-review-docs` the REVIEW owner of doc-code drift and
  docs-promised-code-missing findings.
- M3.2 Remove `doc-promise-undelivered` closing self-checks from
  `proof-or-stop-review-behavior`, `proof-or-stop-review-quality`,
  `proof-or-stop-review-concept`, and `proof-or-stop-review-channel`.
- M3.3 Keep `proof-or-stop-review-delivery` focused on final delivery promises and
  real machine tests. It may consume docs-review evidence but should not
  duplicate every REVIEW doc scan by default.
- M3.4 Make `proof-or-stop-review-concept` own only concept residue and only run when
  concept deletion/replacement is detected by CLI preflight or routing.
- M3.5 Fold `proof-or-stop-implementation-reviewer` into
  `proof-or-stop-review-quality` and `proof-or-stop-review-behavior`; remove it
  from active Proof-or-Stop routing.
- M3.6 If `proof-or-stop-review-docs` is not routed for a story, require
  `proof-or-stop-review-delivery` to run a final docs-promise fallback scan
  before `delivery_check_set`.

Exit criteria:

- A single doc promise defect should produce at most one REVIEW finding owner.
- Reviewer prompts no longer tell multiple agents to perform the same reverse
  docs-to-code scan.
- Retained overlaps are intentional and documented as phase-separated
  (`docs` in REVIEW, `delivery` in TEST/DONE).
- Delivery fallback covers docs promises only when no docs reviewer ran.
- Reviewer count before/after this split is recorded for at least one injected
  docs-promise defect scenario; the expected result is one REVIEW owner finding.

### M4 - CLI-Mediated Story Artifact Discipline

**Goal:** Remove prompt instructions that directly write story artifacts.

Subprojects:

- M4.0 Split M4 into rollback-safe implementation stories: direct-write ban
  first, direct-read replacement second, INIT self-check migration third, and
  channel retirement/static scans last.
- M4.1 Audit every prompt for `docs/story/`, `checklist.json`,
  `background.md`, `index.json`, `process-events.jsonl`, and fixture file
  access.
- M4.2 Replace direct reads with CLI commands where available:
  `story_get`, `checklist_get`, `review_incremental_context`,
  `finding_list`, `validate`, `scope_check_get`, or new read-only APIs.
- M4.3 Replace direct writes with CLI commands:
  `init_check_set`, `scope_check_save`, `review_pass_set`,
  `finding_add`, `verification_evidence_add`, `delivery_check_set`.
- M4.4 Remove or CLI-ize `proof-or-stop-review-story-init`'s
  `init-self-check.json` write path while preserving any fresh-context /
  anti-self-exemption fence semantics as signed CLI evidence.
- M4.5 Replace `proof-or-stop-review-channel` direct process-events inspection with
  `lattice validate --channel`, or retire the prompt.
- M4.6 Move static prompt scans for direct story writes, legacy vocabulary, and
  non-allowlisted `lattice-*` role residue into this milestone so later prompt
  rewrites cannot regress.

Exit criteria:

- Active prompts do not instruct agents to create/edit `docs/story` files.
- Direct story-file reads exist only where no CLI reader exists and are
  explicitly documented as temporary.
- Prompt tests fail on new direct story writes.
- The INIT self-check replacement is either demonstrably unnecessary or
  preserved by a CLI-mediated artifact consumed by the same gate.
- Static scans distinguish allowed legacy aliases from accidental active
  `lattice-*` role residue.
- Each M4 sub-story can be rolled back without reverting unrelated reader,
  writer, INIT, or channel changes.

### M5 - Prompt Runtime Guide Consistency

**Goal:** Ensure every active prompt receives the same load-bearing lifecycle
and process-fact guidance.

Subprojects:

- M5.1 Add the canonical load-bearing runtime guide to
  `proof-or-stop-evaluator-cli`, replacing the inert `<!-- lattice:start-slot -->`.
- M5.2 Decide whether advisory-only prompts need the full guide or a compact
  advisory guide. Apply consistently.
- M5.3 Reconcile the canonical runtime guide in
  `packages/main/src/core/prompt-registry.ts` with the guide embedded in
  templates so smoke tests verify the actual current text.
- M5.4 Update prompt-registry smoke tests to include all active prompts that
  must carry the guide.
- M5.5 Add a test that `lattice agent_prompt --role=<name>` output contains no
  unexpanded placeholder markers such as `lattice:start-slot`.

Exit criteria:

- Active prompts have the correct guide.
- No prompt served by `agent_prompt` contains unexpanded marker placeholders.
- Prompt registry tests compare against the current canonical guide text.

### M6 - Scope And Spec Scan Narrowing

**Goal:** Keep reviewers thorough without making every story responsible for
the entire historical decisions directory.

Subprojects:

- M6.1 Generate or consume a bounded `candidateSpecSet` before any broad spec
  scan. The set is derived from related docs, story title/description, changed
  files/symbols, command/config names, `aux_doc_list`, and top-N `rg` matches.
- M6.2 Keep `proof-or-stop-review-scope-plan` as PLAN scope owner, but feed it
  the candidate set instead of an unconditional full decisions scan whenever
  the candidate set is unambiguous.
- M6.3 Change `proof-or-stop-review-behavior` to consume `scope_check_save`,
  current diff, current story commitments, and `userSees` context. Behavior
  review is forbidden from default full `decisions/*.md` scanning.
- M6.4 Define when full decisions scan is still required: high-risk story,
  lifecycle change, gate change, process-fact change, global rename, candidate
  ambiguity, or explicit reviewer escalation. Every full scan must record a
  `scanEscalationReason`.
- M6.5 Add examples for "covered", "excluded", "orphan-suspect", and "not
  current-story scope" so reviewers do not turn all old plans into blockers.
- M6.6 Add regression fixtures showing unrelated decisions docs do not create
  behavior-review findings, and keep `express-exempt` / fast-path verification
  scope visible in routing output so scan narrowing does not hide why a prompt
  did not run.
- M6.7 Record token/search metrics in the sample flow: memory/playbook hit
  count, candidate docs count, `rg` query count, full-scan yes/no,
  `scanEscalationReason`, and structured skip reason. A skipped scan must state
  whether it was skipped due to candidate spec set, express/fast path, or
  not-current-story scope. Default budgets are `candidateSpecSet <= 8` docs and
  `rg` query count `<= 10`; exceeding either budget requires the same structured
  escalation reason discipline as a full decisions scan. Evaluator opt-in cost is
  recorded separately from baseline REVIEW cost.
- M6.8 Connect INIT, PLAN, and REVIEW prompts to bounded memory/playbook
  preflight without treating memory/playbook output as gate evidence.
- M6.9 Require `reviewer_list` or equivalent routing output to expose the default
  REVIEW lane cap, every conditional lane's routing reason, and every skipped
  reviewer reason before M9 E2E speed comparisons.

Exit criteria:

- PLAN still catches requirement gaps.
- REVIEW behavior no longer reports unrelated historical spec commitments as
  current-story bugs.
- High-risk process/gate changes still trigger broad scope review.
- Fast-path stories show an explicit scope/evidence reason when review lanes are
  narrowed or skipped.
- Full-scan trigger/skip metrics are available before M9 E2E rollout.
- Default search budgets are machine-visible: `candidateSpecSet <= 8`, `rg`
  query count `<= 10`, full-scan yes/no, `scanEscalationReason`, metric sink,
  and evaluator opt-in cost are recorded.
- REVIEW behavior pass/finding records show whether they used only
  `scope_check_save` + current diff + `userSees`, or escalated with a recorded
  full-scan reason.

### M7 - Product, Delivery, And Evaluator Boundary

**Goal:** Separate "behavior works", "user experience is acceptable", and
"delivery artifact is honest".

Subprojects:

- M7.1 Define `proof-or-stop-review-behavior` as code-behavior correctness, not UX
  scoring.
- M7.2 Define `proof-or-stop-evaluator` and `proof-or-stop-evaluator-cli` as
  user-facing exercise lanes, using the `evidenceMode` decision already made in
  M1.
- M7.3 Fold `proof-or-stop-product-reviewer` into
  `proof-or-stop-review-delivery`, or keep it as advisory user-value review
  with no gate claims after INIT compatibility is resolved.
- M7.4 Make `proof-or-stop-review-delivery` the only owner of final
  `delivery_check_set`.
- M7.5 Add guidance for when transcript/delivery evidence is required and how
  non-mechanical user approval must be labeled.

Exit criteria:

- A product-completeness concern has one final owner.
- Evaluator raw JSON is advisory; persisted `eval-evidence.json` is structured
  evidence only under workflow policy.
- Delivery review does not pretend browser/API exercise happened unless an
  evaluator or transcript actually provided it.
- `proof-or-stop-product-reviewer` is not downgraded while INIT still requires
  its output.

### M8 - Routing, Help, And Spawn Guidance

**Goal:** Make agents and humans pick the correct prompt without remembering
the taxonomy.

Subprojects:

- M8.1 Update `lattice reviewer_list` or equivalent routing output to show
  active, conditional, advisory, retired, and legacy roles.
- M8.2 Update `lattice agent_prompt --role=<legacy>` to print a clear legacy
  warning before body content and point to the canonical `proof-or-stop-*`
  role.
- M8.3 Update `session_brief`, phase hints, and docs to route:
  - INIT to `proof-or-stop-review-story-init`
  - PLAN scope to `proof-or-stop-review-scope-plan`
  - DEV work to `proof-or-stop-implementer` only when the channel policy requires it
  - REVIEW coverage to `proof-or-stop-review-test-coverage`
  - TEST/DONE delivery to `proof-or-stop-review-delivery`
- M8.4 Replace any route to `proof-or-stop-review-channel` with
  `lattice validate --channel`.
- M8.5 Add examples of correct spawn prompts that include storyId, phase,
  allowed inputs, and required first CLI command.
- M8.6 Expose the max default REVIEW lanes and conditional routing reason so
  faster default flows do not hide skipped reviewers.
- M8.7 Show skipped reviewers and skip reasons in routing/help output when a
  reviewer is conditional, folded, retired, or advisory-only.

Exit criteria:

- A fresh agent can discover the right prompt from CLI hints.
- Retired/legacy roles are not listed as normal active choices.
- Prompt routing matches actual gates.
- Help output documents legacy alias behavior and the compatibility window.
- Routing output includes enough status to explain speed decisions.
- Skipped reviewer output is explicit enough that faster routing cannot be
  mistaken for silent assurance removal.

### M9 - End-To-End Regression And Rollout

**Goal:** Prove the prompt consolidation does not weaken the lifecycle.

Subprojects:

- M9.1 Run prompt registry smoke tests.
- M9.2 Run process-fact contract tests.
- M9.3 Run Codex adapter verification if prompt assets, manifests, or adapter
  routing changed.
- M9.4 Run a sample story through INIT/PLAN/DEV/REVIEW/TEST using the new
  prompt routing.
- M9.5 Confirm no active prompt directly writes story files, uses legacy
  verification vocabulary, or duplicates another prompt's owner check.
- M9.6 Run static scans for non-allowlisted `lattice-*` role residue, unprefixed
  canonical agent names, unexpanded prompt guide markers, and direct story-file
  write instructions.
- M9.7 Measure speed impact: default REVIEW lane count, full decisions scan
  frequency, sample-story token/time baseline, and evaluator opt-in cost.
- M9.8 If CLI/runtime behavior changed, bump the CLI patch version, sync
  package/lock/version constants, rebuild, and verify `lattice --version`.
- M9.9 Run `node bin/lattice.js verify_codex` when Codex prompt assets,
  manifests, wrappers, or telemetry/gate code changed.

Exit criteria:

- The sample story reaches TEST without legacy prompt usage.
- REVIEW findings/pass records are structured and bound to current review runs.
- Delivery evidence remains signed and separate from ordinary prose.
- No DONE, review, or verification gate is weakened.
- `proof-or-stop-*` canonical roles work in prompt registry, host adapters,
  reviewer lanes, review/finding/pass writes, quorum readers, and process-fact
  checks.
- Legacy aliases are warning/compatibility only and do not create new evidence
  under old names.
- Speed metrics show the smaller default prompt set does not remove required
  assurance.

## Cross-Cutting Validation Matrix

| Risk | Validation |
|---|---|
| Legacy `testIntent` resurfaces in new flow | Static scan active prompts; sample story uses `verificationIntent` only. |
| `proof-or-stop-*` rename is only documentation | Prompt registry, host adapters, reviewer lanes, review/finding/pass writes, quorum readers, and process-fact tests all use canonical roles. |
| In-flight legacy evidence breaks after rename | Alias-normalization tests read legacy `lattice-*` and unprefixed role evidence while new writes use `proof-or-stop-*`. |
| INIT self-check fence is accidentally removed | Gate test proves an equivalent CLI-mediated fresh-context artifact exists, or proves the old artifact is no longer consumed. |
| Duplicate doc findings overwhelm REVIEW | One injected docs-promise defect creates one owner finding from `proof-or-stop-review-docs`. |
| Retired channel reviewer still blocks or duplicates CLI gate | `reviewer_list` excludes `proof-or-stop-review-channel`; `validate --channel` remains authoritative. |
| Prompt tells agent to edit story files | Static scan for direct write language under `docs/story`; prompt tests fail on new violations. |
| Evaluator output is mistaken for gate evidence | Evaluator prompt and routing label raw JSON as advisory; only `evaluate_save` output can satisfy evaluator policy. |
| Raw evaluator JSON bypasses DONE | Negative test writes raw evaluator JSON without `evaluate_save`; DONE must not treat it as evaluator pass evidence. |
| Status-changing command hides progress from the user | Mutation-output tests assert either a real `Milestone Status - <storyId>` table or the distinct checklist-derived block appears for human text output; prompt tests forbid agents from hand-writing milestone status. |
| Runtime guide drift | Prompt registry smoke compares every active guide-bearing prompt to the canonical guide. |
| Scope reviewer reports unrelated old decisions as current gaps | Fixtures include unrelated decisions docs and expect no REVIEW behavior finding. |
| Memory/playbook recall is mistaken for proof | Tests or prompt snapshots assert memory/playbook preflight is labeled advisory, non-authoritative, and `gateEvidence=false`; no lifecycle gate consumes it as evidence. |
| Memory no-hit causes unbounded scan | PLAN/REVIEW fixtures simulate no memory/playbook hit and require a bounded `candidateSpecSet` plus skip/escalation reason before any full decisions scan is allowed. |
| Search budget silently expands | Fixture or snapshot asserts the default `candidateSpecSet <= 8`, `rg` query count `<= 10`, full-scan yes/no, `scanEscalationReason`, metric sink, and evaluator opt-in cost accounting are emitted. |
| Alias sunset scan misses legacy evidence | Migration scan fixture includes non-terminal story artifact stores plus prompt registry/frontmatter, host manifests, reviewer/init/process-fact registries, package templates, and confirms terminal story evidence remains read-only historical evidence. |

## Suggested Final Prompt Set

The final system should default to **9 active prompts**, keep **2 optional
evaluator prompts**, keep **1 product lane blocked-for-fold**, fold/retire
**1 implementation-review prompt**, and mark **3 prompts retired/legacy** unless
later milestones migrate them:

| Status | Agents |
|---|---|
| Active lifecycle | `proof-or-stop-review-story-init`, `proof-or-stop-review-scope-plan`, `proof-or-stop-implementer`, `proof-or-stop-review-test-coverage`, `proof-or-stop-review-delivery` |
| Active REVIEW specialist | Default: `proof-or-stop-review-behavior`, `proof-or-stop-review-quality`, `proof-or-stop-review-docs`; conditional-active: `proof-or-stop-review-concept` |
| Optional/advisory evaluator | `proof-or-stop-evaluator`, `proof-or-stop-evaluator-cli` |
| Blocked fold/advisory | `proof-or-stop-product-reviewer` |
| Fold/retire | `proof-or-stop-implementation-reviewer` |
| Retired/legacy | `proof-or-stop-test-intent`, `proof-or-stop-test-case-reviewer`, `proof-or-stop-review-channel` |

If a later story chooses a smaller final set, it must preserve the same owner
coverage:

- INIT readability/factual sanity
- PLAN scope coverage
- DEV implementation ownership/channel evidence
- REVIEW behavior correctness
- REVIEW quality/maintainability
- REVIEW docs/code drift
- REVIEW concept residue when applicable
- REVIEW verification evidence coverage
- TEST/DONE delivery honesty
- Optional product/evaluator exercise

## Story Breakdown And Parallel Execution Plan

Recommended implementation size: **26 Lattice stories**. This is the smallest
recommended breakdown that keeps the dangerous rename, gate, prompt, routing,
and rollout changes independently reviewable and revertible without making each
prompt a separate tiny story.

| Milestone area | Story count | Story boundary | Parallelism |
|---|---:|---|---|
| M0 baseline | 2 | Baseline/hash inventory; legacy/direct-write scan baselines. | Serial first, because later stories compare against this inventory. |
| M0.5 role rename compatibility | 5 | Alias read path; canonical new-write path; prompt/template/registry/host-shim aliasing; three-host golden fixtures; alias sunset and residue allowlist. | Mostly serial. Read path must land before canonical writes; host fixtures can run after read path and before broad rewrites. |
| M1 registry metadata | 3 | Metadata schema/status fields; evaluator `evidenceMode`; reviewer/routing status output. | Can partly parallelize after M0.5 read compatibility exists. |
| M2 legacy verification migration | 3 | `testIntent` prompt migration or legacy banners; active prompt vocabulary scans; express/fast evidence-policy examples. | Parallel with M3/M5 after M1 status fields exist. |
| M3 duplicate responsibility split | 3 | Docs owner split; behavior/quality/concept cleanup and implementation-reviewer fold; delivery fallback contract. | Parallel with M2/M5/M6 once M1 status metadata exists. |
| M4 CLI-mediated artifact discipline | 4 | Direct-write ban; direct-read replacement APIs; INIT self-check migration; channel retirement/static scans. | Internal order should stay mostly serial; can run beside M2/M3 if it does not touch the same prompt bodies. |
| M5 runtime guide consistency | 2 | Guide insertion/sync; prompt registry smoke tests. | Parallel with M2/M3 after M1 metadata exists. |
| M6 scope/spec scan narrowing | 1 | Candidate spec set, bounded memory/playbook preflight, default search budgets, skip reasons, token/search metrics, and full-scan trigger rules. | Parallel after M1, but before M8 routing help freezes. |
| M7 product/delivery/evaluator boundary | 1 | Product-reviewer fold/advisory decision and evaluator transcript boundary. | Parallel after evaluator `evidenceMode` is decided in M1. |
| M8 routing/help/spawn guidance | 1 | Human and host routing output, skipped reviewer reasons, legacy alias guidance. | Late serial merge point after M2-M7 semantics stabilize. |
| M9 E2E regression and rollout | 1 | Prompt registry, process-fact, adapter, sample lifecycle, speed metrics, and release/version checks if runtime changed. | Final serial closure. |
| **Total** | **26** |  |  |

Critical path:

1. M0 baseline.
2. M0.5 read compatibility.
3. M0.5 canonical write compatibility.
4. M1 registry metadata and evaluator evidence mode.
5. Parallel lanes M2, M3, M4, M5, M6, and M7, with local conflict checks.
6. M8 routing/help once semantics stop moving.
7. M9 end-to-end rollout.

Parallel development is supported because each story gets its own worktree, but
parallel stories must avoid touching the same prompt body, registry file, or
reviewer-lane gate at the same time. Any story that changes process-fact
semantics, reviewer lanes, init gates, or evidence freshness must refresh from
main and rerun the relevant contract tests before DONE.

## Implementation Order

Recommended execution order:

1. M0 baseline inventory.
2. M0.5 role rename compatibility: legacy read path first, canonical writes
   second, host golden fixtures third.
3. M1 registry metadata and evaluator evidenceMode decision.
4. M2 legacy verification migration.
5. M3 duplicate responsibility split.
6. M4 story artifact discipline and early static scans.
7. M5 runtime guide consistency.
8. M6 scope scan narrowing.
9. M7 product/delivery/evaluator boundary.
10. M8 routing and help updates.
11. M9 end-to-end regression.

M0.5 must land before broad prompt rewrites, because every later artifact should
write canonical `proof-or-stop-*` role IDs while still reading in-flight legacy
evidence. The read-path and write-path parts of M0.5 should remain separately
revertible. M1 must decide evaluator evidenceMode before M7 describes evaluator
semantics. M2 and M3 should land before large body rewrites; they remove the
biggest semantic ambiguity first. M4 and M5 should land before host adapter
verification so prompt output and process-fact guidance are stable. M8 should
be late because routing should point to the new stable taxonomy, not to an
intermediate state.

## Non-Goals

- Do not weaken INIT, REVIEW, TEST, or DONE gates.
- Do not remove structured reviewer evidence requirements.
- Do not make prompt-only statements count as gate evidence.
- Do not push story branches or remote feature branches as part of prompt
  consolidation.
- Do not delete legacy prompts until routing and compatibility behavior are
  explicit.
- Do not use `.omx` for plans, logs, baselines, or runtime artifacts.

## Open Decisions

1. Should `proof-or-stop-product-reviewer` be merged into
   `proof-or-stop-review-delivery`, or remain an advisory product acceptance
   reviewer after INIT compatibility is resolved?
2. If a non-Proof-or-Stop project still wants a standalone implementation
   reviewer, should it live outside the active Proof-or-Stop lifecycle registry?
3. Should `proof-or-stop-test-intent` become a new
   `proof-or-stop-verification-intent` prompt, or should verification intent
   authoring stay with the main agent/checklist flow?
4. Should `proof-or-stop-evaluator` / `proof-or-stop-evaluator-cli` continue to
   use current `evaluate_save` / `eval-evidence.json`, or should a later story
   replace that sink with a more explicit evaluator-run artifact?
5. Should the default M6 search budgets (`candidateSpecSet <= 8`, `rg` query
   count `<= 10`) become project-configurable after the first implementation
   story proves the routing/sample-flow metric sink?

## Completion Definition

For the B-2861 document-review story, the required DONE optimization table is
the **B-2861 3x2 Review Follow-Up Ledger** above. It must keep every accepted,
deferred, or rejected review item tied to a reason and local evidence.

This execution plan is complete only when:

- The 16 prompt templates are classified as active, optional, advisory, retired,
  or legacy.
- Every canonical agent role uses the `proof-or-stop-*` prefix in prompt
  registry metadata, frontmatter, host shims, Codex manifests, routing output,
  reviewer lanes, and new evidence writes.
- Legacy role IDs are accepted only as warning/compatibility aliases and do not
  create new evidence under old names.
- New-story routing never points to legacy `testIntent` prompts.
- Duplicate docs-promise checks are removed from non-owner reviewers.
- Active prompts use current process-fact vocabulary and structured evidence
  commands.
- The artifact schema / writer / reader / freshness table has a corresponding
  test or registry entry for every gate-consumed artifact.
- Active prompts do not instruct direct story artifact writes.
- The INIT self-check / fresh-context fence is preserved through CLI evidence or
  removed only after gates/tests prove it is no longer required.
- Evaluator output mode is fixed: raw JSON is advisory; only `evaluate_save`
  output can become policy-gated evidence.
- Prompt registry and adapter verification pass.
- Speed metrics for default REVIEW lanes, candidate docs count,
  memory/playbook hit count, `rg` query count, full decisions scans,
  `scanEscalationReason`, sample-story token/time cost, and evaluator opt-in
  cost are captured.
- A representative story can run through the lifecycle using the consolidated
  prompts without weakening gates or producing duplicate reviewer findings.
