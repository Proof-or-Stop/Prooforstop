# Proofbound Multi-Role Separation Refactor Plan

> 2026.04 · Split the 4 responsibilities of plan / adversarial / implementation / test-verification from "one main agent holding all of them" into roles that can evolve independently

## Current typed dispatch authority

The historical wave plan below explains why roles were separated. The current
runtime contract is stricter: `packages/main/src/core/agent-dispatch-registry.ts`
is the single mechanical authority for dispatch role, lifecycle phase, target
cardinality, prompt class, commit permission, reviewer lane, evidence ownership,
and permitted state-changing commands. Consumers must not infer privilege from
prefixes such as `lattice-review-`.

The canonical role families are implementer, verification-intent, INIT and
scope reviewers, story and coverage reviewers, delivery reviewer, finding
repair, and cluster repair. `test-intent` and `test-case-reviewer` are explicit
aliases of `verification-intent`; they retain verification-intent-only mutation
authority and never receive implementation/commit/status-done instructions.
Unknown types, wrong phases, and wrong story/item/finding/cluster cardinalities
fail before prompt generation and before dispatch event writes.

Role separation is enforced twice: prompts state the role boundary, while the
registry and mutation consumers mechanically deny privilege crossover. In
particular, implementers/repairers cannot mint reviewer evidence, reviewers
cannot complete checklist work, and verification-intent aliases may update only
`verificationIntent`. This L4 process fact is registered as
`runtime:agent_dispatch_role_authority_gate` and verified by
`scripts/verify-process-fact-contract.mjs`.

Compatibility and completeness are executable contracts. The dispatch smoke
covers every canonical type and alias over every phase, every target cardinality
combination, every prompt class, and the complete allow/deny mutation matrix.
A synthetic new registry row or alias without corresponding coverage must make
the smoke fail.

## Background

lattice currently has only 1.5 actual roles:
- **main agent**: the primary driver throughout PLAN / DEV / TEST_CASE / TEST / DONE
- **test-intent-reviewer**: only reviews the text quality of testIntent
- **test-case-reviewer**: only reviews fixture design

The main agent has long held the four mental modes of "planner / adversary / implementer / verifier" at once. Observation shows this mixing is the root cause of most "shortcut-class bugs":
- **PLAN phase**: eager to get into DEV, so the checklist is broken down coarsely, testIntent is skipped, and the decision is bypassed
- **DEV phase**: the same mind both writes the code and judges "whether the checklist is satisfied", grading itself leniently
- **TEST phase**: when a fail appears, it tends to go back and edit the test rather than go back and edit the code (survivorship bias — editing the test is cheaper)
- **DONE phase**: eager to merge, it may narrate "real-machine verification that never actually passed" as "already verified"

The pain points the user repeatedly hits (reporting completion when only half done, bypassing the checklist, tests passing falsely) almost all fall within the fundamental contradiction of "the same agent simultaneously holding the two conflicting goals of 'wanting to finish' and 'needing to be strict'".

This document proposes a **gradual role-separation plan**, not splitting into 4 independent agents in one step.

## Core Judgment

### Why not split into 4 independent agents all at once

1. **The boundary of the "adversarial" role is extremely hard to draw cleanly**. The most common failure mode of an independent red-team agent is not failing to find faults, but finding a pile of generic template faults (what if the disk is full / what if the network goes down), drowning out the truly high-signal risks. lattice's existing `riskSignals` + B-5010's `story_review_dismiss` mechanism already prove this indirectly — dismiss exists precisely because story_review has too many false-positives.
2. **4 independent agents = 4 context windows**. Each sub-agent launch is a fresh context, and the context passed between plan → adversarial → implementation → test has to be rebuilt inline in the prompt, so the token cost stacks up linearly. Not worth it under a solo-dev budget.
3. **lattice's existing mechanisms (phase state machine / watchdog / activity.jsonl / signed review / hooks) all assume "one agent is present throughout"**. Splitting into 4 roles at once means all of these mechanisms have to be changed in sync, and the change surface is too large to roll back safely.
4. **Whether the real pain points actually require 4 roles to solve is not yet verified**. If the real root cause is prompt quality or checklist granularity, splitting into more agents will not help.

### The role that is truly worth making independent

After tracing the pain points back to their source, **only the "implementation" role has a clear, well-defined upside to being made independent**:
- It reads and writes files heavily, so its context pollution is the worst
- Its mental mode ("get it done") conflicts most with the mental modes of plan and adversarial ("find faults / imagine possibilities")
- Once independent, its tool permissions can be tightened (read/edit code + run tests only; cannot touch phase / cannot touch story metadata)
- It can run in an independent worktree, naturally isolating side effects

**The "test-verification" role actually does not need an LLM**. lattice already has the deterministic script test_auto; the only thing that truly needs LLM judgment is "root-cause analysis when a test fails" — and that is an on-demand diagnostic role, not a resident role.

**The "adversarial" role is implemented in phase 1 using a self-critique mode** (after the plan agent finishes writing the checklist, it switches mental mode and finds faults in its own work). This saves one context cold start compared to an independent agent, and empirically the effect is close; crucially, it **lets us first verify whether the boundary is workable**. If the self-critique data shows that the adversarial output really has value, then we consider splitting out an independent agent.

### Target Architecture (end state)

```
┌──────────────────────────────────────────────────────────┐
│                    main agent (coordinator)               │
│  Owns phase advancement, dispatches sub-agents, reports   │
│  Mental mode: planner + self-critique-mode adversary      │
└─────┬────────────────────────┬───────────────────────────┘
      │                        │
      │ Agent(implementer)     │ Agent(test-analyst)
      │                        │ (only on test_auto fail)
      ▼                        ▼
┌──────────────┐        ┌────────────────┐
│  implementer │        │  test-analyst  │
│  Mental mode:│        │  Mental mode:  │
│  "get it     │        │  "root-cause   │
│   done"      │        │   analysis"    │
│  - Read/Edit │        │  - read diff   │
│  - Bash(lattice│        │  - read fail   │
│     /node/   │        │    log         │
│     npm)     │        │  - write       │
│  - worktree  │        │    bug.json    │
│    isolation │        │  - decide:     │
│  - update_   │        │    edit code   │
│    task_state│        │    or test     │
│    report    │        └────────────────┘
└──────────────┘
         │
         ▼
┌──────────────────────────┐
│  test runner (script tier)│
│  DEV → TEST_CASE → TEST    │
│  runs auto on phase transition │
│  non-LLM, deterministic output │
└──────────────────────────┘
```

**Inter-role communication goes through artifact files, not conversational relays** (a generalization of the signed-review mechanism):

| artifact | Writer | Reader |
|---|---|---|
| `checklist.json` | main (plan mode) | all |
| `decision.json` | main (plan mode) | all |
| `plan-critique.json` (new) | main (critique mode) | main (plan mode response) |
| source code + fixture | implementer | test runner / test-analyst |
| `implementation-log.jsonl` (new) | implementer | test-analyst |
| `test-runs.json` | test runner | test-analyst / main |
| `test-evidence.json` | test runner | main (DONE gate) |
| `bug.json` | test-analyst | main / implementer (fix) |
| `summary.json` | main (at DONE) | user |

## Designs Not Introduced

The following options are explicitly excluded, each with a reason:

| Option | Reason for exclusion |
|---|---|
| Independent red-team agent (split from the start) | The boundary has not been battle-tested; verify the self-critique mode first |
| One independent agent per phase | Number of phases ≠ number of roles; it should be 4 roles dispatched on demand across 8-9 phases |
| Direct conversational relay between agents | Conversational context is unstable; it must land in an artifact as physical evidence |
| plan agent directly modifies the checklist to respond to a critique | Loses the critique history; both critique and resolve must leave a trace |
| test-analyst resident online | High cost; the test_auto script is already enough, the LLM only diagnoses on a fail |
| Turning test_auto into an LLM tool call | Backwards; it should be downgraded to an automatic action of a phase transition |
| implementer can call story_advance | Role overreach; phase advancement can only be decided by the main agent |
| implementer can write bug.json | Conflict of interest; bug identification should be done by the independent role test-analyst |

## Risks and Rollback

**Biggest risk**: after the implementer is made independent, if the "shortcut rate" does not drop, it means the problem is not in role-mixing but in prompt quality or model capability. At that point we need to roll back to the main agent holding DEV as well; we must not force the next step.

**Rollback points**:
- At the end of Wave 0 (implementation agent independent + telemetry)
- At the end of Wave 1 (test scripting + analyst)
- At the end of Wave 2 (self-critique)

**A data review is mandatory at the end of each wave**; if it falls short of expectations, stop at the current wave and do not proceed to the next.

---

## Story Overview

Organized by wave; each wave is independently verifiable, with data gates between waves:

| Wave | Story | Effort | Goal | Priority |
|---|---|---|---|---|
| **Wave 0 — verify the ROI of an independent implementer** | | | | |
| S-01 | implementer agent definition (`.claude/agents/lattice-implementer.md`) | 1 day | Write a runnable agent definition | P0 |
| S-02 | DEV / TEST_CASE phase dispatches the implementer | 2 days | phase transition automatically spins up the sub-agent | P0 |
| S-03 | activity.jsonl telemetry tagged by role | 1 day | Be able to compare before/after with data | P0 |
| S-04 | Wave 0 data review (after a 2-week observation window) | 0 days | Decide whether to proceed to Wave 1 | P0 gate |
| **Wave 1 — make test execution deterministic** | | | | |
| S-05 | Downgrade test_auto from an LLM tool to an automatic phase-transition action | 2 days | Detach test execution from LLM judgment | P1 |
| S-06 | test-analyst fork agent (triggered only on fail) | 2 days | Make failure diagnosis independent | P1 |
| S-07 | Tighten the test-evidence.json protocol + add an attribution field to bug.json | 1 day | Harden the artifact contract | P1 |
| S-08 | Wave 1 data review | 0 days | Decide whether to proceed to Wave 2 | P1 gate |
| **Wave 2 — plan self-critique mode** | | | | |
| S-09 | plan agent self-critique mode switch instruction | 2 days | Let the main agent use two turns to play two mental modes | P2 |
| S-10 | plan-critique.json artifact + dismiss mechanism | 2 days | Leave a trace of the critique | P2 |
| S-11 | Insert the PLAN_REVIEW phase + gate conditions | 1 day | Make the phase machine accommodate the critique step | P2 |
| S-12 | Wave 2 data review | 0 days | Decide whether to split out an independent red-team agent | P2 gate |
| **Wave 3 — conditional** | | | | |
| S-13 | (conditional) independent red-team agent definition | 2 days | Done only if Wave 2 data proves self-critique is not enough | P3 |
| **Cross-cutting concerns** | | | | |
| S-X1 | artifact write-permission matrix (restricted by role) | 1 day | Hard-block role overreach | Done alongside S-02 |
| S-X2 | role-aware refactor of watchdog / session_brief | 1 day | Sub-agent switching is not misjudged as stuck | Done alongside S-02 |
| S-X3 | role-tag pass-through in hooks | 0.5 day | The hook script knows which role is currently active | Done alongside S-03 |

**Wave 0 totals 4 days** and is the key wave that decides the direction of the entire refactor. The data after Wave 0 decides whether to continue.
**Wave 0 + Wave 1 + Wave 2 total an estimated ~15 days of effort**, but there is a mandatory observation window between each wave.

### Dependencies between waves

```
Wave 0: S-01 → S-02 → S-03 → S-04 (gate)
                ↓      ↓
              S-X1   S-X2   S-X3  (cross-cutting, done in sync with Wave 0)

Wave 1: S-05 → S-06 → S-07 → S-08 (gate)

Wave 2: S-09 → S-10 → S-11 → S-12 (gate)

Wave 3: (conditional on S-12 outcome) S-13
```

**A gate story is not an empty placeholder**; it is a mandatory data-review meeting (you holding it with yourself), whose output is a written decision choosing one of "continue / stop at the current wave / roll back", written into decision.json.

---

## Wave 0: Verify the ROI of an Independent Implementer

**Goal**: without changing the lattice phase machine or any existing artifact, delegate the actual execution of the two phases DEV + TEST_CASE to an independent sub-agent, and observe the effect on the "shortcut rate" after 2 weeks.

**What Wave 0 does NOT change**:
- The phase list stays the same
- All artifact schemas stay the same
- The main agent continues to be responsible for phase advancement and reporting to the user
- The core behavior of watchdog / activity.jsonl / hooks stays the same

**What Wave 0 changes**:
- The code-writing work in the DEV phase is done by the implementer sub-agent
- activity.jsonl gains a `role` field to distinguish main / implementer

---

### S-01: implementer agent definition

**Description**

Create `.claude/agents/lattice-implementer.md`, defining a CC sub-agent dedicated to the "implementation" role. This agent is invoked by the main agent via `Agent(subagent_type: "lattice-implementer", ...)`, and is responsible for the concrete coding work of the DEV and TEST_CASE phases.

Key design:
- Tightened permissions: only a subset of Read / Edit / Write / Glob / Grep / Bash. Bash allowlist: `lattice:*`, `node:*`, `npm:*`, `pnpm:*`, `git:(status|diff|log|add|commit)`. Blocklist: `rm`, `git reset --hard`, `git push`, `curl | sh`
- `permissionMode: acceptEdits` (no confirmation prompt)
- `isolation: worktree` (automatically reuses lattice's worktree-per-story)
- The system prompt's mental mode is locked to "get it done", explicitly blocking it from advancing the phase / writing bug.json / modifying checklist metadata
- The prompt ends with a hard line: "When done, return only a plain-text summary; do not attempt story_advance, and do not decide on your own whether to enter the TEST phase"

The agent's input prompt is constructed by the main agent and must contain:
1. The current story id + phase
2. The list of checklist items with status != done (including title + context)
3. A short index of files already read (to avoid the sub-agent re-Reading)
4. The Proofbound commands it is allowed to call (`checklist_update`, `update_task_state`, `fixture_batch_add`)
5. The list of Proofbound commands it is blocked from calling

**Checklist**

1. **title**: Create the `.claude/agents/lattice-implementer.md` file and its frontmatter
   **context**: The frontmatter contains `name`, `description`, `whenToUse`, `tools`, `disallowedTools`, `permissionMode: acceptEdits`, `isolation: worktree`, `model: inherit`. whenToUse must make clear "only invoked by the main agent during the DEV / TEST_CASE phase of a lattice story, not responding to the user directly"

2. **title**: Write the body of the system prompt
   **context**: 5 sections:
   - "You are the lattice implementer" (role anchoring)
   - "Your sole goal: complete the pending items in the checklist" (mental mode lock)
   - "Strictly blocked" (cannot story_advance / cannot change phase / cannot write bug.json / cannot change a checklist item's testIntent)
   - "Tool usage conventions" (read-before-edit / only one in_progress per item / call update_task_state when done)
   - "Completion conditions and return format" (return a 2-5 line summary, do not be verbose)

3. **title**: Verify CC can load this agent
   **context**: Launch CC in the lattice-agent repo root, run `/agents` or have the main agent call `Agent(subagent_type: "lattice-implementer", description: "smoke", prompt: "echo hello")`, and confirm the agent is recognized and can run

4. **title**: Real-machine smoke: have the implementer make a trivial change
   **context**: On a scratch story, have the implementer create a hello.txt and call update_task_state. Confirm: (a) the file was actually created (b) the checklist item was actually marked done (c) there was no story_advance call (d) the returned summary is concise

5. **title**: Verify the permission tightening takes effect
   **context**: Deliberately have the implementer attempt `rm` or `git push` and confirm it is blocked. Attempt `story_advance` and confirm the sub-agent does not have this tool (or is rejected at the prompt layer)

**Test directions**
- happy: the implementer correctly completes a 2-3 item checklist
- edge: when the implementer hits a checklist item whose prerequisite has not been done, it must stop and report rather than skip
- adversarial: when the implementer attempts an overreaching operation (story_advance / rm / push) it must fail

**Acceptance**
- `.claude/agents/lattice-implementer.md` exists and its frontmatter is valid
- The smoke proves the agent can be recognized and executed by CC
- The permission tightening is provable

**Touchpoints**
- Create: `.claude/agents/lattice-implementer.md`
- (optional) Create: `docs/story/actives/B-xxxx/smoke/implementer-smoke.md` as a real-machine verification record

---

### S-02: DEV / TEST_CASE phase dispatches the implementer

**Description**

Make the main agent **naturally inclined to** delegate to the implementer when it enters the DEV or TEST_CASE phase. This story is a refactor of prompts + flow; it **does not modify lattice's core code**.

Two points are changed:
1. **Add a section about role separation at the top of CLAUDE.md**: tell the main agent that "the code-writing work of DEV and TEST_CASE should be delegated to the lattice-implementer sub-agent"
2. **Add a line to the nextStepHint when story_advance enters DEV or TEST_CASE**: "Recommend calling Agent(subagent_type='lattice-implementer', ...) to do the coding work of this phase"

Note: **not mandatory**. The main agent may choose not to delegate, because some stories are extremely fine-grained (chore / docs type), where delegating to a sub-agent is more expensive than doing it yourself. Let the main agent judge for itself based on the story's type and priority.

**Why not hardcode delegate at the code level**:
- lattice's core value is "the mechanism does not assume an agent implementation"; hardcoding delegate would bind lattice to CC
- the main agent could be CC, or it could be an observer/Mastra agent (you are currently pursuing both paths)
- hardcoding would require maintaining two phase machines at once, too heavy

**Checklist**

1. **title**: Add a "sub-agent role separation" subsection at the top of `packages/lattice/CLAUDE.md`
   **context**: Explain that lattice supports the implementer sub-agent, and give the trigger conditions: delegate is recommended when story.type is in `[feature, bug, refactor]` and priority >= medium and the checklist item count >= 2. When type is in `[chore, docs]` or the item count < 2, it is faster for the main agent to do it itself

2. **title**: Add a delegate suggestion to the hint when story_advance enters DEV
   **context**: In the `story_advance.DEV` hint in `handlers/hints.ts`, append a line: "Recommend Agent(subagent_type='lattice-implementer', description='execute DEV', prompt='story id + pending checklist items + allowed tools')". Only append when story.type/priority/size meets the conditions

3. **title**: Same for the hint when story_advance enters TEST_CASE
   **context**: Same idea, but the prompt template is slightly different (emphasizing writing fixtures rather than writing implementation code)

4. **title**: Add a section to CLAUDE.md about "the wrap-up obligations after the implementer is done"
   **context**: Make clear that after the implementer returns, the main agent must: (a) read the updated checklist to verify all in_progress have been cleared (b) read implementation-log.jsonl to get an overview of the changes (c) decide whether to story_advance directly. Blindly trusting the sub-agent's summary is not allowed

5. **title**: Real-machine verification: run a real story through one DEV delegate
   **context**: Pick a small existing backlog story at phase=PLAN and have the main agent go through the DEV phase. Observe: (a) whether main actually delegated (b) whether main did verification after the implementer returned (c) whether the overall wall time is reasonable

**Test directions**
- happy: a medium story is correctly delegated and completed
- edge: for a trivial story (chore type) the main agent chooses not to delegate and does it itself
- adversarial: the implementer returns "done" but the checklist still has in_progress items, and the main agent must notice and require it to continue

**Acceptance**
- The top of CLAUDE.md has a clear sub-agent role-separation description
- The hint text for story_advance DEV/TEST_CASE contains the delegate suggestion
- A delegate is run end-to-end on a real machine once and written into DOGFOOD-EVIDENCE.md

**Touchpoints**
- Modify: `packages/lattice/CLAUDE.md`
- Modify: `packages/lattice/packages/main/src/handlers/hints.ts`

---

### S-03: activity.jsonl telemetry tagged by role

**Description**

Each record in activity.jsonl is currently `{tool, args, status, at}`. Add a `role` field (`main` / `implementer` / `test-analyst` / `unknown`) so that data analysis can be done at the end of Wave 0.

The source for judging `role`: the environment variable `LATTICE_ROLE`. When the main agent delegates to a sub-agent, it stuffs this variable into the sub-agent's env (CC's AgentTool allows passing an environment variable or injecting it via the initialPrompt).

Note this is best-effort: if the env is not passed, the role field is `unknown`, which does not affect the other fields.

**Why do this story now rather than waiting until there is data**: without role-tagged telemetry, the data review at the end of Wave 0 would be pure guesswork. This story is a precondition for the Wave 0 gate and must land before the observation window begins.

**Checklist**

1. **title**: Add a `role` field to activity.ts
   **context**: Add `role: process.env.LATTICE_ROLE || 'unknown'` to the record object in appendActivity. The schema version stays the same (the new field is additive)

2. **title**: Add the role field to health.ts as well
   **context**: health.jsonl also needs to know which role produced a silent failure. Same env-variable source

3. **title**: Document the env-variable injection in the implementer section of CLAUDE.md
   **context**: Tell the main agent that when it delegates to a sub-agent, it includes in the prompt `"Your first Bash call after launch is export LATTICE_ROLE=implementer"`. This convention is ugly but effective. TODO: change it in the future if the CC Agent tool supports env pass-through

4. **title**: Add a simple data-analysis script
   **context**: Create `packages/lattice/scripts/wave0-review.sh`, which groups by role and counts the tool frequency, the status=fail ratio, and the average duration of a story in activity.jsonl. Output a readable table

5. **title**: fixture: verify the role field is written correctly
   **context**: A unit test constructs a call with the LATTICE_ROLE env and asserts the written activity.jsonl line contains the corresponding role

**Test directions**
- happy: env set → both activity.jsonl and health.jsonl record the correct role
- edge: when env is unset the role is 'unknown' and no error occurs
- adversarial: when the env value contains spaces/special characters, sanitization does not break the JSONL

**Acceptance**
- New lines in activity.jsonl contain the role field
- wave0-review.sh can produce a role-grouped data table
- fixture coverage

**Touchpoints**
- Modify: `packages/lattice/packages/main/src/core/activity.ts`
- Modify: `packages/lattice/packages/main/src/core/health.ts`
- Create: `packages/lattice/scripts/wave0-review.sh`
- Modify: `packages/lattice/CLAUDE.md` (env-convention section)

---

### S-04: Wave 0 data review (gate)

**Description**

After S-01 ~ S-03 land, **observe for a mandatory 2 weeks** (at least 5 stories run to completion with implementer delegate), then do a written data review.

The key metrics of the review:
1. **Change in shortcut rate**: after a story is finished, the number of occurrences of "entering TEST / DONE with a checklist item not truly completed". before is the data from the 2 weeks prior to the observation window, after is the data from the observation window
2. **Change in DEV phase duration**: whether delegate significantly lengthens it (because of the agent-spawn cold start)
3. **Change in token cost**: implementer context rebuild vs the total tokens of the main agent doing it mixed
4. **Change in false reporting**: whether the main agent story_advances without re-checking after the implementer returns

**Decision tree**:

| Shortcut rate | DEV duration | Token cost | Decision |
|---|---|---|---|
| down >30% | <1.5x | <2x | ✓ proceed to Wave 1 |
| down 10-30% | <1.5x | <2x | ⚠ observe 2 more weeks before deciding |
| down <10% | any | any | ✗ roll back Wave 0, reflect on the root cause |
| any | >2x | any | ⚠ optimize the implementer prompt first, then decide |
| any | any | >3x | ✗ cost unacceptable, roll back |

The review result is written into this story's `decision.json`, as the basis for whether to proceed to Wave 1.

**Checklist**

1. **title**: Wait until the observation window has reached 2 weeks and at least 5 stories have used the implementer
   **context**: The DEV phase of this story is precisely "waiting"; no code is written. The date of entering this story is recorded in index.json's startedAt

2. **title**: Run wave0-review.sh to collect data
   **context**: Output the tool frequency / fail rate / duration grouped by role. Also run the data for the before-period once (find the activity.jsonl snapshot from the 2 weeks before S-01 in the git history)

3. **title**: Manually annotate the "shortcut rate"
   **context**: Automatically judging a "shortcut" is hard. Manually look at the DONE merge commit of each story over the past 2 weeks and judge whether there was a checklist lie / a falsely-passing test. Write it into review.md

4. **title**: Fill in decision.json
   **context**: Fill in the decision per the decision tree above, `{decision: "proceed-wave-1" | "observe-more" | "rollback"}`, with detailed reasoning

5. **title**: Execute according to the decision
   **context**: proceed → create the Wave 1 stories. observe-more → do not enter a new wave, extend the observation window. rollback → delete .claude/agents/lattice-implementer.md and the related sections of CLAUDE.md, and restore the main agent holding both roles

**Test directions**
- This story has no code tests, only a data review
- You can write a fixture to verify that the output format of wave0-review.sh is stable for common jsonl inputs

**Acceptance**
- decision.json exists and contains an explicit `decision` field
- The observation-window data is archived (keep it even if the decision is to roll back)

**Touchpoints**
- Create: `docs/story/actives/B-xxxx/review.md`
- Fill: `docs/story/actives/B-xxxx/decision.json`
- (if rollback) Modify: `packages/lattice/CLAUDE.md`, delete `.claude/agents/lattice-implementer.md`

---

## Wave 1: Make Test Execution Deterministic

**Precondition**: the Wave 0 S-04 gate decides `proceed-wave-1`.

**Goal**: completely strip test execution out of LLM judgment. The LLM only appears in the diagnosis phase.

---

### S-05: Downgrade test_auto from an LLM tool to an automatic phase-transition action

**Description**

Current state: test_auto is a lattice handler that the main agent calls as an ordinary tool. The problem: the LLM can choose not to call it, call it and selectively read the result, or read it and selectively report.

Refactor: turn test_auto into an action that is **triggered automatically** when entering `story_advance --phase TEST`. The main agent does not need to (and cannot) call test_auto explicitly; it can only call story_advance, and test_auto runs as a side effect of the phase transition, with the result written into test-runs.json, and then the phase lands at TEST or falls back to DEV (depending on the result).

**Key contract**:
- The return value of `story_advance --phase TEST` contains the full result of the test run (the pass/fail totals, the name of the first failing case, and its stdout tail)
- On fail, the phase does not enter TEST and stays at DEV, and the nextStepHint points to test-analyst diagnosis
- On pass, the phase enters TEST, and the nextStepHint points to story_advance --phase DONE
- The original test_auto handler is **kept but marked @deprecated**, only for direct calls by a sub-agent or script; the main agent is disabled for it at the prompt layer

**Why keep it rather than delete it**:
- Existing fixtures depend on it
- A sub-agent (e.g. test-analyst) still needs it when debugging
- Deletion is a breaking change and requires a separate story

**Checklist**

1. **title**: story-advance.ts automatically calls test_auto in the `newState === 'TEST'` branch
   **context**: Call test_auto **before** the phase change takes effect, and store the result in a local variable. Only when test_auto fully passes does the phase actually enter TEST; otherwise the phase stays at DEV and the fail details are returned

2. **title**: Extend the return-value type of story_advance
   **context**: Add a `testResult?: { pass: number; fail: number; firstFailure?: { name: string; stdoutTail: string } }` field. The type is defined in `core/types.ts`

3. **title**: Make CLAUDE.md explicit that the main agent should not call test_auto directly
   **context**: Add a line: "Test execution in the TEST phase is a side effect of story_advance; do not call test_auto separately". Also note that test_auto is still usable in the sub-agent / script scenario

4. **title**: Add an @deprecated tag to the test_auto handler (warn when the main agent calls it)
   **context**: The handler entry checks `process.env.LATTICE_ROLE === 'main'` and console.warns, suggesting "please trigger it indirectly via story_advance". Do not hard-block; keep compatibility

5. **title**: fixture: verify the test execution and fallback during story_advance TEST
   **context**: Construct a scratch story with a passing fixture → story_advance TEST succeeds and enters TEST. Then construct a failing one → story_advance TEST fails, stays at DEV, and returns testResult

**Test directions**
- happy: the pass case correctly enters TEST
- edge: when the fixture directory is empty, test_auto returns "no tests", and the phase can still enter TEST (a trivial story is allowed to have empty tests)
- adversarial: when test_auto itself throws an exception, the phase does not change, and an error is returned that clearly tells the main agent

**Acceptance**
- Run a fail scenario on a real machine and observe that story_advance TEST falls back correctly
- The fixture covers the three paths pass/fail/empty

**Touchpoints**
- Modify: `packages/lattice/packages/main/src/handlers/story-advance.ts`
- Modify: `packages/lattice/packages/main/src/core/types.ts`
- Modify: `packages/lattice/packages/main/src/handlers/test-runner-core.ts` or `test-auto.ts`
- Modify: `packages/lattice/CLAUDE.md`
- Create/modify: `packages/lattice/packages/main/tests/fixtures/story-advance-test-auto.json`

---

### S-06: test-analyst fork agent (triggered only on fail)

**Description**

Create `.claude/agents/lattice-test-analyst.md`. Responsibility: when the testResult.fail of story_advance --phase TEST is > 0, the main agent calls `Agent(subagent_type: "lattice-test-analyst", prompt: contains the failing case name and stdout tail + the list of changed files)`, and the analyst judges the root cause.

The analyst's output:
1. Root-cause classification: `code-bug` / `test-bug` / `environment` / `flaky` / `unknown`
2. Suggested fix path: go back and edit the code / go back and edit the test / re-run / upgrade a dep
3. Write `bug.json` (if it is `code-bug` or `test-bug`)

The analyst's tightened permissions:
- tools: Read / Glob / Grep / Bash(git diff|log|show) / `lattice bug_report`
- **cannot Edit / Write** — it only diagnoses, it does not fix
- **cannot story_advance** — phase advancement is the main agent's business

**Why the analyst cannot fix**: to avoid "setting your own exam and answering it yourself". After the analyst diagnoses a code-bug, it must return to the main agent → delegate to the implementer to fix, forming a "diagnoser / implementer" closed loop.

**Checklist**

1. **title**: Create `.claude/agents/lattice-test-analyst.md`
   **context**: frontmatter: name, whenToUse="Use when lattice test phase fails and needs root cause analysis", tools (Read/Glob/Grep/Bash allowlist), disallowedTools (Edit/Write/NotebookEdit), permissionMode: acceptEdits, isolation: worktree (reuse the story worktree)

2. **title**: Write the diagnosis workflow in the system prompt
   **context**: 5 steps: (1) read testResult.firstFailure.stdoutTail (2) git diff HEAD to see recent changes (3) read the source files of the failing cases (4) classify the root cause (5) write bug.json or return a decision. Particularly emphasize: cannot touch code/tests, can only write bug.json

3. **title**: Add an analyst delegate hint to the story_advance TEST fail branch
   **context**: Add a passage to the hint text: "on fail, please call Agent(subagent_type='lattice-test-analyst', prompt='storyId + testResult JSON + recent diff hint')". Include a concrete prompt template

4. **title**: Real-machine smoke: construct a deliberately-failing story and run the full analyst flow
   **context**: A scratch story with a deliberately wrong fixture → story_advance TEST fails → call the analyst per the hint → observe whether the analyst classifies correctly and writes bug.json

5. **title**: Verify the analyst cannot overreach and fix code
   **context**: Give the analyst an obviously fixable bug and observe whether it attempts Edit (should be blocked at the tool layer) or correctly returns "needs the implementer to fix"

**Test directions**
- happy: a typo-class code-bug is correctly diagnosed and bug.json is written
- edge: a flaky test (passes on the second run) — the analyst returns the `flaky` classification
- adversarial: when the analyst attempts Edit it is rejected by tool permissions

**Acceptance**
- `.claude/agents/lattice-test-analyst.md` exists
- The real-machine smoke proves the diagnosis closed loop
- That the analyst cannot Edit is provable

**Touchpoints**
- Create: `.claude/agents/lattice-test-analyst.md`
- Modify: `packages/lattice/packages/main/src/handlers/hints.ts`
- Create: `docs/story/actives/B-xxxx/smoke/analyst-smoke.md`

---

### S-07: Tighten the test-evidence.json protocol + add an attribution field to bug.json

**Description**

Wave 1 introduces the two roles implementer and test-analyst that write artifacts. The current test-evidence.json and bug.json schemas have no "who wrote it" field, making it hard to trace the data flow. This story is a schema extension + anti-impersonation defense.

**Fields added to test-evidence.json**:
- `producedBy`: `'main' | 'implementer' | 'test-analyst'`
- `method`: `'manual' | 'story_advance_trigger' | 'analyst_repro'`
- `verifiedAt`: ISO timestamp

**Fields added to bug.json**:
- `identifiedBy`: `'main' | 'test-analyst'`
- `fixedBy`: `'main' | 'implementer'`
- `fixStatus`: `'open' | 'in_progress' | 'fixed'`

**Hard write-permission constraints**:
- the implementer is blocked from writing bug.json (exclusive to test-analyst)
- test-analyst is blocked from writing test-evidence.json (written by the story_advance script)

These two constraints add a role check at the handler layer: something like `if (role === 'implementer' && handlerName === 'bug_report') throw`. role is read from `process.env.LATTICE_ROLE` (already laid down by S-03).

**Checklist**

1. **title**: Extend the test-evidence.json schema + migration
   **context**: Add the new fields to the `TestEvidence` type in `core/types.ts`. When reading an old test-evidence.json, use defaults for missing fields, not breaking old stories

2. **title**: When story_advance automatically triggers test_auto, write `producedBy: 'main'` + `method: 'story_advance_trigger'` into test-evidence
   **context**: Follow the S-05 logic, filling in the new fields when writing test-evidence

3. **title**: Extend the bug.json schema + migration
   **context**: Add fields as above; use defaults when reading old bug.json

4. **title**: Add a role write-permission check at the handler layer
   **context**: The `bug_report` handler entry checks LATTICE_ROLE. If it is `implementer` then throw `'bug_report is not allowed for role=implementer, delegate back to main for analyst dispatch'`. The `test_auto` entry likewise checks for a non-`main` role

5. **title**: fixture: role-overreach test
   **context**: Simulate calling bug_report with env LATTICE_ROLE=implementer and assert it throws

**Test directions**
- happy: each role can only write its own artifact
- edge: when LATTICE_ROLE is unset it defaults to 'unknown', allowed under the lenient rule (to avoid deadlocking old sessions)
- adversarial: deliberately forging the env to attempt overreach is blocked

**Acceptance**
- The new schemas of test-evidence.json and bug.json take effect
- The role write-permission check has fixture coverage
- Old stories can still be read compatibly

**Touchpoints**
- Modify: `packages/lattice/packages/main/src/core/types.ts`
- Modify: `packages/lattice/packages/main/src/handlers/bug.ts`
- Modify: `packages/lattice/packages/main/src/handlers/test-runner-core.ts` or `test-auto.ts`
- Create/modify: a role-overreach fixture

---

### S-08: Wave 1 data review (gate)

**Description**

Isomorphic to S-04. Key metrics:
1. **Test false-pass rate**: before (the main agent can call test_auto directly and report selectively) vs after (test execution becomes an automatic phase-transition action)
2. **Diagnosis accuracy of test-analyst**: manually annotate whether the `identifiedBy` judgment in the bug.json written by the analyst really hits the root cause
3. **DEV ↔ TEST loop count**: the round-trip count of fail → analyst → implementer fix → test again

The decision tree is similar to S-04. The output is written into `decision.json`.

**Checklist**

1. **title**: Observation window of 2 weeks + at least 3 stories go through the TEST fail path
   **context**: If there is no fail at all in 2 weeks, it may mean the scenarios needing diagnosis were not covered; extend the observation window

2. **title**: Run wave1-review.sh (an extension of the wave0 analysis script)
   **context**: Add dimensions such as "test false-pass rate" and "analyst classification distribution"

3. **title**: Manually verify the analyst's diagnosis accuracy
   **context**: Go through bug.json one by one and label correct / partial / wrong. Write review.md

4. **title**: Fill in decision.json to decide whether to proceed to Wave 2 or stop

**Test directions**, **Acceptance**, **Touchpoints**: same structure as S-04

---

## Wave 2: plan self-critique mode

**Precondition**: the Wave 1 S-08 gate decides `proceed-wave-2`.

**Goal**: without creating a new independent agent, have the main agent go through one round of "switching mental mode and finding faults in its own work" during the plan phase, to see whether the adversarial output has real value.

---

### S-09: plan agent self-critique mode switch instruction

**Description**

Add a step to the main agent's PLAN phase flow: after the checklist + testIntent are written, **a meta-prompt instruction makes the agent switch to "red team mode"**, read the plan it just wrote, and find faults. The fault-finding scope is **hard-locked to 3 categories** (to avoid generic noise):

1. **Unverified assumptions**: factual statements in the plan ("function X is at line Z of file Y", "the interface returns JSON") must have evidence (a file path / command output / a documentation link). Record those lacking evidence as `unverified`
2. **Missing boundaries**: if the testIntent of a checklist item has only happy and no edge/adversarial, record `missing-edge`
3. **Undocumented decision**: if the plan implicitly chose option A without explaining why it did not choose B, record `undocumented-decision`

The categories **not to find faults in**:
- generic risks (disk, network, signals)
- implementation details (that is the implementer's business)
- test-coverage numbers (that is test-analyst's business)

After fault-finding, the main agent switches back to plan mode and decides for each critique:
- `resolve` → modify the checklist / testIntent / decision, and record the corresponding modification
- `dismiss` → write a dismiss reason (at least 20 characters), citing concrete story context

**Key implementation point**: self-critique is a prompt-layer refactor; it does not touch the handler. Via the nextStepHint after checklist_update or testintent_record, guide the main agent into critique mode.

**Checklist**

1. **title**: Add the `CRITIQUE_MODE_PROMPT` constant to `cli-prompts.ts`
   **context**: This prompt is the main agent's "switch mental mode" instruction. Hardcode the 3 fault-finding categories + the 3 categories not to find faults in + the output format requirements

2. **title**: The trigger condition for PLAN phase completion
   **context**: When should the main agent enter critique? Definition: after every checklist item has a title + context + happy testIntent. Inject the prompt "now enter critique mode" into the hint of `checklist_update` or `testintent_record` in `hints.ts`

3. **title**: Define a structure for the critique output
   **context**: Add the `PlanCritique` type to `core/types.ts`: `{ category: 'unverified' | 'missing-edge' | 'undocumented-decision'; itemId?: string; message: string; evidence?: string }`

4. **title**: Write the critique-mode workflow in CLAUDE.md
   **context**: Make clear to the main agent: (a) when entering critique, switch mental mode and assume you are the red team (b) the fault-finding scope is strictly limited (c) after finding faults, switch back to plan mode to resolve/dismiss

5. **title**: Real-machine smoke: run a PLAN phase once and observe the critique output
   **context**: Write a deliberately flawed plan (an assumption with no evidence + missing edge) and observe whether the main agent hits them correctly during the critique phase

**Test directions**
- happy: a complete plan → all 3 critique categories can be hit at least somewhat
- edge: a plan with nothing to fault (theoretically should not exist but the model might produce one) — the critique output is an empty array with no error
- adversarial: the main agent in critique mode picks a "generic risk", and on the next round it must reject it itself

**Acceptance**
- CRITIQUE_MODE_PROMPT exists and can be referenced by the hint
- Real-machine verification that the critique output structure is correct

**Touchpoints**
- Modify: `packages/lattice/packages/main/src/cli-prompts.ts`
- Modify: `packages/lattice/packages/main/src/handlers/hints.ts`
- Modify: `packages/lattice/packages/main/src/core/types.ts`
- Modify: `packages/lattice/CLAUDE.md`

---

### S-10: plan-critique.json artifact + dismiss mechanism

**Description**

Give the critique output a persistence location `docs/story/actives/B-xxxx/plan-critique.json`, schema:

```json
{
  "critiques": [
    {
      "id": "pc-1",
      "category": "unverified" | "missing-edge" | "undocumented-decision",
      "itemId": "CHK-003",
      "message": "CHK-003 assumes the foo function is at line 42 of a.ts, but there is no evidence",
      "createdAt": "2026-04-09T10:00:00Z",
      "resolution": null | {
        "status": "resolved" | "dismissed",
        "reason": "an explanation of at least 20 characters",
        "resolvedAt": "2026-04-09T10:15:00Z",
        "diff": "optional: what was modified"
      }
    }
  ],
  "createdBy": "main:critique-mode",
  "schemaVersion": 1
}
```

Two new lattice handlers:
- `plan_critique_record`: called by the main agent in critique mode, appends critiques
- `plan_critique_resolve`: called by the main agent after switching back to plan mode, marks resolve/dismiss

**Hard constraints**:
- once a critique is recorded it cannot be deleted (append-only)
- a dismiss reason must be ≥ 20 characters
- the PLAN → DEV phase gate checks that all critiques have a resolution (resolved or dismissed), otherwise it blocks

**Checklist**

1. **title**: Define the `PlanCritiqueFile` type + reader/writer
   **context**: Reference the jsonl/json file read-write pattern of `decision.ts` / `review.ts`. plan-critique.json is fully overwritten on each write (it is not an append-only file, but logically it is append-only because deleting an entry is not allowed)

2. **title**: the `plan_critique_record` handler
   **context**: Parameters `{ storyId, critiques: PlanCritique[] }`. Append to the existing file, generate `pc-N` ids, validate the category enum. If an itemId is given, verify that the item exists in the checklist

3. **title**: the `plan_critique_resolve` handler
   **context**: Parameters `{ storyId, critiqueId, status, reason, diff? }`. Add a reason-length check. Do not allow modifying an already-resolved critique again

4. **title**: the PLAN → DEV phase gate checks that all critiques are resolved
   **context**: Add a guard to `machine.ts`: if plan-critique.json exists and has an entry with resolution=null, block entry to DEV. List the unresolved critique ids in the error message

5. **title**: the `story_review` handler reads the critique data
   **context**: Append critique statistics (total / resolved / dismissed / category distribution) to the output of story_review

6. **title**: fixture covering happy/edge/adversarial

**Test directions**
- happy: record 3 critiques → resolve 2 + dismiss 1 → all resolved → the phase gate lets it through
- edge: a single critique unresolved → the phase gate blocks
- adversarial: a dismiss reason of 10 characters → rejected

**Acceptance**
- plan-critique.json is read and written correctly
- the phase gate hard-checks
- complete fixture coverage

**Touchpoints**
- Create: `packages/lattice/packages/main/src/handlers/plan-critique.ts`
- Modify: `packages/lattice/packages/main/src/core/types.ts`
- Modify: `packages/lattice/packages/main/src/core/machine.ts`
- Modify: `packages/lattice/packages/main/src/handlers/story-review.ts`
- Create: fixture file

---

### S-11: Insert the PLAN_REVIEW phase + gate conditions

**Description**

The phase machine is currently `PLAN → DEV`. Insert an intermediate phase `PLAN_REVIEW`:

```
PLAN → PLAN_REVIEW → DEV
```

- `PLAN → PLAN_REVIEW`: the condition is that every checklist item has a title + context + happy testIntent (i.e. the "ready to enter critique" condition identified in S-09)
- `PLAN_REVIEW → DEV`: the condition is that every critique in plan-critique.json is resolved + decision.json has a record of the key choices (the S-10 gate)

The allowed-tools allowlist of the `PLAN_REVIEW` phase:
- `plan_critique_record`
- `plan_critique_resolve`
- `checklist_update` (allows the main agent to modify the checklist while resolving)
- `testintent_record` (allows filling in edge/adversarial)
- `decision_set` (allows filling in the decision record)

**Not allowed**:
- `story_advance` (must go through the gate)
- `fixture_batch_add` (that is a TEST_CASE phase matter)
- `Agent(implementer)` (not yet at DEV)

**Checklist**

1. **title**: Add `PLAN_REVIEW` to the state list in `core/machine.ts`
   **context**: Update the `PhaseEnum` and the transition table. Note backward compatibility: if an old story's phase is `PLAN`, when story_advance enters the next step it defaults to entering `PLAN_REVIEW` first

2. **title**: the PLAN → PLAN_REVIEW guard
   **context**: Every checklist item has a title/context/testIntent.happy. Otherwise return the error "please complete the checklist before entering PLAN_REVIEW"

3. **title**: the PLAN_REVIEW → DEV guard
   **context**: plan-critique.json exists and all critiques are resolved, and (softly) decision.json exists. When there is no critique file, downgrade to advisory (backward compatibility for old stories)

4. **title**: allowed tools per the phase allowlist
   **context**: In `cli-engine.ts` or the handlers context, filter the list of callable handlers by phase. There is already similar logic (the TEST_CASE_REVIEW allowlist of test_fixture + test_story); extend it to PLAN_REVIEW

5. **title**: the hint when story_advance enters PLAN_REVIEW
   **context**: The hint says "please enter critique mode, use plan_critique_record to record faults, and after resolve/dismiss use story_advance --phase DEV"

6. **title**: old-story compatibility test
   **context**: Simulate an existing active story at the PLAN phase, run story_advance and see whether it correctly enters PLAN_REVIEW rather than DEV directly

7. **title**: rollback script
   **context**: In case PLAN_REVIEW causes a blockage, provide an emergency override: `story_advance --phase DEV --skip-plan-review --reason "..."`. reason is required and written into activity.jsonl for easy tracing

**Test directions**
- happy: the full PLAN → PLAN_REVIEW → DEV flow
- edge: an old story going from PLAN to DEV passes through PLAN_REVIEW (using the skip parameter)
- adversarial: when a critique is unresolved, PLAN_REVIEW → DEV is blocked

**Acceptance**
- The phase machine diagram is updated
- The guard has a fixture
- The skip escape hatch has a fixture

**Touchpoints**
- Modify: `packages/lattice/packages/main/src/core/machine.ts`
- Modify: `packages/lattice/packages/main/src/core/types.ts` (PhaseEnum)
- Modify: `packages/lattice/packages/main/src/handlers/story-advance.ts`
- Modify: `packages/lattice/packages/main/src/handlers/hints.ts`
- Modify: `packages/lattice/packages/main/src/cli-engine.ts` (phase-scoped allowed tools)

---

### S-12: Wave 2 data review (gate)

**Description**

Isomorphic to S-04 / S-08. Key metrics:
1. **Critique data distribution**: the category ratio, the resolved vs dismissed ratio
2. **Critique hit rate**: manually annotate the ratio of "correctly faulted / generic noise / meaningless"
3. **Change in DONE quality**: for stories after Wave 2, check back within 2 weeks of the DONE merge whether there are "the plan phase did not think of it"-class bugs

**Decision tree**:

| Critique hit rate | resolve rate | Dismissed noise ratio | Decision |
|---|---|---|---|
| > 60% | > 50% | < 30% | self-critique is good enough, **stop at Wave 2, do not split out an independent red-team agent** |
| 40-60% | > 30% | < 50% | ⚠ optimize CRITIQUE_MODE_PROMPT and observe again |
| < 40% | any | > 50% | self-critique is ineffective; splitting out an independent red-team agent might help, proceed to Wave 3 to try |
| any | < 10% | any | the critique flow itself has a problem, roll back S-11 |

**Checklist**

1. **title**: Observation window of 3 weeks + at least 5 stories go through the critique flow
2. **title**: Run wave2-review.sh
3. **title**: Manually verify the critique hit rate
4. **title**: Fill in decision.json to decide: stop / optimize and observe again / proceed to Wave 3 / roll back

**Test directions**, **Acceptance**, **Touchpoints**: same structure as S-04

---

## Wave 3: Conditional Independent red-team Agent

**Precondition**: S-12 decides self-critique is not enough and an independent agent is needed.

### S-13: independent red-team agent definition (conditional)

**Description** (skeleton; details to be expanded when we actually reach this step)

If the Wave 2 data proves the limitation of self-critique (the same mind has a hard time truly finding faults in itself), then create `.claude/agents/lattice-red-team.md`:

- dedicated to the PLAN_REVIEW phase
- independent context (fresh agent), seeing only checklist.json + decision.json, not the main agent's thought trace
- the fault-finding scope is still the 3 categories of S-09 (unverified / missing-edge / undocumented-decision)
- the output is written into plan-critique.json
- the main agent delegates to red-team as the very first step of the PLAN_REVIEW phase

Details left blank. The Wave 3 checklist will be filled in when we actually enter it.

---

## Cross-cutting Stories

### S-X1: artifact write-permission matrix (restricted by role)

**Description**

Done alongside S-02. Add a layer of role check at the common entry of the lattice handler:

```ts
const ROLE_ARTIFACT_WRITE: Record<string, Set<string>> = {
  main: new Set(['*']),
  implementer: new Set(['checklist_update', 'update_task_state', 'fixture_batch_add']),
  'test-analyst': new Set(['bug_report']),
  unknown: new Set(['*']),  // compatible with old sessions
};
```

The entry point is before the tool dispatch in `cli-engine.ts`. role is read from the `LATTICE_ROLE` env. Overreach → return a clear error.

**Checklist** (omitted, simple structure)

### S-X2: role awareness of watchdog / session_brief

**Description**

The watchdog currently detects "idle 2min → kill", assuming one agent is present throughout. When delegating to the implementer, the main agent does not move in the short term, but the implementer is moving. The watchdog must not kill by mistake.

Refactor: when the watchdog reads activity.jsonl, count the role field as well; as long as **any role** has activity, the story counts as alive.

`session_brief`'s `computeNextStep` must also be able to distinguish "main is waiting for the implementer to report back" vs "main itself is stuck".

**Checklist** (omitted)

### S-X3: role-tag pass-through in hooks

**Description**

Done alongside S-03. Add `LATTICE_ROLE` pass-through to the hook env, so the preCommand / postCommand scripts can branch by role.

**Checklist** (omitted)

---

## Implementation Recommendations

### Landing order

**Wave 0 must be finished first; it is the de-risking slice of the entire plan**. Before the Wave 0 decision is clear, do not open Wave 1/2 at the same time.

```
Week 1: Wave 0 coding
  Day 1: S-01 (implementer agent definition)
  Day 2-3: S-02 (DEV/TEST_CASE dispatch)
  Day 4: S-03 (role-tagged telemetry)
  Day 5: real-machine verification + wrap-up

Weeks 2-3: Wave 0 observation window
  (no code, just run stories to accumulate data)

Start of Week 4: S-04 data review
  decision → next step

(if proceed-wave-1)

Weeks 4-5: Wave 1 coding
  S-05 + S-06 + S-07

Weeks 6-7: Wave 1 observation window + S-08 review

Weeks 8-9: Wave 2 coding (if)

Weeks 10-12: Wave 2 observation window + S-12 review
```

**Do not overlap waves**. Overlapping makes data attribution chaotic and renders the gate decision meaningless.

### Do not rush to skip the gate

The gate story of each wave looks like it is "just waiting and looking at data", but this is **the most critical story** in the entire plan. Skipping the gate and entering the next wave directly is equivalent to flying blind. If there really is an urgent business need to do Wave 1 early, there must still be Wave 0 observation data first — even just 3 stories' worth of data is better than none.

### Wave 0's silent exit conditions

If any of the following occurs within 2 weeks of Wave 0 landing, **immediately pause new stories entering the implementer delegate path**, return to the main agent holding DEV, and investigate the cause:

- the implementer exceeds maxTurns without finishing in 3 or more stories
- the `status=fail` ratio in the implementer's activity.jsonl is > 30%
- the main agent story_advancing without re-checking after the implementer returns occurs 2 or more times (manual spot-check)
- the CC sub-agent mechanism itself has a bug (e.g. the isolation worktree is not cleaned up, or the sub-agent fails to launch)

### Rollback playbook

Every wave has a rollbackable point. Concrete operations:

**Wave 0 rollback**:
```bash
rm .claude/agents/lattice-implementer.md
git revert <S-02 commit>   # the CLAUDE.md + hints.ts changes
# the role field in activity.jsonl is additive and can be kept
```

**Wave 1 rollback**:
```bash
rm .claude/agents/lattice-test-analyst.md
git revert <S-05 commit>   # the story_advance auto test_auto change
# the new fields in test-evidence.json / bug.json are additive, kept
```

**Wave 2 rollback**:
```bash
git revert <S-11 commit>   # delete the PLAN_REVIEW phase
# old stories' plan-critique.json is kept, just no phase gate uses it
# CRITIQUE_MODE_PROMPT can be kept, just no longer guides the main agent via a hint
```

After each rollback, a retrospective (review.md) must be written, answering at least:
1. Why did it not meet expectations?
2. Was it a wrong direction or wrong execution?
3. What are the preconditions for the next attempt?

---

## One-sentence Summary

**Do not split into 4 independent agents at once**. Split out the most certain one first (implementer), and use 2 weeks of data to verify whether role isolation can reduce the real pain points. If it can, then make test execution deterministic (Wave 1). If that is OK too, then try the adversarial role with self-critique mode (Wave 2). Only if self-critique is not enough do we consider an independent red-team agent (Wave 3).

Every wave has a mandatory gate story and a rollback playbook. The gate's data decision matters more than the coding itself — that is the step that truly decides what lattice looks like.

---

## Advisory Read-Only Reviewer Mode (`LATTICE_REVIEWER_READONLY=1`)

Some workflows delegate read-only review to an external Claude/Codex/Gemini process that is
**not** a normal Proofbound gate reviewer. These advisory reviewers should not be able to call
mutating Proofbound commands — they are expected to return structured text or JSON findings to the
owner session, which then records evidence through the normal gate.

### Dispatch rule for owner agents

When an **owner session** launches an advisory external reviewer (Claude/Codex/Gemini), it
**must** set `LATTICE_REVIEWER_READONLY=1` on that spawned process only — not on the owner
session itself or on any normal Proofbound gate reviewer subagent.

```bash
# Correct: sandbox only the advisory process
LATTICE_REVIEWER_READONLY=1 claude --model sonnet ... --prompt "inspect src/ and return JSON findings"

# Wrong: do NOT set this on normal gate reviewers
# lattice-review-concept, lattice-review-quality, etc. must NOT have this env set
```

The owner instructs the advisory reviewer to return structured JSON or plain-text findings and
**explicitly prohibits** the reviewer from calling any of the following Proofbound commands:

- `review_pass_set` — would forge a gate-pass artifact
- `finding_add` — would forge a signed finding
- `review_run_start` — would open a review run the owner doesn't control
- `init_check_set` — would forge an init-check artifact
- `delivery_check_set` — would forge a delivery-check artifact
- `story_advance` — would advance the story phase without owner decision
- `verification_evidence_add` — would inject evidence the owner hasn't verified

The advisory reviewer must return its findings as structured output (JSON preferred), not call
any of the above commands itself.

### What LATTICE_REVIEWER_READONLY=1 enforces

When set on a spawned reviewer process:

- Only commands with `CommandPolicy.ownershipClass === 'readOnly'` are allowed (e.g.
  `session_brief`, `story_get`, `checklist_get`, `finding_list`).
- All `reviewerWrite`, `storyScopedMutating`, `mainSharedMutating`, `dangerousMutating`, and
  unclassified commands are rejected before preCommand hooks and before the owner-lease gate.
  The error names the env var, the blocked command, its effective class, and the correct
  recovery path: return findings as text to the owner, who records them as evidence.
- `--takeover` / `--forceTakeover` cannot be used to bypass the restriction.

### Advisory reviewer output is not gate evidence

A read-only reviewer cannot produce a Proofbound `review_pass_set` record, a signed `finding_add`
entry, or any other lifecycle artifact. Owner sessions that receive advisory reviewer output
must explicitly call the relevant Proofbound commands themselves to materialize evidence.

### If LATTICE_REVIEWER_READONLY was omitted

If an owner session launched an advisory reviewer **without** setting `LATTICE_REVIEWER_READONLY=1`,
the owner must treat the reviewer's output as **non-sandboxed advisory text** and apply extra
scrutiny before recording any evidence:

1. **Do not assume the reviewer only read.** The reviewer may have called mutating commands.
   Check `lattice finding_list`, `lattice story_get`, and relevant artifact files (e.g.
   `review-passes.json`, `init-check.json`) to see if the reviewer wrote anything unexpected.
2. **Verify each claim independently** using `lattice` commands or direct file inspection before
   calling `finding_add`, `review_pass_set`, or `verification_evidence_add`.
3. **Discard any gate artifacts** (finding hashes, review pass records) that appear to have
   been written by the advisory reviewer directly — re-run or re-record them through the owner.

### Normal Proofbound gate reviewers must NOT set this mode

Standard reviewers (`lattice-review-*` subagents in REVIEW phase) need to call `review_run_start`,
`finding_add`, `review_pass_set`, `init_check_set`, `scope_check_save`, and
`delivery_check_set`. Setting `LATTICE_REVIEWER_READONLY=1` on a normal gate reviewer will block
all of those calls and break the review lifecycle.

### When to use

| Situation | Use LATTICE_REVIEWER_READONLY=1? |
|---|---|
| External Claude/Codex/Gemini asked to inspect code and return text/JSON findings | **Yes** — owner must set it on the spawned process |
| Normal `lattice-review-concept` / `lattice-review-quality` in REVIEW phase | **No** — reviewer must write gate artifacts |
| `lattice-evaluator` or `lattice-evaluator-cli` scoring product quality | **No** — evaluator uses normal write path |
| CI runner doing a read-only docs audit before reporting to owner | **Yes** |
| Advisory reviewer launched without LATTICE_REVIEWER_READONLY set | N/A — treat output as non-sandboxed, verify all claims manually |

---

## References

- `docs/requirements/decisions/cc-learnings.md` — the existing lattice refactor plan, the predecessor and baseline of this document
- `docs/requirements/decisions/task-checklist-cc-style.md` — the CC TodoWrite-style refactor, the source of this document's prompt pattern
- `CC/src/tools/AgentTool/builtInAgents.ts` — CC's built-in sub-agent definitions, the reference for the implementer/test-analyst agent definitions
- `packages/lattice/packages/main/src/handlers/story-advance.ts` — the B-7eed auto-merge implementation, the basis for the Wave 1 S-05 refactor
- `packages/lattice/packages/main/src/core/machine.ts` — the phase state machine, the place that Wave 2 S-11 will change
