---
name: koala-review-concept
description: REVIEW review: concept deletion completeness (grep scan for residuals)
model: sonnet
tools: Grep, Glob, Bash
---
<!-- koala:start -->
# CLAUDE.md

## Behavior Guidelines

0. **At the start of every new session or when resuming interrupted work, run `koala session_brief` as the first command**
1. Any requirement should go through the full Story flow, unless the user explicitly asks for an immediate edit in any language
2. Before taking action, run `koala session_brief` (project status + next-step hints), then Read key files as appropriate
3. Output should be concise, but reasoning should be thorough
4. Prefer editing over rewriting entire files
5. Test your code before declaring it done: `koala validate`
6. Keep solutions simple and direct
7. User instructions always override this file
8. **Do not directly read or write files under the `docs/story/` directory.** All story operations go through `koala story_create` / `koala checklist_*` / `koala bug_*` commands
9. **Code validation uses `koala validate` uniformly**

## Story Phase Transitions

Two tracks, automatically determined by the state machine:

```
Normal track:  INIT → INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE
Fast track:    INIT → INIT_CHECK ──────→ DEV → REVIEW → TEST → DONE
                                        (skips PLAN)
```

**Fast-track conditions**: checklist ≤ 2 items AND no riskSignals.

| Phase | What to do |
|---|---|
| **INIT** | `story_create` creates the story |
| **INIT_CHECK** | `story_advance INIT_CHECK` creates the worktree, prompts cd |
| **PLAN** | understanding → decision → checklist → plan.md (normal track) → `story_review`; once review passes, enter DEV (fast track skips PLAN) |
| **DEV** | Write code + write tests; once checklist is fully done, enter REVIEW |
| **REVIEW** | Based on riskSignals / touchpoints, automatically attach LLM reviewers (baseline concept+quality+test-coverage, others opt-in by signal; see "Reviewer opt-in routing" below) + CLI preflight gate (`validate --channel` / `--concept` / `--lint` / `docs-drift`, plus `codex-adapter` when touching the Codex adapter) runs automatically at REVIEW→TEST; `koala-review-channel` has been retired (S1) and is now taken over by the CLI. Main-agent acceptance: `finding_list` confirms reviewer findings are registered → resolve each one → once all blocking findings are resolved, enter TEST (any CLI gate fail will block directly) |
| **TEST** | `koala validate` to verify; once all green and all bugs are fixed, enter DONE |
| **DONE** | `story_advance DONE` merges back to main and cleans up the worktree. After DONE succeeds, trigger an audit prompt per `.koala/audit-config.json` (semi-auto mode appends an audit suggestion at the end of output; see "Framework self-introspection audit configuration" section) |

### How to pick the track

- **Small changes** (bug fixes, copy edits, config tweaks): when creating the story, write only 1–2 checklist items; once the worktree is created, directly `story_advance DEV` — the main agent does it itself
- **Normal changes** (new features, refactors, multi-file changes): go through the full PLAN (understanding_set + decision_set + checklist + plan.md + story_review), and dispatch to a subagent

## koala CLI Cheatsheet

```bash
koala story_create '{"name":"xxx","title":"...","description":"...","type":"feature","priority":"high","checklist":[{"title":"what to do","context":"context"}]}'
koala story_review '{"storyId":"B-xxx"}'
koala story_advance '{"storyId":"B-xxx","phase":"DEV"}'
koala checklist_get '{"storyId":"B-xxx"}'
koala checklist_update '{"storyId":"B-xxx","itemId":"CHK-001","status":"done"}'

# Validation
koala validate              # static + logic + integration tests
koala validate --full       # includes on-device tests
koala validate --json       # structured output
koala status                # quick at-a-glance status during work
koala serve                 # HTTP API debugging
koala serve --dev="..."     # with browser proxy

# PLAN-phase artifacts
koala understanding_set '{"storyId":"B-xxx","task":"...","outcome":"...","facts":[],"constraints":[],"unknowns":[],"touchpoints":[]}'
koala decision_set '{"storyId":"B-xxx","principles":[],"drivers":[],"options":[],"chosen":"A","rationale":"..."}'
```

## Framework Self-Introspection Audit Configuration

B-9bd9 introduced a "cross-story framework self-introspection audit" mechanism (periodically scans CLAUDE.md commitments vs. actual code behavior). Runtime parameters are resolved by `resolveAuditConfig(profile, projectRoot)`, with **no dedicated CLI command** (changed extremely rarely; hand-editing the JSON is sufficient — YAGNI).

**Meaning of the three fields**:

| Field | Type | Meaning |
|---|---|---|
| `auditTriggerWindow` | number | After how many completed stories an audit prompt is triggered (dual trigger combined with the CLAUDE.md diff condition) |
| `requireClaudeMdDiff` | boolean | Whether to require "CLAUDE.md changed within the window" before prompting for an audit (avoids empty runs) |
| `mode` | `"semi-auto"` / `"full-auto"` / `"off"` | semi-auto = only prompt, don't run; full-auto = run in the same process after DONE; off = completely disabled |

**Priority (high → low)**:

| Layer | Source | Description |
|---|---|---|
| 1 | `<projectRoot>/.koala/audit-config.json` | Project-level override, overrides field by field |
| 2 | profile defaults | `auditTriggerWindow`: light=10 / balanced=5 / strict=3 (other fields share the layer-3 hardcoded values across all profiles) |
| 3 | hardcoded fallback | `{auditTriggerWindow:5, requireClaudeMdDiff:true, mode:"semi-auto"}` |

**Hand-edit configuration**: directly edit `<projectRoot>/.koala/audit-config.json` (if needed):

```json
{
  "auditTriggerWindow": 3,
  "requireClaudeMdDiff": true,
  "mode": "semi-auto"
}
```

**Failure policy**:
- File doesn't exist → silently use profile defaults
- JSON parse failure / not an object → one-time `console.warn` + fallback to profile defaults
- Invalid `mode` value → warn + fallback to `"semi-auto"`
- Other field type errors → silently ignore that field

**Why no `koala audit_config_set` CLI is provided**: change frequency is extremely low (most projects change this 0–1 times in their lifetime); creating a dedicated command would only add memorization burden. Hand-editing the JSON is sufficient, and the schema can be reviewed at a glance in `packages/main/src/core/audit-config.ts`.

## Code Paradigm (Data / Machine / Fn)

All modelable code is divided into three atoms:

| Atom | File | Rules |
|---|---|---|
| **Data** | `data.ts` | Pure types/interfaces/constants, `readonly` |
| **Machine** | `machine.ts` | Pure configuration object, zero function definitions |
| **Fn** | `fn.ts` | Pure functions, no side effects, no I/O |

I/O shells (main.ts / ui.ts) only do input/output and contain no business logic.

## Core/Shell Layered Architecture

### Core Idea

The project is split into **core** (logical core, platform-agnostic) and **shells** (pure presentation layer). Shells (CLI/Browser) only import bridge.ts; **they do not import fn.ts**.

```
src/
├── core/                          # logical core (platform-agnostic)
│   ├── app.ts                     # application assembly: createApp() → { bridge }
│   ├── debug.ts                   # debug entry: devHost(createApp, Machine)
│   ├── machines/<name>/           # state machine module
│   │   ├── data.ts / machine.ts / fn.ts / bridge.ts
│   └── io/                        # I/O (LLM, network, files)
├── shells/                        # pure presentation layer (only rendering + input collection)
│   ├── cli/main.ts
│   └── web/ui.ts
└── validate.ts
```

### Responsibility Split

| Layer | Responsibilities | What it doesn't do |
|---|---|---|
| **app.ts** | Creates bridge + registers IO scheduling (AI, etc.) | No WS/fs/process, no rendering |
| **debug.ts** | Calls the framework's `devHost()`, attaches the shell | Doesn't write WS/fs logic (framework handles it) |
| **machines/** | State machine + pure functions + bridge interface | No I/O |
| **io/** | External I/O (LLM API calls, etc.) | No state management |
| **shells/** | Rendering + user input collection | Doesn't import fn.ts, doesn't hold business state, doesn't call I/O |
| **WS server** | **Framework**: `koala-dev` automatically starts WS bridge + proxy | Project doesn't need to write a WS server |
| **Debug API** | **Framework**: `koala serve` automatically generates endpoints from machine.ts | Project doesn't need to write an HTTP server |

**Key: the project only writes the LocalBridge (same-process direct connection). The WS channel and debug API are uniformly provided by the framework.**

### What is app.ts

`app.ts` is the core assembly file written by the project, **platform-agnostic** (runs in both browser and Node.js):

```typescript
// core/app.ts
export async function createApp() {
  const bridge = createLocalBridge();

  // IO scheduling: in PvE mode, white automatically calls AI
  bridge.onStateChange((state) => {
    if (state.mode === 'pve' && state.currentPlayer === 'white') {
      getAIMove(state.board, state.lastMove).then(pos => bridge.sendEvent('MOVE', pos));
    }
  });

  return { bridge };
}
```

- **Browser production run**: `ui.ts` imports `createApp()` → LocalBridge direct connection, zero WS
- **Node.js debug run**: `debug.ts` imports `createApp()` → framework wraps it with a WS server

### What is debug.ts

The project's debug entry, **3 lines**, framework handles all infrastructure:

```typescript
// core/debug.ts
import { devHost } from '@koala-agent/core/dev-host';
import { createApp } from './app.js';

```typescript
import { GameMachine } from './machines/game/machine.js';

const app = await devHost(createApp, GameMachine);

if (process.env.KOALA_SHELL === 'cli') {
  const { startCliShell } = await import('../shells/cli/main.js');
  startCliShell(app.bridge);
}
```

The framework's `devHost()` is responsible for: killing old processes → creating the app → starting the bridge-host WS → writing `.koala-serve.json` → cleanup.

### Bridge Interface

```typescript
// core/machines/game/bridge.ts
interface GameBridge {
  sendEvent(event: string, input: any): boolean;
  onStateChange(cb: (state: GameState) => void): () => void;
  getState(): GameState;
  getMachineState(): string;
  reset(): void;
}

// createLocalBridge: implemented in bridge.ts, imports machine.ts + fn.ts
// createWSBridge: used in the browser, connects to the WS server provided by koala-dev
// createBridge: auto-selects (detects window.__KOALA_WS_URL)
```

### Three Run Modes

```
Production:      npm start / vite           → LocalBridge direct connection inside app.ts
Dev debugging:   npm run serve / koala-dev   → core process + WS bridge + Dashboard
                 CLI/browser connect to the same logical instance simultaneously
Browser-only:    vite build                 → LocalBridge bundled into the browser
```

Startup commands:

```bash
npm start          # vite (Web shell + direct in-browser connection via app.ts)
npm run serve      # koala-dev (core + Dashboard)
npm run serve:web  # koala-dev --web (core + vite + Dashboard)
npm run serve:cli  # koala-dev --cli (core + CLI shell + Dashboard)
```

### Port Discovery (multi-worktree safe)

Ports are automatically allocated based on a hash of the projectRoot path, **so different worktrees / main branches do not collide with each other**.

On startup, `.koala-serve.json` is automatically written into the project directory:

```json
{
  "pid": 12345,
  "wsPort": 14926,
  "api": "http://localhost:22845",
  "dashboard": "http://localhost:22845/"
}
```

**Claude Code debugging flow**:

1. Read `.koala-serve.json` → obtain the `api` URL
2. If the file does not exist or the pid is dead → first start `npm run serve`
3. Use the URL you read to call the Bridge API / open the Dashboard

No need to memorize port numbers. `.koala-serve.json` is already added to `.gitignore`, and is automatically cleaned up when the process exits.

### Core Completeness Principle

**Core tests cover all transitions; cli/web cover as needed.**

```
Test layers:
✓ Logic tests (white-box)   — fn.ts pure functions, in-memory along the machine path
✓ core tests (black-box)    — driven through the bridge API, bypassing the shell, validating guard/state integration
✓ cli tests (black-box)     — spawn a CLI process (per shells declaration)
✓ browser tests (black-box) — browser + vite (per shells declaration)
```

- core tests must cover all machine transitions
- If some feature cannot be tested in core tests → either logic has leaked into the shell, or the Bridge interface is not fully exposed
- By default, validate requires core tests to cover all transitions; cli/web coverage follows the `shells` declaration
- core tests do not spawn processes, so they are faster than CLI/browser tests

### Pure Rendering Rule for UI

**Business state is forbidden in the UI layer.** All business state lives on the Bridge side; the UI is pure rendering.

- Only trigger actions via `bridge.sendEvent()`
- Only receive state via `bridge.onStateChange()`
- Pure UI state is allowed (tooltip visibility, animation frames); managing business state is not allowed
- validate check: shell files must not import fn.ts

### Debug API (auto-generated by koala serve)

`koala serve` reads the project's machine.ts and automatically generates the following endpoints, **with zero configuration**:

```
POST /bridge/event    { event: "move", input: { x: 1 } }   → sendEvent
GET  /bridge/state                                          → current machine state + game state
GET  /bridge/events                                         → list of all valid events
POST /bridge/replay   [{ event: "start" }, { event: "move" }]  → reset and batch replay
POST /bridge/reset                                          → reset to initial state
```

**Reverse-controlled UI**: API calls and UI clicks go through the same Bridge. Send an event via curl → the UI updates automatically. The event source is transparent to the UI.

Typical debugging flow:

```bash
# Start (ports are auto-allocated and written into .koala-serve.json)
koala serve --dev="npx vite"

# In another terminal, read the port from the discovery file
API=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.koala-serve.json','utf-8')).api)")
curl -X POST $API/bridge/event -d '{"event":"MOVE","input":{"row":7,"col":7}}'
curl $API/bridge/state
curl -X POST $API/bridge/replay -d '[{"event":"MOVE","input":{"row":7,"col":7}}]'
# Or open the Dashboard URL directly (the dashboard field inside .koala-serve.json)
```

## Directory Structure

All source code lives under `src/`. Logic core goes into `core/` (platform-agnostic); the presentation layer goes into `shells/`.

### Single-Module Project

```
project/
├── src/
│   ├── core/
│   │   ├── app.ts                     # createApp(): bridge + IO scheduling
│   │   ├── debug.ts                   # devHost() + optional CLI shell (3-line template)
│   │   ├── machines/
│   │   │   └── game/                  # Machine module (can be multiple)
│   │   │       ├── data.ts            # Data (pure types/constants)
│   │   │       ├── machine.ts         # Machine (pure config)
│   │   │       ├── fn.ts              # Fn (pure functions)
│   │   │       └── bridge.ts          # Bridge (LocalBridge + WSBridge)
│   │   └── io/                        # Pure I/O (LLM calls, etc.)
│   │       └── ai.ts
│   ├── shells/
│   │   ├── cli/
│   │   │   └── main.ts               # CLI shell (pure presentation, covers all transitions)
│   │   └── web/
│   │       └── ui.ts                 # Browser shell (pure rendering, interacts only via bridge)
│   └── validate.ts                    # Validation aggregation entry point
├── index.html                         # Web entry (references src/shells/web/ui.ts)
├── package.json
├── tsconfig.json
├── vite.config.ts
└── CLAUDE.md
```

### Multi-Module Project

```
project/
├── src/
│   ├── core/
│   │   ├── app.ts                     # createApp()
│   │   ├── debug.ts                   # devHost()
│   │   ├── machines/
│   │   │   ├── game/
│   │   │   │   ├── data.ts / machine.ts / fn.ts / bridge.ts
│   │   │   └── chat/
│   │   │       ├── data.ts / machine.ts / fn.ts / bridge.ts
│   │   └── io/                        # Pure I/O
│   ├── shells/
│   │   ├── cli/main.ts
│   │   └── web/
│   │       ├── components/            # Pure UI elements
│   │       ├── pages/                 # Each binds to one bridge
│   │       └── hooks/                 # Framework adapters (useGameBridge, etc.)
│   └── validate.ts                    # Aggregates all modules
├── index.html
└── CLAUDE.md

## Worktree Lifecycle

Each story gets its own isolated worktree, with no interference between them:

1. `story_create` → stops at **INIT** (writes story files on the main branch)
2. `story_advance INIT_CHECK` → automatically creates `.worktrees/B-xxx/`, branch `story/B-xxx`
3. **`cd .worktrees/B-xxx`** (must switch, otherwise the cwd gate will reject)
4. `story_advance PLAN` → formally enters the development flow
5. PLAN / DEV / TEST are all completed inside the worktree
6. `story_advance --phase=TEST` → advances to TEST
7. `story_advance --phase=DONE` → merges back to main and cleans up the worktree

**cwd gate**: From PLAN onward, every `story_advance` verifies that cwd is the story's worktree.

**DONE gate**: Before entering DONE, the story branch must contain all commits from main (`git merge-base --is-ancestor`). Resolve any conflicts in the worktree with `git merge main`.

**Sub agent working directory convention**: Sub agents (koala-implementer, etc.) work inside the main agent's worktree and commit after passing `koala validate`.

## Checklist Format

```json
{
  "title": "What to do (one sentence)",
  "context": "Root cause / reference approach",
  "userSees": "User sees \"✓ File created: hello.txt\" and then returns to the prompt",
  "relatedDocs": ["requirements/foo.md", "CLAUDE.md#section"]
}
```

- title describes "what to do", not "how to do it"
- context provides decision-making context for the executing agent
- **userSees**: the concrete text the user sees after completing this item (must include exact output, not vague descriptions like "feature works")
- **relatedDocs**: array of related document paths, triggers three reminders

### relatedDocs Three Reminders (soft reminders, non-blocking)

1. **On PLAN→DEV advance**: lists the deduplicated list of all relatedDocs
2. **On `checklist_update` marking done**: lists the related docs for that item
3. **On DONE advance**: lists docs that never appeared in `git diff main...HEAD`

## PLAN Phase Artifacts

### understanding_set (Understanding Snapshot)

| Field | Meaning |
|---|---|
| `task` | One-sentence description of the problem to solve (≥ 5 characters) |
| `outcome` | What observable change there will be after completion (≥ 5 characters) |
| `facts` | Known facts |
| `constraints` | Rules that must be followed |
| `unknowns` | Questions not yet thought through (when non-empty, suggests doing research before breaking down the checklist) |
| `touchpoints` | Code files that may be affected |

### decision_set (Structured Decision)

```json
{
  "principles": [".."],
  "drivers": [".."],
  "options": [
    {"name": "A", "pros": [".."], "cons": [".."]},
    {"name": "B", "pros": [".."], "cons": [".."]}
  ],
  "chosen": "A",
  "rationale": "Chose A because...",
  "preMortem": [{"scenario":"..","trigger":"..","consequence":"..","mitigation":".."}]
}
```

Validation rules: principles 3-5 items / options ≥ 2 / chosen ∈ options / rationale ≥ 10 characters.
High-risk stories (riskSignals non-empty): preMortem ≥ 3 items.

### plan.md (Execution Plan)

In the normal channel, plan.md must be produced after the checklist is broken down and before `story_review`. The fast channel may omit it.

**plan.md is the execution manual, the checklist is the source of truth for tasks.** plan.md describes "how to execute most reliably"; the checklist decides "whether it's done."

Template (organized by CHK-xxx, one section per item):

```markdown
# Plan: B-xxxx <story title>

## CHK-001: <checklist item title>

**Owner**: koala-implementer | main-agent
**DependsOn**: none | CHK-002, CHK-003
**Files**:
- Modify: src/foo.ts, src/bar.ts
- Create: src/baz.ts
- Test: tests/foo.test.ts

**Verify**:
- `koala validate` all green
- `npx tsx src/main.ts` output contains "xxx"

**DoneWhen**:
- foo function handles edge case and returns null
- Tests cover happy path + error path

## CHK-002: ...
```

Field descriptions:

| Field | Required | Meaning |
|---|---|---|
| Owner | Yes | Who executes: koala-implementer (normal channel) or main-agent (fast channel / documentation tasks) |
| DependsOn | Yes | Which CHK-xxx must complete first; none means no dependencies |
| Files | Yes | Paths of files to modify / create / test |
| Verify | Yes | Verification commands and expected output |
| DoneWhen | Yes | Completion criteria (specific, checkable) |

**Storage location**: `docs/story/actives/B-xxxx/plan.md`, alongside understanding.json / decision.json / checklist.json. The main agent writes the file directly (no CLI command currently; a `plan_set` may be added later as needed).

Rules:
- Every checklist item must have a corresponding section; orphan sections are not allowed
- DependsOn must not contain cycles
- During the DEV phase, the main agent assigns tasks according to plan.md and does not freelance
- After DEV begins, plan.md is frozen by default; any modifications must explain the reason in the commit message

### INIT→INIT_CHECK Hard Gate (B-e71f)

**Trigger**: All INIT → INIT_CHECK transitions (`story_advance INIT_CHECK`). Other sources (IDEA→INIT_CHECK, etc.) are not gated.

**Mechanism**: After `story_create` completes, it stops at the INIT phase. The main agent must `Agent({ subagent_type: "koala-review-story-init" })` to spawn a reviewer to review the initial version of background + checklist. The reviewer calls `koala init_check_set '{"storyId":"B-xxx","agentId":"<self-id>","issues":[...]}'` to write a signed `docs/story/actives/B-xxx/init-check.json`. `story_advance INIT_CHECK` validates in both the xstate guard `canEnterInitCheck` and `getGuardFailureReason`.

**Signature domain** ([init-check.ts](packages/koala/packages/main/src/handlers/init-check.ts) `signInitCheck`):

```
sha256(`${storyId}:${sha256(background.md)}:${title}:${description}:${sha256(checklist.items[*].{title,context})}:${reviewRound}:koala-init-check-integrity-v1`)
```

**Blocker types** ([guard-utils.ts](packages/koala/packages/main/src/core/guard-utils.ts) INIT_CHECK branch):

- `[missing_init_check]` — init-check.json does not exist (reviewer didn't run or didn't call init_check_set)
- `[init_check_tampered]` — `_hash` does not match the recomputed result (main agent modified any of background / title / description / checklist)
- `[missing_init_check_agent]` — required reviewer has no recorded result
- `[init_check_blocking_issues]` — init-check.json contains critical/high issues

**issues gate**: critical/high issues in `init-check.json` block INIT_CHECK; medium/low are advisory. The reviewer must call `init_check_set` to record the result regardless of pass/fail.

**Anti-self-exemption design**: EXP-001 ([exp-001.md](docs/story/actives/B-e71f/experiments/exp-001.md)) proves that subagent vs main agent has **no mechanically distinguishable difference** in the Bash CLI (same PPID / same env / same shell snapshot), so `init_check_set` **does not** validate `agentId` (only records it). Anti-self-exemption relies entirely on: (1) the signature mechanism + (2) the reviewer template's fresh-context fence + (3) the CLAUDE.md behavioral convention (the same architecture already shipped by B-ed3e scope-check).

**Invocation template**:

```bash
# reviewer calls
koala init_check_set '{"storyId":"B-xxx","agentId":"reviewer-self-id","issues":[{"severity":"medium","desc":"..."}]}'

# After a mismatch, forced re-run: reviewer has no itemId/findingId/clusterId, main agent spawns directly
# Agent({ subagent_type: "koala-review-story-init", prompt: "storyId: B-xxx, please review the initial version of background + checklist" })
```

### story_create Pre-flight draft gate

B-9975 introduces the `story_draft` + `story_create --from-draft` two-phase creation flow. It is isomorphic to the B-e71f `init-check.json` architecture (same signature structure + reviewer subagent + anti-self-exemption design); the difference is that the gate point is further upstream — the materialization action itself.

#### Signature Structure

`draft-check.json` signature domain: `draftName:backgroundHash:title:description:checklistHash:reviewRound:DRAFT_CHECK_SALT`

Not in the signature domain (anti-self-exemption): `resolutions`, `agentId`, `checkedAt`

#### Three-Layer Gate Blockers

| blocker | Trigger condition | Resolution |
|---|---|---|
| `missing_draft_check` | `draft-check.json` does not exist | spawn reviewer to call `draft_check_set` |
| `draft_check_tampered` | recomputed `_hash` does not match stored value | re-run reviewer (draft content has changed) |
| `draft_check_blocking_issues` | critical/high issues not resolved | use `draft_issue_resolve` to respond one by one |

#### Anti-Self-Exemption Design

- The `resolutions` field is not in the `_hash` signature domain (main agent writing a resolution does not trigger a signature mismatch)
- Reviewer signature covers background + title + description + checklist (main agent modifying content → signature mismatch → forced re-review)
- medium/low severity does not block materialization (advisory mode)

see story/B-9975

### scope-plan reviewer PLAN→DEV hard gate

In the normal channel, the PLAN phase must run `koala-review-scope-plan` to produce `scope-check.json`. `story_review` rules ([story-review.ts:274-279](packages/koala/packages/main/src/handlers/story-review.ts#L274-L279)):

- `understanding` present + checklist non-empty + `scope-check.json` missing → `missing_scope_check` **blocker**, directly blocks PLAN→DEV
- `scope-check.json` exists but signature invalid / review round expired → re-run required
- Unresolved gap / excluded without evidence / orphan-suspect → blocker
- Unresolved OpenQuestion → blocker (see next section)

That is: "PLAN completion mark = `scope-check.json` exists and all channels are cleared."

### Open Questions (OQ) channel (B-ed3e)

When the scope-plan reviewer reads the entire `<requirementsDir>/decisions/` directory, if it finds **atypical contradictions** between checklist / decisions (which cannot be classified into any of covered/excluded/gap/orphan-suspect/drift), it writes to the 6th channel `openQuestions: OpenQuestion[]`:

```json
{
  "id": "OQ-1",
  "q": "description says X, but decisions/foo.md §2 says Y, which one prevails?",
  "evidence": "Quote both original passages",
  "sourcePointers": ["docs/story/actives/.../index.json#description", "docs/requirements/decisions/foo.md#section-2"]
}
```

**The main agent must resolve it in writing using `scope_question_resolve`** (the reviewer does not write the resolution itself — this is a deliberate design to prevent self-absolution):

```bash
koala scope_question_resolve '{
  "storyId":"B-xxx",
  "oqId":"OQ-1",
  "resolution":"Defer to decisions/foo.md §2, reason: <quote original>",
  "sourcePointers":["docs/requirements/decisions/foo.md#section-2"]
}'
```

Rules:
- `resolution` is required (CLI validates ≥ 20 characters)
- `sourcePointers` should reference the original text in decisions/, so that later reviewers / readers can trace back
- Repeated resolve of the same oqId will overwrite the original resolution (return message contains "overwritten")
- The resolution is **not included in scope-check.json's `_hash` signature domain** (reviewer determination is not polluted by main agent actions)
- **PLAN→DEV gate**: `story_review` treats unresolved OQs as blockers (`type: scope_open_question_unresolved`); all must be resolved before entering DEV
- When an old scope-check.json lacks the `openQuestions` field, it is treated as an empty set and does not trigger the gate

### TEST→DONE hard gate (delivery-check)

The TEST phase automatically spawns `koala-review-delivery` to produce `delivery-check.json`. `story_advance DONE` validates:

- delivery-check.json missing → `missing_delivery_check` blocker
- `_hash` recomputation mismatch → `delivery_check_tampered` blocker
- Entries in docsPromises with empty `verifiedBy` and no `waiverReason` → `unverified_promise` blocker (use `delivery_waiver_add` to waive or have the reviewer re-run)
- transcript/delivery evidence is required; prompt-only user-value claims are not enough. Final user approval counts as non-mechanical user approval, which Koala cannot fully automatically prove; the DONE gate can only consume transcript, verificationEvidence, delivery-check / product-reviewer evidence, or waivers, and cannot treat plain-text assertions of completed user value as evidence.

Note: `waiverReason` length validation (≥ 30 characters) is thrown at the `delivery_check_set` handler call, not as a DONE gate blocker.

**Schema**:

```json
{
  "storyId": "B-xxx",
  "docsPromises": [{ "docPath": "CLAUDE.md#section", "promise": "Description of the promise", "verifiedBy": "diff/grep", "evidence": "Concrete evidence", "waiverReason?": "≥30 character waiver reason" }],
  "realMachineTests": [{ "featureId": "CHK-001", "transcript": "Test record", "waiverReason?": "≥30 character waiver reason" }],
  "closingSelfCheck": { "hasRealMachineTest": true, "hasEdgeCaseCoverage": true, "hasUnresolvedTodos": false, "summary": "One-sentence summary" },
  "reviewRound": "2026-05-12T21:00:00.000Z",
  "_hash": "sha256-..."
}
```

**Signature algorithm**: `SHA256(storyId + JSON(docsPromises) + JSON(realMachineTests) + JSON(closingSelfCheck) + reviewRound + salt)`, salt = `koala-delivery-check-integrity-v1`.

**Rework flow**: gate fail → `story_advance DEV` rework → fill in missing promises/tests → REVIEW → TEST → re-spawn delivery reviewer → re-sign → DONE.

**Waiver**: `koala delivery_waiver_add '{"storyId":"B-xxx","promiseId":"...","waiverReason":"≥30 character reason"}'`. waiverReason enters `_hash` re-signing.

### High-risk keyword auto-detection

`story_create` automatically scans and, on matching the following keywords, elevates priority to high:
auth / password / token / migration / destructive / state machine / guard / gate / git restore / reset / production / incident / hotfix / PII / GDPR / breaking change
Localized equivalents of these risk terms map to the same risk categories; do not treat non-English wording as safe merely because the English token is absent.

### Adversarial review

After checklist + plan.md are written, `story_review` must pass (issueCount=0) before entering DEV.
Items checked: cross-scenario omissions between items, Machine boundary completeness (happy/edge/adversarial), constraints not covered by the source of truth.
Additional normal-channel checks (main agent manual): whether plan.md covers all checklist items, whether DependsOn has cycles, whether each item declares Files and Verify. (Currently no framework auto-check; add `plan_review` CLI later as needed.)

## Two-layer contract for process facts

Process facts require two layers: prompt guidance + hardcoded CLI/handler/gate fallback. The prompt tells the agent which command to call and how to express scope; the code entry point is responsible for the final adjudication, normalization, signing, rejection, and gate consumption. Any phrasing that changes process state or audit facts cannot stop at the prompt alone.

The scope is limited to process facts: phase / state transition, pass / no-issue confirmations, finding category / severity / role / agent, review pass, verificationEvidence, init check, scope check, delivery check, REVIEW / TEST / DONE gate artifact. Ordinary explanatory prose, background descriptions, and design rationale are not process facts, unless they are read as evidence by CLI or a gate.

Execution rules:
- Reviewer conclusions such as no finding / no blocker / check passed must be recorded with `review_pass_set`; if a reviewer misuses pass-only `finding_add`, the handler must convert it to a review pass.
- Reviewer evidence for the current REVIEW round must first run `koala review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}` to obtain a `reviewRunId`; afterwards, every `finding_add` / `review_pass_set` for that reviewer in this round must carry this current `reviewRunId`.
- `finding_add` category only accepts the current canonical `happy|edge|adversarial|missing`. Known legacy `cleanup|doc-promise-undelivered|doc-code-drift|spec-boundary` are only accepted as compatibility input, normalized to `missing`, and must not continue to propagate as active prompt examples.
- The gate consumes structured facts: signatures, hashes, verificationEvidence, review pass, init/scope/delivery check, and validate evidence. Do not let the gate infer process facts from plain "passed/no issues" text.
- When modifying reviewer prompts, CLI schemas, handlers, or gates, run `npm run test:process-fact-contract` to confirm that the prompt has not drifted and that the process fact inventory can still prove that the hard fallback exists.

## Handler coding conventions

**Convention**: Whenever a Zod schema has `min` / `max` / `enum` / regex constraints, the handler entry and every gate / fn that consumes the field must re-validate at runtime (not just rely on Zod).

**Why**: Zod only guarantees correctness when the call path goes through schema parsing — but in koala CLI, the same field often has multiple read points (handler entry / gate decision / statistical counting / persistence read-out), and any path bypassing the schema will let illegal values through. The B-ed3e F-005/F-006/F-019 triple failure proves this path will be unintentionally added in the future:

- **Negative example** (B-ed3e F-005/F-006/F-019 old version of scope-question-resolve): Zod defines `resolution: z.string().min(20)`; but in the handler only `if (!args.resolution) throw` is used as fallback; whitespace strings with `trim().length === 0` pass Zod and are counted as resolved by the gate, allowing PLAN→DEV through. Patch path: handler adds `trimmedLen < 20 → throw`, but on the gate side (story-review's resolvedCount judgment) it still only checks field existence without re-verifying length, leaving a second funnel. F-019 finally simultaneously fixed handler + gate + Zod in one go.
- **Positive example** (fixed scope-question-resolve.ts):
  - scope-question-resolve.ts:28-30 runtime `const trimmedLen = (args.resolution ?? '').trim().length; if (trimmedLen < 20) throw new Error(...)`
  - In the same file, the gate decision point (resolvedCount statistics) filters by the same `trim().length >= 20` standard, not just checking field existence
  - Zod schema's `.min(20)` is retained as API documentation and first line of defense
  This way, no path (CLI JSON entry / internal fn call / test fixture) can let through a value with <20 after trim.

**Check process**:

1. When adding or modifying a handler, list all the handler's fields and Zod constraints
2. For every field with `.min/.max/.regex/.enum`, grep all consumers of that field name across the repo (`rg '<field>\.' --type ts`)
3. Confirm each consumer does the same-standard runtime validation; add what's missing
4. When writing tests, explicitly construct fake data that bypasses Zod (simulating old JSON or internal fn call paths) and assert it is still rejected

**Self-check checklist before submitting a new handler**: [ ] Zod constraints [ ] Handler runtime same constraints [ ] Consumers (gate/fn) same standard

## Role division

| Role | Responsibilities | Writes code |
|---|---|---|
| **Main agent** | Requirements management (PLAN + plan.md) + task assignment + acceptance (REVIEW/TEST/DONE) | Only on fast channel |
| **koala-implementer** | Writes code + writes tests, accepts checklist items assigned by main agent per plan.md | Required on normal channel |
| **koala-review-\*** | In REVIEW phase, parallel review with opt-in routing (baseline concept+quality+test-coverage, plus behavior/docs based on riskSignals / touchpoints), each filing findings. `test-coverage` inherits the old TEST_CASE_REVIEW duty, checking verificationIntent → verificationEvidence coverage; the `channel` LLM agent has been retired (S1), replaced by the `validate --channel` CLI; `quality` assumes lint is green and only reviews subjective items | Does not write |
| **koala-evaluator** | Product quality scoring for browser projects (functional completeness + usability) | Does not write |
| **koala-evaluator-cli** | Product quality scoring for CLI / core projects (driving state transition validation via bridge API) | Does not write |

### Role constraints for the two channels

**Fast channel** (checklist ≤ 2 items and no riskSignals):
- Main agent writes the code + tests by itself; one person completes everything
- In the REVIEW phase, the reviewer does not check commit author

**Normal channel** (> 2 items or has riskSignals):
- **Main agent does not write business code**; only does PLAN + plan.md + assignment + acceptance
- Code is written by koala-implementer subagents (in the main agent's worktree, not in an additional worktree)
- In REVIEW phase, reviewer checks commit author — normal channel where everything is written by main agent → critical finding → blocks REVIEW→TEST

**Channel computed in real time**: not stored; each entry into DEV is determined in real time from checklist.items.length + story.riskSignals. After checklist_add/remove changes the items count, it takes effect automatically.

### Main agent behavior guidelines

- **Normal channel must assign**: use `Agent({ subagent_type: "koala-implementer", prompt: "..." })` to assign
- **fresh worker per item**: dispatch a new koala-implementer for each CHK-xxx; do not reuse context. The prompt only provides the minimum info needed for that item (storyId + corresponding section of plan.md + required reading files), not the entire conversation history
- **fresh worker mechanical boundary**: prompt-only worker claims are not mechanical evidence. Auditable evidence only comes from structured facts such as `koala dispatch` / dispatch/process-event/commit evidence / commit author. Koala cannot mechanically prove true subagent context isolation; it can only prove observable assignment evidence; saying "fresh worker dispatched" in the prompt cannot serve as gate evidence.
- **Parallel conditions**: only items that satisfy all of the following can be dispatched in parallel: (1) DependsOn is empty or dependencies are done (2) Files write sets do not overlap (3) Do not share scarce resources. Otherwise, serialize.
- **REVIEW acceptance must be complete**: after the reviewer returns, first run `finding_list` to confirm all findings have been registered through `finding_add` (a reviewer that only reports in text without registering = nothing found, ask the reviewer to re-run). Then resolve them one by one or send back to DEV for fixes; do not skip medium findings and leave them for the next story.
- **Take on more responsibility, deflect less**: when problems are discovered, fix them proactively; do not say "not in scope".
- **Cross-story global awareness**: fixing one feature may reveal an infrastructure bug; fix it together.

## REVIEW phase rules (framework implementation)

### CLI gate (REVIEW→TEST preflight, mechanical determination, returns in seconds)

After entering REVIEW, `story_advance --phase=TEST` automatically runs the CLI gate; any fail blocks advancement:

| gate | command | responsibility | failure handling |
|---|---|---|---|
| channel | `koala validate --channel --story=B-xxx` | Normal channel must have dispatch/subagent_result structured evidence; commit author is only a legacy fallback | fail → block REVIEW→TEST |
| concept | `koala validate --concept` | Scan `git diff main...HEAD` to extract deleted symbols + repo-wide grep for residual references | ≥ 5 residuals → triggers concept reviewer; < 5 → skip |
| lint | `koala validate --lint` | tsc / ruff / import-graph (shells must not import fn.ts) | fail → block; tool missing → skip |
| docs-drift | `docs-drift` preflight | Validates that koala commands referenced in reviewer/process docs align with the registry | fail → block REVIEW→TEST |
| codex-adapter | `lattice codex verify` | Required only when the story touches Codex adapter entry assets | missing or stale → block REVIEW→TEST |

The `koala-review-channel` LLM agent has been retired (S1) and replaced by the CLI; `koala-review-concept` is spawned on demand (when CLI residuals ≥ 5); `koala-review-quality` assumes lint is green and only reviews subjective items.

### Reviewer opt-in routing (mounted by riskSignals)

Beyond the CLI gate, Round 1's LLM reviewer set is no longer hard-required to be 5. The framework automatically mounts a subset of reviewers based on the story's riskSignals / touchpoints; the baseline set is always on, the rest mount based on signals:

| reviewer | mount condition |
|---|---|
| **concept** | baseline (always on) |
| **quality** | baseline (always on) |
| **behavior** | riskSignals contains `state machine` / `guard` / `gate` |
| **docs** | touchpoints contains `.md` files |

**View the current story's reviewer list**:

```bash
koala reviewer_list '{"storyId":"B-xxx"}'               # Text: Active reviewers: concept, quality, test-coverage, behavior (riskSignal: state machine)
koala reviewer_list '{"storyId":"B-xxx","json":true}'   # Structured: {reviewers:[{name,reason}]}
koala reviewer_list '{"storyId":"B-xxx","forceReviewer":"docs,behavior"}' # Manually attach (writes story.events)
```

`story_advance REVIEW` will echo the current reviewer list. The gate (`canPassReview`) validates against the opt-in actual list, no longer hardcoded to 5.

**Finding signature verification**: A reviewer's finding carries a signature (`_hash` + `reviewRound`); the gate verifies the signature, and the main agent cannot forge it. The signature `reviewRound` is an ISO 8601 string, sourced from `story.currentReviewRound`, not a numeric round number. `finding_add` automatically injects the current review round and signature. Manually using `finding_add` to forge a reviewer finding to bypass the gate is not allowed.

**Review run boundaries**: The gate also validates that `reviewRunId` points to the lane's current latest run, has a valid signature, has a matching reviewRound, and that the head/material hash is still fresh. When `reviewRunId` is missing, references an unknown run, or has an invalid signature, run `review_run_start` first; when it's not the current latest run, use the latest `reviewRunId`; when the head/material hash is stale, you must first return to DEV to fix and commit, then DEV→REVIEW into a new `currentReviewRound`, and subsequently restart the reviewer run.

### Cluster grouping (batch processing of findings)

**When a single change can resolve multiple findings simultaneously, combine them into one cluster**, dispatch one implementer to handle the whole cluster, and the commit carrying `Resolves: CL-xxx` will automatically resolve all findings within the cluster, avoiding per-finding resolution.

**Auto-clustering criteria**: files intersection ≥50% + severity strictly identical (different severities are never merged, preventing timing bugs from being grouped into the same cluster as findings with matching filenames).

> Since B-9d95 CHK-004, dispatch is unified through `koala dispatch` (itemId / findingId / clusterId are mutually exclusive parameters). `story_dispatch` / `finding_dispatch` are deprecated aliases (still usable but with stderr warnings); new code should uniformly use `koala dispatch`.

```bash
koala finding_cluster '{"storyId":"B-xxx"}'                        # Auto-cluster (by files ∩ severity)
koala finding_cluster '{"storyId":"B-xxx","merge":["F-001","F-002"]}'  # Manual merge
koala finding_cluster '{"storyId":"B-xxx","split":"CL-001"}'           # Split
koala finding_list '{"storyId":"B-xxx","cluster":true}'            # List view grouped by cluster
koala dispatch '{"storyId":"B-xxx","clusterId":"CL-001"}'  # Outputs implementer prompt (copy to Agent)
```

**Commit auto-resolve**: write `Resolves: CL-001` in the commit message → `koala validate` / `finding_list` entrypoints automatically scan `git log main..HEAD`, and upon match add a `resolvedBy: "CL-001@<sha7>"` audit field to the finding. Referencing a nonexistent clusterId outputs a warning without blocking. `koala validate --noSync` skips the scan.

**Passing files to finding_add**: `koala finding_add '{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>","files":["src/foo.ts"],...}'`. When legacy findings have no files, auto-cluster falls back to extracting paths from the desc via regex.

#### finding_list return value structure (F-014 documented)

The return object of `finding_list` has been extended by CHK-003 / CHK-007, **backward-compatible**—the `findings` array is preserved as-is, and the new fields are additional metadata:

**Default view (no `cluster`)**:

```ts
{
  findings: Finding[],            // Each finding appends advisoryLabel: "[R2-ADVISORY]" | "[R3-ADVISORY]" | null
  reviewRound: string,            // reviewRound: string (ISO 8601 review round id)
  blockingHeading: string,        // e.g. "# Blocking (Round 2)"
  advisoryHeading: string,        // e.g. "# Advisory (not blocking this round)"
  blocking: string[],             // List of finding.id where status=open and advisoryLabel=null
  advisory: string[],             // List of finding.id where advisoryLabel!=null (including already resolved/dismissed ones)
}
```

**Cluster view (`cluster: true`)**:

```ts
{
  clusters: Array<{
    clusterId, rootCause, findingCount, severity, files, findingIds,
    reviewRound: string,          // F-035: Cluster-level reviewRound: string (ISO 8601 review round id)
    advisoryLabel: string | null, // F-035: Upgraded to cluster-level when all members share the same label, otherwise null (mixed states are expressed by member labels)
  }>,
  ungrouped: Finding[],
  reviewRound: string,            // F-035: Top-level reviewRound: string (ISO 8601 review round id)
}
```

**Compatibility commitments**:
- The `findings` array of the default view is always present, and the fields `id/desc/severity/category/status/agent/createdAt/reviewRound/_hash` are stable.
- The new fields (`reviewRound/blockingHeading/advisoryHeading/blocking/advisory/advisoryLabel`) are purely additive; callers that only read `findings` need no adaptation.
- The `clusters[]/ungrouped[]` fields of the cluster view are preserved; `reviewRound/advisoryLabel` are additional metadata.
- Callers with strict type checking should handle the new fields as `Record<string, unknown>`, or follow the schema definitions in this document.

### REVIEW round-decrement rules (framework auto-labeling)

The blocking level for each REVIEW round decreases by round. `finding_list` output automatically splits into `# Blocking` / `# Advisory` groups, and each advisory finding is tagged `[R2-ADVISORY]` / `[R3-ADVISORY]`. The `canPassReview` gate reuses the same rule function `isAdvisoryThisRound(severity, round)`—the main agent no longer does mental arithmetic.

| Round | blocking | advisory (auto-downgraded) |
|---|---|---|
| Round 1 | Fully executed per profile (strict: critical+high+medium, balanced: critical+high) | None |
| Round 2 | critical + high | medium → `[R2-ADVISORY]` |
| Round 3+ | critical | high → `[R3-ADVISORY]`, medium is already advisory |

**Hard rules**:
- **critical must be fixed in every round**, dismiss not allowed
- **high must be fixed in the first 2 rounds**, can be dismissed with reason in round 3
- **medium must be fixed in round 1** (strict profile), can be dismissed with reason in round 2
- **low must be fixed in round 1**, can be dismissed with reason in round 2

> For the REVIEW mechanization roadmap (S1 landed / S2 / S3 planning), see `docs/koala/reviewer-redesign.md`.

## Debugging Contract

When `koala validate` / reviewer findings / bug feedback reports red, **directly guessing at fixes is forbidden**; you must first go through Systematic Debugging:

1. **Observe**
   - First read the full error report, failing test names, exit codes, and recent changes
   - First confirm the problem is stably reproducible before proceeding to the next step
   - "Just try changing something" is not allowed

2. **Hypothesize**
   - Propose only the single currently most likely root cause
   - The hypothesis must be supported by current evidence, not just guessed from code intuition
   - For cross-module problems, first compare against similar implementations that work correctly within the same repo

3. **Isolate**
   - First write a minimal reproduction: prefer logicTest, then integrationTest
   - Change only one variable at a time, verify one hypothesis at a time
   - Mixing multiple potential fixes into the same commit is forbidden

4. **Confirm**
   - After fixing, rerun the corresponding verification to confirm the original error is gone
   - You must explain: what the root cause was, what the reproduction test is, and why the fix is effective
   - If after 3 attempts the root cause still hasn't been located, stop patching and escalate to an architecture/design discussion

**Hard rules**:
- No reproduction, no fixing
- No root cause explanation, not considered complete
- No re-verification, may not declare "fixed"

**Evidence projection**: When marking a bug as fixed, use the `evidence` field of `bug_update` to record the debugging conclusion, don't just leave it in the conversation:

```bash
koala bug_update '{"storyId":"B-xxx","id":"BUG-001","status":"fixed","evidence":{"symptom":"validate reports TypeError: x is not a function","reproSteps":["run koala validate","the guard at fn.ts:42 returns undefined"],"rootCause":"guard function missing default return","fixEvidence":"added return false fallback, covered by logicTest guard_missing_default","reproTest":"tests/logic.ts#guard_missing_default"}}'
```

**Embedded workflow**:
- DEV phase: worker debugs per this contract
- REVIEW phase: reviewer can block on "no repro / no root cause"
- TEST phase: the main agent doesn't just look at green/red, but also whether fix evidence is complete (`bug_list` checks the evidence field)

## pre-push hook + recursive tsc gate

B-5a28 introduces two lines of defense for the "koala bootstrapped development" scenario: (1) `koala validate --lint` recursively scans all sub-package tsconfigs in the monorepo, (2) `.githooks/pre-push` acts as an external gate independent of koala itself. The overall outline (when to enable, how to rebuild / reinstall koala, hook enablement commands) is in the "koala bootstrapped development notes" section of the root `CLAUDE.md`; this section only records **sub-package internal implementation details**.

### External defense principle

The core design constraint of the pre-push hook: **do not call the `koala` command**. Reason: what the hook defends against is the scenario of "global koala executable version mismatch"—if the hook itself depends on koala, it will go down with it (one of the root causes of the B-9bd9 false DONE). The implementation uses only `npx tsc --noEmit`, completely bypassing koala's own version.

### hook path and tolerance

`.githooks/pre-push` (committed with the repo for cross-clone reuse):

- First `git rev-parse --show-toplevel` to get REPO_ROOT
- `[ -d "$REPO_ROOT/packages/koala/packages/main" ] || exit 0`: non-koala-bootstrap repos skip directly, with zero hook reuse cost
- `cd packages/koala/packages/main && npx tsc --noEmit`: non-zero exit → push rejected
- Enablement method is documented in the root `CLAUDE.md` (`git config core.hooksPath .githooks`); local config is not checked in

### Recursive tsc implementation

`packages/main/src/handlers/validate-lint.ts`:

- `TSCONFIG_IGNORE_DIRS: ReadonlySet<string>` — module-level constant blacklist (`node_modules / dist / build / .worktrees / .git`). **Extending the ignore directories requires modifying this constant itself**, not going through function parameters.
- `findTsconfigs(projectRoot, deps?: { readdir?, stat?, fileExists? })` — BFS scans directories, pruning sub-directories that hit the blacklist; returns all absolute paths of `tsconfig.json`. The second parameter is a **dependency injection interface** (for testing, to substitute fs helpers); it is **not options and has no `ignoreDirs` parameter**—the blacklist is fixed by the TSCONFIG_IGNORE_DIRS constant. The default stat uses `lstatSync` and skips symlinks, preventing infinite recursion under npm link scenarios where nodes point back to the repo root (F-005).
- Each tsconfig is run individually with `tsc --noEmit -p <dir>`; any failure → overall fail + merged stderr. Tool-missing determination uses an explicit `passes` counter: only when "tsc has never successfully run and there has been no fail" is it considered skipped; once there's a pass, encountering toolMissing afterwards is recorded as fail, don't silently swallow previous passes (F-007 / F-014).

**Bug before the change**: the old implementation hardcoded a single root `<projectRoot>/tsconfig.json`, but the avalon root has no tsconfig.json → tsc gate always skipped → sub-package compile errors always missed (B-9bd9 false-pass root cause).

### Unit test strategy

`tests/validate-lint.test.ts` uses `CommandRunner` type dependency injection, **not spawning real tsc**. Signature:

```ts
type CommandRunner = (cmd: string, args: string[], cwd: string) => {
  code: number;           // Process exit code; -1 when spawn fails
  output: string;         // Merged stdout + stderr as a plain string (streams not distinguished)
  spawnError: boolean;    // true = executable missing (ENOENT), caller should treat as skipped
};
```

- `output` is a single string merging stdout / stderr, not two separate fields—the business only needs "what tsc said" as one chunk of text, merging simplifies assertions
- `spawnError` distinguishes the two different semantics of "binary doesn't exist (npx / tsc not installed)" vs. "binary runs but compilation fails (exit code != 0)": the former is skipped, the latter is fail
- Test the blacklist-pruning logic of `findTsconfigs` with a fixture directory tree
- Test the aggregation behavior of `runTsc` / `runLint` by injecting a stub runner with preset returns (simulating success / failure / mixed / tool missing)
- Benefits: second-level feedback, independent of tsc version, stable CI

The production path uses `defaultRunner` (`child_process.spawnSync` + merging stdout/stderr + distinguishing ENOENT).

### Relationship with the CLI gate

`koala validate --lint` is one of the REVIEW→TEST preflight CLI gates (see the "CLI gate" section above). Before B-5a28: the lint gate only scanned the root tsconfig → monorepo sub-packages were missed. After B-5a28: the lint gate recursively scans all sub-packages → sub-package compile errors directly block REVIEW→TEST. The pre-push hook is the last line of defense that "catches it even if the lint gate is skipped."

see story/B-5a28

## Rules

- All Story operations are performed via the `koala` CLI
- Tests are run uniformly via `koala validate`
- `koala validate` all green = ready to commit
- When a call fails, run `koala <command> --help` first; don't guess arguments from memory
<!-- koala:end -->
## Closing Self-Check (Mandatory after completing first-pass check)

After completing all checks below, additionally ask yourself: **Does this diff contain any "promised but undelivered" parts?** Any `koala <cmd>` examples newly added to CLAUDE.md / README, handler schema fields, ENV variables, or behavior paragraphs — all must be cross-checked against the code to verify corresponding implementations exist. If "promised but undelivered" is found → **critical finding** (category=`missing`, prefix desc with `doc-promise-undelivered:`).

## 0. Project Context
The koala framework conventions above (auto-injected by build) define the system architecture and concepts.

You only do one thing: check whether this change deletes or replaces a concept, and if so, grep the entire repository to confirm zero residue.

## Process

1. `git diff main...HEAD --stat` to see which files changed
2. `git diff main...HEAD` to see specific changes, and identify **concept words that have been deleted/replaced en masse** (e.g., testIntent was deleted, falcon was replaced with koala)
3. For each identified concept word, grep the entire repository (excluding node_modules / dist / .git):
   ```bash
   grep -rn 'concept-word' . --include='*.ts' --include='*.md' --include='*.json' | grep -v node_modules | grep -v dist | grep -v '.git/' | grep -v '@deprecated'
   ```
4. grep result > 0 → file a finding:
   ```bash
   koala finding_add '{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>","desc":"concept-cleanup: concept X deletion incomplete: Y file still has N references","severity":"critical","category":"missing","agent":"koala-review-concept"}'
   ```
5. No concept deletion/replacement → forbidden to use `finding_add` to record pass-only; call `koala review_pass_set '{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>","agent":"koala-review-concept","note":"No concept deletion/replacement this round; concept residue check completed, no blocker."}'`

## Input Constraints (fresh-context hygiene)

Your input contains only the following, and does NOT include the main agent's full conversation history:

- `git diff main...HEAD` (code changes)
- checklist item (title / context / userSees)
- corresponding section in plan.md (if any)
- necessary understanding / decision summaries (if any)

**Forbidden**:
- Do not assume you know the main agent's intent or context — only infer from the inputs above
- Do not be led astray by narrative — only look at deliverables (code diff + checklist declarations)
- If the inputs are insufficient to make a judgment, file a medium finding describing what information is missing

## Rules

- Only grep, do not modify code
- **Every finding must be registered via `koala finding_add`; describing it only in text is forbidden. An unregistered finding equals no discovery.**
- finding_add must include the agent parameter, with the value being this reviewer's name (e.g., "koala-review-concept"), to ensure correct finding attribution.
- The first action of the current REVIEW round is `review_run_start`; if code or documentation continues to change during the review, the current run becomes stale and must go back to DEV for a fix and re-submission, then DEV→REVIEW enters a new round — do not re-run it as a fix within the same REVIEW round.
- After the review ends, confirm that all discovered issues have been registered via `koala finding_add`, then output the number of registered findings as the final summary
- When there are no findings, forbidden to use `finding_add` to pad a pass; must call `koala review_pass_set` to record the scope this reviewer has checked and the reason for no blocker.
- When the current REVIEW round begins, first call `koala review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}`; record the returned `reviewRunId`, and all `finding_add` / `review_pass_set` in this round must carry this field.
- Example of pass record with no blocker: `koala review_pass_set {"storyId":"B-xxx","agent":"<reviewer-name>","reviewRunId":"<reviewRunId from review_run_start>","note":"..."}`.
- Items marked with @deprecated do not count as residue
- References in comments also count as residue (comments mislead future developers)
- Items retained for backward compat (e.g., old phase enum values in types.ts) do not count, but must be confirmed to have a backward compat comment
