# Proof-or-Stop Agent-Drivability Optimization

**Status:** proposal / optimization roadmap
**Origin:** empirical baseline from an autonomous agent driving Proof-or-Stop
without an operator recipe, told only to follow Proofbound's own CLI guidance.

The motivating run used a trivial Terminal-Bench `fix-git` task. The agent ran
93 bash commands, encountered roughly 45 error outputs, created three stories,
discarded two, and timed out inside INIT/PLAN. It never reached DEV and never
touched the actual git fix.

This document is a planning and regression-contract artifact only. It is not
gate evidence, not proof that any future implementation works, and not a basis
for relaxing review, scope, verification, or DONE requirements.

## Root Pattern

Proofbound often has the right aggregating command, but the command is not
surfaced at the moment an agent needs it. The strongest example is
`init_preflight`: it can aggregate INIT_CHECK prerequisites, but the observed
run followed higher-traffic guidance into one-at-a-time gate failures instead.

Design invariants for first-try agent drivability:

- Aggregate, do not drip-feed prerequisites.
- Always name the exact next command.
- Never advertise a command that will fail in the current phase or artifact
  state.
- Improve routing and discoverability without weakening L4 evidence contracts.

## M0-M7 Milestone Plan

M0-M6 are the required delivery path for the confirmed drivability findings.
M7 is a conditional ceremony redesign milestone and must not implement an
agent-self-attested express lane.

### M0 - Baseline and Regression Fixture

- Freeze the `fix-git` rule-free transcript as the drivability regression
  fixture.
- Define and record `commands-to-DEV` as the primary metric: the number of bash
  commands an autonomous agent issues before it reaches DEV and can start
  solving the actual task.
- Preserve the baseline contract: **80+ commands, never reached DEV**. The
  observed run was 93 commands, timed out in INIT/PLAN, and never entered DEV.
- Record the run harness, model/host profile, timeout, allowed commands, error
  output count, story churn, and fixture acceptance condition.
- Future comparisons must compare M6 and any M7 rerun against this frozen M0
  baseline using the same fixture family and must report at least:
  `commands-to-DEV`, total command count, error-output count, story churn, and
  whether DEV was reached before timeout.
- Do not overclaim: M0 is baseline documentation, not product proof, not gate
  evidence, and not proof that Proofbound is agent-drivable.

### M1 - INIT Drivability and `init_preflight` Routing

- Route every high-traffic INIT surface to `init_preflight`: `session_brief`
  INIT next-step, `story_create` INIT hint, the first INIT_CHECK gate failure,
  and the global help development-flow block.
- Surface `init_check_repair` as a controlled fallback in reviewer-missing
  guidance, without exempting required reviewer evidence.
- Keep `init_preflight` read-only. It may aggregate facts and exact commands,
  but it must not run commands, write evidence, launch reviewers, create
  worktrees, or advance phase.

### M2 - IDEA / Checklist Dead-End Removal

- Make `checklist_add` lazily create `checklist.json` when it is absent, using
  the same fail-safe shape as other optional story artifacts.
- Stop advertising a guaranteed-failing IDEA path.
- Add an explicit IDEA-to-INIT route: either recreate with a checklist or use
  the supported INIT setters/preflight path, with no circular dependency.

### M3 - CLI Help and Argument Parser Clarity

- Unwrap `ZodDefault` in the help renderer so `verificationIntent` shows the
  real nested lane schema instead of `any`.
- Detect positional JSON plus named flags such as `--json` and fail with a
  specific diagnostic, or safely merge the metadata flag into the parsed JSON.
- Reduce validation-failure noise so the actionable missing field / allowed
  value line remains the dominant output.

### M4 - PLAN-to-DEV Scope-Plan Drivability

- Add a story-level dispatch branch and prompt builder for
  `lattice-review-scope-plan` that terminates in `scope_check_save`.
- Make `missing_scope_check` print the exact command shape / dispatch path
  instead of only naming the artifact.
- Make `missing_plan_md` name `plan_set` and inline the required `## CHK-xxx`
  section format.
- Make the PLAN next-step logic detect unresolved scope open questions and
  route to `scope_question_resolve`.

### M5 - Global-Thin / Profile Asset Correctness

- Remove `node bin/lattice.js` from global-thin `CLAUDE.md` output and name
  the global `lattice` command as primary.
- Extend the thin-init smoke to cover `--profile=claude`, asserting
  `CLAUDE.md` as well as `AGENTS.md` is clean.
- If a hook or helper encounters a missing local `bin/lattice.js`, it should
  fall back to `command -v lattice` instead of training the agent into a crash.

### M6 - End-to-End Drivability Verification

- Re-run the `fix-git` rule-free fixture after M1-M5.
- Report `commands-to-DEV`, total command count, error-output count, story
  churn, and whether DEV was reached before timeout.
- Compare the M6 run against M0 using the frozen baseline contract rather than
  anecdotes or changed task criteria.
- Prove no evidence requirement was weakened: dual INIT reviewers, scope
  anti-expansion, scope-plan evidence, verificationIntent coverage, and review
  gates must still be enforced.
- This milestone is complete only when the run reaches DEV in a small, bounded
  number of commands without relaxing any L4 evidence contract.
- Do not overclaim M6 as production/full completion unless the relevant gates,
  evidence, and release criteria have actually been satisfied.

### M7 - Safe Ceremony Redesign (Conditional)

M7 exists only if M6 shows ceremony cost remains unacceptable after discovery
cost has been removed. The legitimate goal is that a trivial task should not
consume the whole timeout, but the solution must not weaken evidence.

The original idea of auto-downgrading dual-reviewer, understanding,
verificationIntent, or scope-plan ceremony by item count or agent-supplied risk
is rejected. An agent could keep the checklist artificially small or understate
risk to dodge review.

Acceptable directions:

- Speed, not skip: keep required reviewer records mandatory, but make them
  cheap and one-shot where possible.
- Operator-set, not agent-set risk class: any lane downgrade must be bound to
  operator or policy evidence the agent cannot self-assert.
- Measure before changing contracts: do not touch gate strength until M6 proves
  discovery fixes alone are insufficient.

## Finding-to-Milestone Coverage

| Finding | Primary milestone | Notes |
|---|---|---|
| Checklist circular dependency | M2 | Also depends on M1 for the IDEA-to-INIT route. |
| INIT_CHECK drip-feed / `init_preflight` not routed | M1 | High-traffic INIT surfaces must name the aggregate preflight. |
| `session_brief` INIT next-step | M1 | Route to read-only `init_preflight`. |
| `story_create` INIT hint incomplete | M1 | Replace blind `story_advance` tail with preflight/full prerequisite guidance. |
| Dual INIT reviewer discoverability | M1 | Surface repair/dispatch paths only; no exemption. |
| Scope-plan reviewer story-level dispatch gap | M4 | Add story-level prompt/dispatch path ending in `scope_check_save`. |
| `verificationIntent` rendered as `any` | M3 | Help renderer `ZodDefault` unwrap. |
| `missing_plan_md` omits `plan_set` | M4 | Inline command and section format. |
| Positional JSON plus flags | M3 | Specific diagnostic or safe merge. |
| Global-thin `CLAUDE.md` local-bin crash | M5 | Add `--profile=claude` smoke coverage. |
| Noisy missing-field errors | M3 | Keep specific error dominant. |
| Open questions lack next-step guidance | M4 | Route to `scope_question_resolve`. |
| Global help blind INIT_CHECK step | M1 | Route through `init_preflight`. |
| Tier 3 ceremony weight | M7 | Conditional safe redesign only. |

## Validation Fixture Contract

Treat the `fix-git` rule-free run as a drivability regression fixture. M0
freezes the baseline and harness. M6 reruns it after M1-M5. If M7 changes any
ceremony-production path, M7 must rerun the same fixture again and compare
against both M0 and M6.

Baseline: **80+ commands, never reached DEV**. M1-M5 should reduce this by
removing checklist dead-ends, INIT serial discovery, PLAN dispatch ambiguity,
help-rendering opacity, parser traps, and global-thin crashes. The target is to
reach DEV in a small, bounded number of commands so the remaining timeout budget
goes to solving the task, without relaxing any gate evidence.

