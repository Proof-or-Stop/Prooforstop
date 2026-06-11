# Lattice Review Reflection Loop

> Version: v0.1 draft
> Scope: Host-neutral REVIEW-stage repair loop
> Status: Proposal

## 1. Positioning

Review Reflection Loop is a controlled repair loop introduced at the REVIEW
stage of Lattice. It turns review failures, findings, validation failures, and
scope violations into bounded, auditable, recoverable engineering cycles.

The loop is not an infinite retry mechanism inside a single agent. Lattice
loops around agent work. Each iteration records the triggering evidence, current
diff and material hashes, host capability context, structured reflection, the
next repair prompt patch, verification references, and a policy-based decision.

Core rules:

- Reflection is not evidence.
- Prompt text is not a source of truth.
- Host output remains local evidence unless authority receipts are verified.
- The loop cannot bypass reviewer runs, validation, scope gates, DONE gates, or
  authority boundaries.
- The loop only produces repair candidates and structured decisions that must
  return to the normal Lattice lifecycle.

## 2. Problem Statement

Most AI programming workflows still rely on prompt engineering: the user writes
a prompt, the agent executes it, and the user writes another prompt when it
fails. This pattern is useful for small tasks, but it breaks down on complex
engineering work.

Typical failure modes:

- Human-written prompts are hard to reuse consistently.
- Agents can carry a wrong assumption into the next attempt.
- Failures are not classified as requirement, context, host, tool, or code
  failures.
- Retry behavior has unclear stop, rollback, and escalation boundaries.
- A single host can keep retrying even when the right decision is handoff.
- The process can look active while making the project less safe.

Review Reflection Loop replaces prompt-only iteration with loop engineering:
observe evidence, reflect structurally, evaluate policy, decide the next
lifecycle action, and preserve lineage.

## 3. Scope

Version 0.1 is controlled from the REVIEW stage. Code-changing repair still
uses the normal Lattice lifecycle: REVIEW identifies the failure, the loop
records reflection and the next repair plan, and any material implementation
change returns through DEV before a fresh REVIEW run.

Valid triggers:

- Blocking reviewer finding.
- Coverage reviewer failure.
- TEST validation failure that returned the story to DEV and later re-enters
  REVIEW with fresh evidence.
- Scope contract violation.
- Guard session violation.
- Signed reviewer finding that requests targeted re-verification. Free-form
  reviewer requests are not loop triggers.

Out of scope for v0.1:

- PLAN-stage requirement clarification.
- General DEV-stage autonomous coding loops.
- TEST/DONE auto-repair.
- Auto-merge.
- Auto-DONE.
- Production authority claims.
- Receipt verification.
- Automatic host spawning.

This narrow scope is deliberate. REVIEW is the correct first home for the
mechanism because REVIEW already decides whether work is acceptable, incomplete,
risky, or needs repair. The loop may create a DEV repair instruction, but it
does not make REVIEW a code-editing phase.

## 4. State Machine

```text
REVIEW finding / failure
  -> LOOP_OPEN
  -> REFLECT
  -> PLAN_REPAIR
  -> DECIDE
       | continue / retry / revise
       |   -> REPAIR_REQUIRED
       |   -> story_advance REVIEW -> DEV
       |   -> DEV repair + verificationEvidence + commit
       |   -> story_advance DEV -> REVIEW
       |   -> REVIEW_REFRESH
       |   -> REFLECT
       |
       | rollback_required
       |   -> LOOP_CLOSED_BLOCKED + rollback plan
       |
       | handoff_recommended
       |   -> LOOP_CLOSED_BLOCKED + handoff guidance
       |
       | human_gate_required
       |   -> LOOP_CLOSED_BLOCKED + human question
       |
       | close_candidate
       |   -> REVIEW_REFRESH
       |   -> fresh reviewer pass or trigger resolution required
       |   -> LOOP_CLOSED_RESOLVED
       |
       | stop_blocked
       |   -> LOOP_CLOSED_BLOCKED
```

`close_candidate` is not a pass. It means the loop believes the repair candidate
is ready for normal Lattice review refresh. The story still needs a fresh
reviewer run, finding resolution or review pass, validation evidence, and all
normal lifecycle gates.

## 5. Decision Types

| Decision | Meaning | Typical trigger |
|---|---|---|
| `continue` | Current direction is making verifiable progress. | Tests did not regress, diff is in scope, next step is clear. |
| `retry` | Same step can be retried safely. | Network error, transient tool failure, temporary dependency issue. |
| `revise` | The plan, context, or prompt needs revision before continuing. | Output drifted, context was incomplete, root cause hypothesis changed. |
| `rollback_required` | Current changes are unsafe and should be reverted or manually reviewed. | Protected files touched, build regressed, unrelated diff expanded. |
| `handoff_recommended` | Current host is not suitable for the next step. | Missing browser, shell, patch, or test capability. |
| `human_gate_required` | Human decision is required before continuing. | Product tradeoff, scope expansion, production, legal, payment, permissions. |
| `close_candidate` | Candidate repair appears complete and should enter reviewer refresh. | Finding appears addressed and evidence is fresh. |
| `stop_blocked` | The loop cannot safely continue. | Budget exhausted, max iterations reached, repeated no-progress iterations. |

## 6. Decision Priority

Loop decisions must be constrained by a deterministic policy oracle. The agent
may recommend a decision, but the policy evaluator has final priority ordering.

Priority order:

1. Protected file or protected anchor touched -> `rollback_required`.
2. Production, payment, legal, credential, permission, or destructive data risk
   -> `human_gate_required`.
3. Tests or build regressed from passing to failing -> `rollback_required`.
4. Maximum iterations, runtime, or budget reached -> `stop_blocked`.
5. No meaningful progress for N iterations before the hard caps above are
   reached -> `human_gate_required`.
6. Host capability is insufficient -> `handoff_recommended`.
7. Finding remains open but there is verifiable progress -> `continue` or
   `revise`.
8. Finding appears fixed with fresh evidence -> `close_candidate`.

This ordering prevents the common failure where an agent chooses "try again" in
a case that actually requires rollback or human escalation.

The loop records the next repair instruction. It does not apply material
changes in REVIEW. Any code-changing repair must use the existing lifecycle
rollback to DEV, then return to REVIEW with fresh evidence and a fresh reviewer
run.

## 7. Data Model

The first implementation should use a story-scoped artifact, projected through
the StoryStore. The physical backing path is an implementation detail. The
conceptual artifact is `review-loops.jsonl`.

```ts
type ReviewLoopDecision =
  | "continue"
  | "retry"
  | "revise"
  | "rollback_required"
  | "handoff_recommended"
  | "human_gate_required"
  | "close_candidate"
  | "stop_blocked";

type ReviewLoopStatus = "open" | "resolved" | "escalated" | "blocked";

type ReviewLoopRecord =
  | ReviewLoopStart
  | ReviewLoopIteration
  | ReviewLoopClose;

interface ReviewLoopTrigger {
  findingIds?: string[];
  bugIds?: string[];
  validationFailureRefs?: string[];
  scopeViolationRefs?: string[];
}

interface ReviewLoopRollbackRef {
  headHash: string;
  diffHash: string;
  materialHash: string;
  scopeContractHash?: string;
}

interface ReviewLoopStart {
  schemaVersion: "lattice.review_loop_start.v1";
  event: "start";
  loopId: string;
  storyId: string;
  reviewRound: string;
  status: "open";
  trigger: ReviewLoopTrigger;
  rollbackRef: ReviewLoopRollbackRef;
  openedAt: string;
  actor: string;
}

interface ReviewLoopIteration {
  schemaVersion: "lattice.review_loop_iteration.v1";
  event: "iteration";
  loopId: string;
  storyId: string;
  reviewRound: string;
  status: "open";
  iteration: number;

  trigger: ReviewLoopTrigger;

  host: {
    hostId: string;
    capabilitySnapshotRef?: string;
    visibleDegradations?: string[];
  };

  rollbackRef: ReviewLoopRollbackRef;

  reflection: {
    progress: "improved" | "unchanged" | "regressed";
    evidenceQuality: "strong" | "medium" | "weak";
    failureType?: "prompt" | "context" | "tool" | "host" | "requirement" | "external";
    riskLevel: "low" | "medium" | "high";
    rootCauseHypothesis: string;
    nextPromptPatch?: string;
    recommendedDecision: ReviewLoopDecision;
    reason: string;
    reusableLearning?: string;
  };

  evaluation: {
    progressScore?: number;
    riskScore?: number;
    regressionScore?: number;
    confidenceScore?: number;
    costMeasured: boolean;
    costUsedUSD?: number;
    timeUsedMs?: number;
    commandsRun: string[];
    evidenceRefs: string[];
  };

  decision: ReviewLoopDecision;
  decisionReason: string;

  nextAction?: {
    nextPrompt?: string;
    rollbackCommandHint?: string;
    handoffHostId?: string;
    humanQuestion?: string;
  };

  createdAt: string;
  actor: string;
}

interface ReviewLoopClose {
  schemaVersion: "lattice.review_loop_close.v1";
  event: "close";
  loopId: string;
  storyId: string;
  reviewRound: string;
  status: "resolved" | "escalated" | "blocked";
  trigger: ReviewLoopTrigger;
  materialHash: string;
  resolvedEvidenceRefs?: string[];
  supersedingEvidenceRefs?: string[];
  closeReason: string;
  closedAt: string;
  actor: string;
}
```

Required invariants:

- Every record must bind to a story.
- Every active REVIEW loop must bind to at least one finding, bug, validation
  failure, or scope violation.
- Every iteration must include a rollback reference.
- Every iteration must include a structured reflection reason and a structured
  policy decision reason.
- `reusableLearning` is optional context only and cannot satisfy gate evidence.
- `diffHash` is a SHA-256 digest over the cumulative diff from
  `rollbackRef.headHash` to the iteration's current worktree state. If the
  implementation uses a different diff source, it must name that source in the
  schema and tests.
- `scopeContractHash` is required when the loop trigger includes a scope
  violation or when an active scope contract exists.
- `reflection.recommendedDecision` records the agent/reflection recommendation.
  `reflection.reason` records the agent/reflection rationale. The top-level
  `decision` and `decisionReason` record the policy evaluator's final decision
  and rationale. If policy overrides the recommendation, both values must remain
  visible for audit.
- REVIEW gate derives loop state by grouping `ReviewLoopRecord` entries by
  `loopId` and reading the latest record's `status`. `status="open"` means the
  loop gate blocks `REVIEW -> TEST`; `resolved`, `escalated`, and `blocked` mean
  the loop record is closed, with normal finding, bug, scope, validation, and
  DONE gates still applying.

## 8. CLI Surface

Version 0.1 should expose recording and decision commands only. It should not
execute agents automatically.

| Command | Purpose | Mutation class | Process fact level |
|---|---|---|---|
| `review_loop_start` | Open a loop for one or more findings/failures. | Story-scoped mutating | L4, gate-consumed loop state |
| `review_loop_iteration_add` | Record one reflection/evaluation/decision iteration. | Story-scoped mutating | L4, gate-consumed loop state |
| `review_loop_status` | Read current loop status and next action. | Read-only | L0 |
| `review_loop_close` | Close the loop as resolved, escalated, or blocked. | Story-scoped mutating | L4, gate-consumed loop state |
| `review_loop_policy_show` | Show the effective loop policy. | Read-only | L0 |

Because active loop state blocks `REVIEW -> TEST`, the mutating loop commands
are gate-consumed process facts. Implementation must update command policy,
owner-lease behavior, process fact registry, lifecycle gate rows, and contract
verification together.

Deferred commands:

| Deferred command | Reason to defer |
|---|---|
| `review_loop_execute` | Too easy to become uncontrolled autopilot. |
| `review_loop_dispatch` | Should wait until handoff and host dispatch integration is stable. |
| `review_loop_rollback_plan` | Useful, but rollback semantics need careful destructive-command boundaries. |
| `review_loop_policy_set` | Default policy should stabilize before project-level overrides. |

## 9. Loop Policy

The default policy should be conservative and local-workflow safe.

```json
{
  "schemaVersion": "lattice.review_loop_policy.v1",
  "maxIterations": 5,
  "maxNoProgressIterations": 2,
  "maxRuntimeMinutes": 30,
  "maxCostUSD": 5,
  "allowAutoHandoff": false,
  "allowAutoRollback": false,
  "requireHumanForScopeExpansion": true,
  "requireHumanForProtectedFiles": true,
  "stopOnTestRegression": true,
  "stopOnScopeViolation": true
}
```

Policy interpretation:

- `allowAutoRollback=false` means Lattice emits a rollback plan, not a
  destructive reset.
- `allowAutoHandoff=false` means Lattice recommends a handoff, not an automatic
  host spawn.
- `requireHumanForScopeExpansion=true` means scope expansion cannot be hidden
  inside loop continuation.
- `stopOnTestRegression=true` means a failing regression is not a prompt problem;
  it is a rollback or human-review problem.
- When provider spend is not measurable, budget enforcement must fail closed:
  the evaluator treats the budget as exhausted instead of treating the loop as
  unbounded.

## 10. REVIEW Gate Integration

The loop must integrate with REVIEW gates without replacing them.

Rules:

- A blocking finding may open a review loop.
- An active loop blocks `REVIEW -> TEST`.
- A `close_candidate` decision requires a fresh `review_run_start`.
- A stale reviewer run cannot be reused after loop changes material files.
- A finding must still be resolved or reviewer pass must still be recorded.
- `stop_blocked` keeps the story in REVIEW or returns it to DEV according to the
  existing lifecycle failure path.
- `handoff_recommended` generates guidance only. It must not spawn a host or
  change authority.
- `review_loop_close --outcome=resolved` may unblock the loop gate only when all
  trigger refs are resolved or superseded by fresh evidence at the current
  material hash.
- `review_loop_close --outcome=escalated` or `--outcome=blocked` closes the loop
  record but does not unblock REVIEW by itself. The underlying finding, bug,
  scope violation, or validation failure still controls the normal gate.
- Scope-triggered loops require current `scope_contract_check` or
  `guard_session_check` evidence before a resolved close is accepted.
- Finding-triggered loops require finding resolution or a fresh reviewer pass
  before a resolved close is accepted.
- Validation-triggered loops require fresh validation or verification evidence
  before a resolved close is accepted.

Recommended gate behavior:

```text
if latestReviewLoopRecord.status == "open":
  block REVIEW -> TEST
  show loopId, decision, nextAction

if latestReviewLoopRecord.status != "resolved":
  do not treat loop closure as gate-unblocking evidence
```

This avoids the dangerous state where a repair loop is open but the story
advances anyway.

## 11. Host Neutral Integration

Review Reflection Loop is host-neutral by design. It records work around the
host rather than trusting a host-local transcript as authority.

Example:

```text
Claude Code repair attempt fails
  -> Lattice records evidence and reflection
  -> Policy decision = handoff_recommended
  -> Lattice emits handoff guidance
  -> Codex or local-runner continues from the same finding context
```

Existing Lattice surfaces to reuse:

- `host_list` / `host_probe` for capability and degradation context.
- `scope_diff_pack` for hunk-level diff context.
- `scope_contract_check` and `guard_session_check` for scope protection.
- `verification_context_pack_create` for next-step repair context.
- `handoff_create` / `handoff_resume` for host transfer.
- `authority_status` for explicit non-authority boundaries.
- `dev_memory_capture` for non-gate learning capture.

Authority invariant:

```text
review loop output never sets:
  productionDone=true
  authorityChanged=true
  receiptVerified=true
  receiptRefs=[non-empty]
```

## 12. Reflection Contract

Reflection must be structured. Free-form prose is allowed only as explanation
inside structured fields.

Each iteration must answer:

- Did this iteration move the story closer to DONE?
- Is the evidence strong enough to justify continuation?
- Did tests, build, static checks, scope checks, or diff quality regress?
- Did the work drift from the requirement or current story scope?
- Is the failure caused by prompt, context, tool, host, requirement, or an
  external dependency?
- How should the next repair prompt be changed?
- Should the loop continue, retry, revise, roll back, hand off, escalate, or
  stop?
- Is there reusable learning worth capturing outside gate evidence?

Minimal JSON shape:

```ts
interface ReflectionResult {
  progress: "improved" | "unchanged" | "regressed";
  evidenceQuality: "strong" | "medium" | "weak";
  failureType?: "prompt" | "context" | "tool" | "host" | "requirement" | "external";
  riskLevel: "low" | "medium" | "high";
  rootCauseHypothesis: string;
  nextPromptPatch?: string;
  recommendedDecision: ReviewLoopDecision;
  reason: string;
  reusableLearning?: string;
}
```

The reflection step produces a `ReflectionResult`. The policy evaluator consumes
`recommendedDecision` and produces the stored top-level `decision` and
`decisionReason`. The stored iteration keeps both values so reviewers can audit
whether policy overrode the agent's recommendation.

## 13. Rollback and Human Gate

Version 0.1 should not execute destructive rollback automatically. It should
emit a rollback plan and require explicit human or operator action.

Rollback triggers:

- Protected file modified.
- Protected anchor modified.
- Build changed from passing to failing.
- Test suite regressed.
- Diff expanded into unrelated modules.
- Critical file deleted or rewritten.
- Artifact output contradicts the story goal.

Human gate triggers:

- Scope expansion.
- Production deployment.
- Data deletion.
- Payment or billing behavior.
- Credentials, account permissions, or access control.
- Legal, privacy, or compliance decisions.
- Product tradeoff with multiple valid options.
- Low confidence after repeated failures.

Human gate output should include a concrete question, not a vague escalation.

Example:

```json
{
  "decision": "human_gate_required",
  "nextAction": {
    "humanQuestion": "The repair requires expanding scope from auth/session.ts into billing/session-sync.ts. Approve scope expansion or require a narrower fix?"
  }
}
```

## 14. Implementation Milestones

| Milestone | Deliverable | Acceptance criteria |
|---|---|---|
| M0 | Decision document | Host Neutral docs define Review Reflection Loop as non-authority, bounded, review-driven. |
| M1 | Data model | Story-scoped review loop schema, diff hash definition, cost fail-closed behavior, and pure policy evaluator exist. |
| M2 | CLI surface | `review_loop_start`, `review_loop_iteration_add`, `review_loop_status`, `review_loop_close`, and `review_loop_policy_show` exist. |
| M3 | REVIEW gate | Active loop blocks `REVIEW -> TEST`; resolved close requires fresh trigger resolution; `session_brief` or `status` surfaces active loop next action. |
| M4 | Context pack integration | Loop start can reference finding, scope diff, validation context, and material hash. |
| M5 | Handoff integration | `handoff_recommended` maps to existing handoff guidance without spawning a host. |
| M6 | Dev memory integration | `reusableLearning` can be captured as non-authoritative dev memory. |
| M7 | Optional dispatch | A future `review_loop_dispatch` may delegate work, but still cannot auto-DONE or auto-merge. |

## 15. Test Plan

| Test | Purpose |
|---|---|
| `review-loop-policy-smoke` | Verifies decision priority, max iterations, no-progress handling, and risk overrides. |
| `review-loop-lifecycle-smoke` | Verifies active loops block `REVIEW -> TEST`. |
| `review-loop-finding-smoke` | Verifies loops must bind to a finding, bug, validation failure, or scope violation. |
| `review-loop-freshness-smoke` | Verifies material changes make old review runs stale. |
| `review-loop-handoff-smoke` | Verifies handoff recommendation does not spawn a host or change authority flags. |
| `review-loop-rollback-smoke` | Verifies rollback decisions emit plans only and do not run destructive commands. |
| `review-loop-process-fact-contract` | Verifies new L4 process facts are registered in the process fact registry. |
| `review-loop-json-contract-smoke` | Verifies machine JSON output is parseable as a single JSON document. |
| `review-loop-lifecycle-registry-contract` | Verifies REVIEW gate row ids and lifecycle registry integration are updated with loop blocking semantics. |
| `review-loop-owner-lease-smoke` | Verifies mutating loop commands are story-scoped and owner-gated. |
| `review-loop-close-invariant-smoke` | Verifies resolved close requires fresh trigger resolution and blocked/escalated close does not unblock REVIEW. |

## 16. Example Flow

Story: `fix-auth-refresh-token-bug`

Acceptance criteria:

- A user can log in again after refresh token expiry.
- `auth.spec.ts` passes.
- Payment and billing modules are not modified.

Iteration 1:

```text
Host: Claude Code
Action: REVIEW reflection identifies a DEV repair target for refresh token handling
Evidence: finding + scope diff + failing auth.spec.ts reference
Reflection: Failure appears tied to mock clock behavior, not full auth logic.
Decision: revise
Next prompt patch: Return to DEV and focus on token expiry mock and time advancement.
```

Iteration 2:

```text
Host: Claude Code
Action: DEV repair adjusts test clock and expiry handling, then returns to REVIEW
Evidence: auth.spec.ts passes, user.spec.ts fails
Reflection: Repair introduced session initialization side effect.
Decision: rollback_required
Next action: Return to rollbackRef and preserve only the localized refresh token change.
```

Iteration 3:

```text
Host: Codex
Action: Continue from handoff context after operator-approved handoff guidance
Evidence: auth.spec.ts and user.spec.ts pass
Reflection: Acceptance criteria appear satisfied.
Decision: close_candidate
Next action: Start fresh reviewer run.
```

The story can only progress after normal reviewer pass/finding resolution and
validation gates succeed.

## 17. Product Language

English:

> Lattice introduces a Review Reflection Loop that turns review failures into
> bounded, auditable repair cycles. Each cycle records evidence, reflection,
> policy decisions, rollback context, and host-neutral handoff guidance. The
> loop can continue, retry, revise, request rollback, recommend handoff,
> escalate to a human, or produce a close candidate, but it cannot bypass
> Lattice review, validation, scope, DONE, or authority gates.

Chinese:

> Lattice 在 REVIEW 阶段引入 Review Reflection Loop，把 review failure 转化为
> 受控、可审计、可恢复的修复闭环。每一轮 loop 都记录 evidence、reflection、
> policy decision、rollback context 和 host-neutral handoff guidance。Loop 可以
> 继续、重试、修订、要求回滚、建议 handoff、升级给人类，或产生候选关闭结论，
> 但不能绕过 Lattice 的 review、validation、scope、DONE 或 authority gate。

Short slogan:

> A loop without boundaries amplifies agent errors. Lattice turns loops into
> governed lifecycle transitions.

## 18. Conclusion

Review Reflection Loop should be implemented as a narrow REVIEW-stage protocol
before any broader lifecycle automation. The first version should record
structured loop iterations, enforce policy decisions, preserve rollback and
handoff context, and block REVIEW progression while a loop is active.

This strengthens Lattice's core value: not making agents run more, but making
agent work more verifiable, recoverable, transferable, and safe to stop.
