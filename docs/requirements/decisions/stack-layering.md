# Claude Code / Codex × Superpowers × Proof-or-Stop Layering Notes (draft)

> 2026.04 · Explains the responsibility boundaries of the current system with a three-layer model, to stop "who is responsible for workflow, who for project state, who for runtime" from staying tangled together

## One-Sentence Conclusion

The recommended way to understand the current system is as three layers:

1. **Claude Code / Codex**: agent runtime
2. **Superpowers**: agent workflow / methodology
3. **Proof-or-Stop CLI / Proof-or-Stop**: project execution + verification substrate

The three layers are not a flat feature list, but a top-down division of labor:

```text
Claude Code / Codex
  ↓ provides the model, conversation, tool calling, subagents, UI host

Superpowers
  ↓ provides workflow, skills, methodology, default work habits

Proof-or-Stop CLI / Proof-or-Stop
  ↓ provides story / checklist / phase / gate / artifact / evidence / bug / review result
```

## Why Three Layers

In earlier discussions, it was easy to lump these three things into one "big all-in-one system":

- where the agent runs
- how the agent should work
- how project state is recorded, verified, and advanced

These three things are essentially three different questions:

| Layer | Question it answers |
|---|---|
| **Claude Code / Codex** | Where does the agent run, and what native capabilities does it have? |
| **Superpowers** | By what method should the agent work? |
| **Proof-or-Stop** | How is project state persisted, advanced, verified, and re-reviewed? |

If the boundaries are not drawn, two typical problems appear:

1. **Everyone wants to be the workflow orchestration layer**  
   Both Superpowers and Proof-or-Stop start issuing orders, and they fight each other.
2. **No one is responsible for project state**  
   The agent workflow looks complete, but story/gate/artifact/evidence has no clear foundation.

## Responsibilities of Each Layer

### 1. Claude Code / Codex: The Runtime Layer

This is the host layer, responsible for:

- the model itself
- the conversation context
- tool calling
- subagent capability
- the interactive UI
- the runtime environment for plugin / skill / agent assets

This layer should not be responsible for project-state semantics, nor should it directly define the business workflow itself.

Its responsibility is:

> **Let the agent run**

and not:

> **Dictate how the project advances**

### 2. Superpowers: The Workflow Layer

This is the work-method layer, responsible for:

- brainstorming
- writing-plans
- subagent-driven-development
- test-driven-development
- requesting-code-review
- finishing-a-development-branch

Its strengths are:

- shaping agent behavior
- reducing improvisation
- turning "how a reliable engineer would do it" into a skill-driven workflow

Its responsibility is:

> **Make the agent more like an engineer who works by process**

and not:

> **Persist project state and verification evidence for the long term**

### 3. Proof-or-Stop CLI / Proof-or-Stop: The Execution / Verification Substrate

This is the project-state layer, responsible for:

- story
- checklist
- phase
- gate
- worktree lifecycle
- review records
- test evidence
- bug / bug cleanup
- summary
- implementation review result
- artifact contract

Its strengths are:

- clarifying "how far we have gotten"
- clarifying "why we cannot continue"
- clarifying "where the evidence is"
- clarifying "whether it is actually done"

Its responsibility is:

> **Turn the workflow into a decidable, trackable, re-reviewable project state**

and not:

> **Design the entire way of working for the upper-layer agent methodology**

## How They Combine

The healthiest combination is not "who replaces whom," but:

- **Claude Code / Codex** provides the runtime
- **Superpowers** provides the workflow
- **Proof-or-Stop-era state artifacts** provide the historical state substrate
- **Proof-or-Stop CLI 0.3.5** is the active product entry point of this substrate

That is:

```text
User / agent
  ↓
Superpowers skills / workflow
  ↓ invokes
Proof-or-Stop CLI / MCP / story machine
  ↓ persists
story / checklist / phase / gate / artifact / evidence
```

A more plain-spoken version:

- **Claude/Codex**: lets the agent work
- **Superpowers**: tells the agent how it should work
- **Proof-or-Stop CLI / Proof-or-Stop**: records how far it actually got

## Mac App Boundary

Proof-or-Stop CLI 0.3.5 moves provider/config status into CLI-first surfaces:
`host_list`, `host_probe`, `host_install`, `proof_or_stop_config_doctor`,
`authority_status`, `conduit_status`, and `conduit_explain`. The Mac App is not
the required project-state or provider/config layer. It may remain an optional
dashboard/archive surface, but the CLI owns the cold-readable migration status.

These CLI surfaces do not create a model runner or production authority. They
report capability degradations and receipt requirements, and keep
`productionDone=false` / `receiptVerified=false` unless a future receipt-backed
authority path is implemented and mechanically verified.

## Why This Combination Is Stronger Than Using Them Alone

### The Risk of Superpowers Alone

Advantages:

- the agent workflow is very complete
- the experience is smooth
- well-suited to quickly pulling the model into the right habits

Risks:

- project state may not be sufficiently structured
- long-term re-review and cross-session alignment may not be hard enough
- "how far it actually got / why it can continue / where the evidence is" may be scattered across the chat and inside skills

### The Risk of Proof-or-Stop Alone

Advantages:

- phase / gate / artifact are very strong
- state is trackable
- the re-review capability is strong

Risks:

- agent-workflow shaping is less complete than Superpowers
- automatic skill triggering and the methodology experience are not as smooth
- it can feel like "the system is very hard, but the agent may not naturally use it well"

### The Benefit of Combining Them

The best form of the combination is:

- the top layer is smarter
- the middle layer is more disciplined
- the bottom layer is more verifiable

In other words:

> **Superpowers is responsible for "doing the right thing," and Proof-or-Stop is responsible for "the system knowing what it actually did."**

## Boundary Principles

To keep the three layers from fighting, it is recommended to follow these 3 boundaries:

### Principle 1: Superpowers Is Not Responsible for Long-Term Project State

Superpowers can trigger workflows, but should not define for itself:

- the story-lifecycle source of truth
- the final-judgment record of a gate
- the persistence protocol of bug/evidence

These should be Proof-or-Stop's responsibility.

### Principle 2: Proof-or-Stop Is Not Responsible for Shaping the Entire Agent Methodology

Proof-or-Stop should keep focusing on:

- state machine
- gate
- artifact
- verification

rather than trying to rewrite an entire set of:

- brainstorming techniques
- plan-writing styles
- subagent methodology
- TDD philosophy packaging

These are better suited to Superpowers.

### Principle 3: Claude/Codex Does Not Directly Carry Business-State Semantics

Claude/Codex provides the runtime and interaction, but should not become:

- the story source of truth
- the checklist source of truth
- the reviewer source of truth

Otherwise, as soon as you cross sessions / tools / agents, you lose state.

### Principle 4: Proof-or-Stop's Runtime Is Limited to Project State

The runtime here is not the agent runtime. Proof-or-Stop is not responsible for starting, recovering, or scheduling a Codex/Claude session, nor does it implement a general worker pool, prompt marketplace, token/model management, or notification system.

Proof-or-Stop prioritizes being observable, recoverable, and diagnosable, and the thing those properties land on should be the project-state runtime:

- `status`: read-only display of story / phase / worktree / reviewer / artifact / dirty risk
- `next`: read-only output of the currently most trustworthy next step
- `doctor`: diagnoses the health of the Proof-or-Stop flow and local state
- the optional future `.proof-or-stop/state`: can only be a deletable, rebuildable projection cache, and must not become a second source of truth

The hard boundary is: story, checklist, fixture, requirements, and git are still the sources of truth; all gates are still judged by the deterministic CLI / fixture / review record, not by the LLM's on-the-spot judgment.

## Mapping to Current Practice

Looking at the current repository, you can already see this layering starting to take shape:

### Claude Code / Codex Layer

- `.claude/agents/*`
- `.proof-or-stop-codex/agents/*`
- `bin/proof-or-stop-codex.js`
- runtime tool calling, subagents, interactive entry points

### Superpowers Layer (external methodology reference)

- brainstorming
- writing-plans
- subagent-driven-development
- requesting-code-review
- verification-before-completion

These are more like methods for "how to drive the agent," not things Proof-or-Stop itself needs to fully rewrite.

### Proof-or-Stop Layer

- `story_advance`
- `session_brief`
- `story_review`
- `test_story`
- `summary_set`
- `implementation_review_result_set`
- `phase invariant / reason code`
- `artifact contract`

These all belong to the project state / verification substrate.

## Direct Guidance for Proof-or-Stop

If you accept this layering, what Proof-or-Stop should prioritize next is not "adding more skills like Superpowers," but continuing to strengthen these foundational capabilities:

1. **A clearer state machine**  
   keep structuring phase / rollback / gate reason
2. **More unified artifacts**  
   let more reviewer / evidence / summary / implementation review results follow a unified contract
3. **More decidable verification**  
   reduce states that "look complete" but the system cannot confirm
4. **More stable runtime integration**  
   make worktree / reconcile / ownership drift less frequent when upper-layer workflows call Proof-or-Stop

## One-Sentence Positioning (recommended for external/internal phrasing)

The recommended unified phrasing:

> **Claude Code / Codex is the runtime, Superpowers is the workflow, Proof-or-Stop is the project execution and verification substrate.**

A bit more plainly:

> **They teach the agent how to do the work; we record how far it actually got.**
