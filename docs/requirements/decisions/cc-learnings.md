# Proof-or-Stop's Refactor Plan for Learning from Claude Code

> 2026.04 · Summarized after a full audit of proof-or-stop's current state

## Background

proof-or-stop has already gotten most of the grounding mechanisms right: phase gate / DONE Final Checklist / signed review / physical-fact verification / watchdog / activity.jsonl / silent test rejection, etc. After auditing the CC source, it is confirmed that proof-or-stop is still missing **a few mechanisms that CC has validated and that have real value for proof-or-stop's actual scenarios**.

This document is organized into a form that can be split into stories; each story is independently complete, containing description / checklist / test directions / acceptance.

## Core Insight

Looking back at all the proof-or-stop pain points the user listed (the worktree was not created, reporting completion when only half done, losing context across sessions, the written story not matching the done story, a feature not running without noticing), **none of them is proof-or-stop missing a feature**; rather:

1. **the agent does not know when to use which proof-or-stop command** → the tool descriptions are too thin
2. **after a proof-or-stop command succeeds it does not tell the agent the next step** → only story_advance has a nextStepHint
3. **the agent loses context after leaving the session** → there is no brief entry point
4. **silent catch lets failures get swallowed** → fail-fast is not thorough

Fixing the 5 stories corresponding to these 4 categories of problems is expected to reduce proof-or-stop pain points by 70-80%.

## The Parts Not Learned

The following mechanisms of CC are **not suitable** for proof-or-stop, and this document explicitly does not introduce them:

| CC mechanism | Why proof-or-stop does not need it |
|---|---|
| `shouldDefer` / lazy tool loading | proof-or-stop is a CLI tool; the tool descriptions do not enter the LLM context, so there is no token cost |
| `<system-reminder>` attachment injection | proof-or-stop has no LLM conversation stream, not applicable (the reminder goes through stderr) |
| `autoCompact` / layered compaction | proof-or-stop has no context-window concept |
| `cache-safe params` for forked agents | proof-or-stop commands are independent processes, there is no "parent cache" |
| `tokenCountWithEstimation` | proof-or-stop does not call the LLM |
| `yoloClassifier` Haiku auto-verdict | proof-or-stop is a pure CLI with no LLM; let the upper-layer observer do the LLM judgment |
| `feature flags` + Growthbook | proof-or-stop has a small user base; the stability field is enough |
| `BQ telemetry` | proof-or-stop already has activity.jsonl |
| `prompt cache break detection` | no prompt cache |
| `1M context beta` | no context |
| `subagent` nesting | proof-or-stop commands are independent processes, no nesting |

---

## Story Overview

Ordered by ROI:

| Order | Story | Effort | Impact | Priority |
|---|---|---|---|---|
| 1 | Full coverage of the nextStepHint returned by commands | 2 days | the agent automatically finds the next command | P0 |
| 2 | silent catch fix (fail-fast classified handling) | 1 day | fix the most hidden class of bugs | P0 |
| 3 | session_brief command | 1 day | context is not lost across sessions | P0 |
| 4 | PROMPT-ify 4 core commands (CC TodoWrite style) | 3 days | the single largest point of leverage | P0 |
| 5 | stale state detection | 2 days | prevent a stuck phase | P1 |
| 6 | Hook system | 3 days | the foundation for connecting the observer | P1 |
| 7 | command metadata + dry-run | 2 days | prevent mis-operations | P2 |
| 8 | progress streaming completion | 1 day | visibility of long commands | P2 |
| 9 | schemaVersion + empty migration | 0.5 day | hedge against future debt | P3 |
| 10 | search command + call-stack recursion guard | 2 days | discoverability | P3 |

**P0 + P1 are 12 days of effort in total**; finishing them is the ceiling of proof-or-stop's single-point improvement. P2/P3 are the icing on the cake.

---

## Story 1: Full coverage of the nextStepHint returned by commands [P0]

### Description

CC's TodoWrite reinforces "Continue to use the todo list..." on every return; this is the key to the model continuing to use it after one use. proof-or-stop currently only has `story_advance` adding a nextStepHint to its return ([story-advance.ts:432-439](packages/main/src/handlers/story-advance.ts#L432-L439)); the other state-mutating commands (checklist_update, fixture_batch_add, bug_report, testintent_record, story_create) do not.

When the agent sees a successful proof-or-stop return, if it is not told "do X next", it will **guess on its own**. When it guesses right the command chain flows smoothly; when it guesses wrong it skips the flow.

Fix goal: the success path of every state-mutating command returns a next step hint, and the hint includes a **conditional judgment** ("if X is already done then Y, otherwise Z"), which is equivalent to doing one state inference for the agent at each command's exit.

### Checklist

1. **title**: Add a unified injector decorateResult in cli-engine.ts
   **context**: Add `function decorateResult(cmdName: string, result: unknown, ctx: HintContext): unknown`, called by the run() function before printing the result. HintContext contains store / config / loadConfig / activeStory, so the hint functions can query the current state.

2. **title**: Register the hint for checklist_update
   **context**: Check status:
   - in_progress → suggest "start writing code, and checklist_update status=done again when done"
   - done and not all done → suggest "continue to the next item"
   - done and all done → suggest "all items complete. Next step: story_advance phase=TEST_CASE"
   - testIntent updated → suggest "testIntent recorded, continue refining the other items"

3. **title**: Register the hint for fixture_batch_add
   **context**: Check the added count + the current story phase. For example, N cases added in the TEST_CASE phase → "Added N cases. Keep adding / or story_advance phase=TEST_CASE_REVIEW to enter review"

4. **title**: Register the hint for story_create
   **context**: Check whether the story contains a checklist:
   - has a checklist → "Story created at IDEA. Next step: story_advance phase=INIT_CHECK to create the worktree"
   - no checklist → "Story created at IDEA. You need to discuss the checklist first, then use story_advance phase=PLAN"
   - a story with the same keyword already exists → warn and list possibly-duplicate story ids

5. **title**: Register the hint for bug_report
   **context**: After a single bug is created → "Bug recorded. After fixing, git commit + test_story will auto-mark it fixed"

6. **title**: Register the hint for testintent_record
   **context**: Check lastJudgment:
   - the user records pass=true for the first time → suggest whether all items have been reviewed
   - all reviewers pass → suggest story_advance phase=TEST
   - any fail → suggest story_advance phase=DEV to roll back and fix

7. **title**: Register the hints for dev_start / dev_finish / story_discard
   **context**: The next-step hints for the worktree-operation class of commands

8. **title**: Consolidate all hint functions into the single file src/handlers/hints.ts
   **context**: Rather than scattered across the various handlers. This way cli-engine.ts only imports one registry, and adding a hint is just one line in this file

9. **title**: Add unit fixtures for the hint functions
   **context**: Construct a mock store + mock state and verify that the hint text returned by each case path matches expectations

10. **title**: Add a hint?: HintFn field to ToolDef (optional)
    **context**: Let cli-engine.ts find the corresponding hint function via ToolDef. When MAIN_TOOLS is registered, wire up the hint function if it is already defined. If ToolDef does not expose this field, maintain a separate cmdName → HintFn map in cli-engine

### Test directions

- happy: every command returns a non-empty hint field on success
- edge: the hint switching for command boundary cases (e.g. checklist all done, bugs all fixed)
- adversarial: for error cases (e.g. no corresponding story in the store), the hint does not throw and degrades to returning null

### Acceptance

- grep `nextSteps` / `hint` in the cli-engine.ts output; at least 8 commands have a non-null return
- Write a fixture: construct a story with an in_progress checklist, call checklist_update status=done to mark the last item complete, and assert the return contains the string "story_advance phase=TEST_CASE"

### Touchpoints

- Create: `packages/main/src/handlers/hints.ts`
- Modify: `packages/main/src/cli-engine.ts:575-594` (the run function adds the decorateResult call)
- Modify: `packages/main/src/handlers/checklist.ts`, `fixture.ts`, `bug.ts`, `story-create.ts`, etc. (if the hint functions need to be registered into hints.ts)

---

## Story 2: silent catch fix (fail-fast classified handling) [P0]

### Description

The proof-or-stop code has dozens of `try { ... } catch { /* ignore */ }`. CC has a clear principle: "**security-related errors must sound**". proof-or-stop's silent catch is dangerous in several places:

- `writeLog` fails → the audit is incomplete and cannot be traced back afterwards
- `_persistPending` fails → cross-process recovery becomes ineffective
- worktree creation fails but is swallowed → the classic scenario the user described of "the worktree was not created but I thought it was"
- markLost fails and is swallowed → restart-recovery data is inconsistent

These silent catches **cannot all be deleted** (some are reasonable ignores of the probing class), but **must be handled by category**: when silent is ok, when it must throw, when it must degrade to a log.

### Checklist

1. **title**: grep all silent catches and list them
   **context**: `grep -rn "catch.*{.*ignore\|catch.*{$" packages/main/src --include="*.ts"`, output the results into a markdown file, marking each one's current location + context.

2. **title**: Classify into 4 category labels
   **context**:
   - **DEBUG** (log/progress class): keep silent
   - **PROBE** (probing class such as readReview / detectActiveStory file not existing): keep silent but return null/empty
   - **PERSIST** (writeLog / persistPending / save): change to stderr output + write a health flag
   - **MUTATION** (git / fs.write / spawn failure): change to throw or return a structured error

3. **title**: Create a health.ts module that provides the reportHealthIssue function
   **context**: `export function reportHealthIssue(category: string, error: Error, context: Record<string, unknown>): void`. Append the issue to `~/.proof-or-stop/health.jsonl`, each containing timestamp / category / error.message / context. The failure itself also does not throw (to prevent the health module itself from crashing and dragging down the main flow).

4. **title**: Change the PERSIST class silent catches to reportHealthIssue
   **context**: For example, all the markLost silent catches in [worktree.ts](packages/main/src/handlers/worktree.ts), the writeLog silent catch in cli-engine.ts, and the _persistPending silent catch in context-assembler. Change to:
   ```ts
   try { ... } catch (e: any) {
     reportHealthIssue('persist:writeLog', e, { command: cmd })
   }
   ```

5. **title**: Change the MUTATION class silent catches to throw ProofOrStopError
   **context**: For example, the worktree-creation call, the git-merge call, the fs.writeFileSync call. A failure must be perceivable by the upper layer.

6. **title**: Add a new proof-or-stop doctor command
   **context**: Scan `~/.proof-or-stop/health.jsonl`, output the health issues from the last 24 hours, grouped by category. Let the user periodically run doctor to see whether proof-or-stop itself has hidden problems.

7. **title**: fixture verifies the health issue is actually written
   **context**: Construct a scenario that triggers a PERSIST class failure (e.g. make the directory containing health.jsonl unwritable), call a proof-or-stop command, and assert that a subsequent doctor can see this issue.

8. **title**: write a doc section in CLAUDE.md about fail-fast policy
   **context**: Make clear "new code is not allowed to silent catch" as a convention, so future agents follow it when changing proof-or-stop code

### Test directions

- happy: the normal path has no health issue
- edge: a recoverable failure (e.g. a temporary fs.write failure) is correctly written to health
- adversarial: when health.jsonl itself fails to write, it does not affect the main flow

### Acceptance

- the grep count of `catch.*{.*ignore` is reduced from the baseline by at least half
- deliberately trigger a worktree-creation failure and observe whether it throws rather than swallows
- run `proof-or-stop doctor` and the output format is correct

### Touchpoints

- Create: `packages/main/src/core/health.ts`
- Create: `packages/main/src/handlers/doctor.ts`
- Modify: all files containing a silent catch (the grep output list)
- Modify: `CLAUDE.md` add a fail-fast policy section

---

## Story 3: session_brief command [P0]

### Description

CC has conversation memory + system_reminder that let the agent remember earlier things across sessions. proof-or-stop does something similar through story files, but **has no "opening statement" interface** — when a new session's agent launches, it is not told "where you stopped last time, and what just happened".

A new agent coming in either queries with `proof-or-stop story_list` + `proof-or-stop story_get` (multiple round-trips), or starts working directly (with a high probability of being wrong).

Fix goal: give the agent a single-shot command that outputs a complete brief of "what you should be doing right now". CLAUDE.md requires that the first thing a new session does is run this command.

### Checklist

1. **title**: Add a new ToolDef session_brief
   **context**: Add `{ name: 'session_brief', description: 'Generate this session's opening brief: current active story + recent activity + what to do', schema: {} }` to the MAIN_TOOLS array in cli-engine.ts. No parameters.

2. **title**: Implement the session_brief handler skeleton
   **context**: Create `packages/main/src/handlers/session.ts`, exporting `createSessionHandlers(ctx)` containing `session_brief()`. Get the active story via detectActiveStory; when there is no active story, return "No active story. To start: proof-or-stop story_create ..."

3. **title**: Assemble the brief content
   **context**: When an active story exists, assemble markdown output containing:
   - story id + phase + title
   - the most recent 5 events (from story.events)
   - a checklist status summary: N in_progress / M pending / K done, listing the specific in_progress items
   - the result of the last test_story / test_auto (read test-evidence.json)
   - the status of the last bug_report

4. **title**: Implement the computeNextStep inference function
   **context**: Based on (phase, checklist status, test result, bug status), infer "what should be done right now". For example:
   - PLAN + no testIntent → "complete testIntent then run story_review"
   - DEV + checklist all done + no fixture → "story_advance phase=TEST_CASE then write the fixture"
   - TEST + has an unfixed bug → "fix the bug then re-run test_story"
   - concrete next-step suggestions for each phase

5. **title**: Get the "recent activity timeline" from activity.jsonl
   **context**: Read the last 20 activity records and output them in time order. Let the agent see "when the most recent development action happened".

6. **title**: detect the git status
   **context**: Run `git status --short`, `git log -3 --oneline`, and put the results into the brief together

7. **title**: Write a CLAUDE.md section that forces running session_brief at the start of a session
   **context**: Add to the proof-or-stop project's CLAUDE.md: "Every time a session starts or resumes interrupted work, the first command must be `proof-or-stop session_brief`; understand the state before continuing to work"

8. **title**: fixture verifies the brief output for different states
   **context**: Construct mock stories for 5 states (IDEA / PLAN / DEV / TEST / DONE) and assert that the brief output for each state contains the correct nextStep hint

### Test directions

- happy: under common states the brief output meets expectations
- edge: boundaries such as no active story, or just finished PLAN with no events
- adversarial: activity.jsonl does not exist / the story file is corrupted / the git repo does not exist

### Acceptance

- Run manually: `proof-or-stop session_brief` can output a meaningful brief in your current project
- Have a new Claude session run this command to open, and observe whether it can go directly to the correct next step

### Touchpoints

- Create: `packages/main/src/handlers/session.ts`
- Modify: `packages/main/src/cli-engine.ts` MAIN_TOOLS array
- Modify: `packages/main/src/registry.ts` createMainRegistry
- Modify: `CLAUDE.md` (add the session-opening convention)

---

## Story 4: Full PROMPT-ification of 4 core commands [P0]

### Description

CC's TodoWrite description is a 184-line full PROMPT containing 7 when-to-use/when-not examples. proof-or-stop's tool descriptions are all one sentence:

```ts
{ name: 'story_create', description: 'Create a Story entry', schema: {...} },
{ name: 'checklist_update', description: 'Update a checklist item', schema: {...} },
{ name: 'fixture_batch_add', description: '...', schema: {...} },
```

Seeing one sentence, the agent only knows "what it can do", not "when it should be used". Concrete manifestations:

- not advancing the phase with `story_advance` when it should (stuck at PLAN, not entering DEV)
- not marking done with `checklist_update` when it should (a pile of in_progress hanging around)
- directly Editing the fixture json file instead of using `fixture_batch_add` (bypassing schema validation)
- entering DEV directly instead of using `story_review` for adversarial review (blocked by the signed guard, but retried repeatedly)

Note: proof-or-stop's tool descriptions appear in the `proof-or-stop help` and `proof-or-stop <cmd> --help` output, and **do not enter the agent's LLM context** (because proof-or-stop is a CLI). So the goal of "PROMPT-ification" is not to save tokens, but to make **the output of `proof-or-stop <cmd> --help` able to teach the agent how to use it**. The agent runs `--help` before calling, and that is when we educate it.

### Checklist

1. **title**: Change the ToolDef.description field from string to string | { short: string, long: string }
   **context**: short is used for the one-line display in `proof-or-stop help`; long is used for the detailed display in `proof-or-stop <cmd> --help`. The printToolHelp function prints long when it detects one, otherwise prints short. Maintain backward compatibility.

2. **title**: Write a full PROMPT for story_create
   **context**: The long field contains:
   - When to use (the user explicitly says "develop X"; the user gave a chunk of requirements to break down)
   - When NOT to use (the user is discussing / the user is asking a question / the user is describing an idea but still iterating)
   - 4-6 real proof-or-stop scenario examples (using real story names)
   - required-field descriptions + common errors (e.g. forgetting to add keywords causing duplicate creation)
   - a counterexample: show how *not* to use (e.g. treating "let's discuss the plan" as a story_create trigger)

3. **title**: Write a full PROMPT for story_advance
   **context**:
   - when to advance proactively (checklist all done + the phase guard is satisfied)
   - the precondition checklist for each phase transition
   - the handling flow when the DONE Final Checklist fails (do not retry repeatedly; first see which item failed)
   - "stuck and not advancing" is an anti-pattern (you should choose one of retry / fix / discard)
   - include the ROLLBACK path description (DEV ← TEST_CASE_REVIEW, TEST_CASE ← TEST, etc.)

4. **title**: Write a full PROMPT for checklist_update
   **context**:
   - the discipline of "mark in_progress before starting, mark done after commit"
   - touch only one item at a time (avoid batch-updating multiple done)
   - the testIntent field is the test-intent agent's business; the main agent should not write it
   - a counterexample: batch-marking 5 items done and only then writing the code = lying

5. **title**: Write a full PROMPT for fixture_batch_add
   **context**:
   - when to batch add (at the DEV→TEST_CASE switch)
   - how to write the execute field (dynamically import dist/, cannot import src/)
   - intentRef is required, in the format `CHK-xxx:happy|edge|adversarial:N`
   - a full case example (one each for cli_blackbox and browser_blackbox)
   - a counterexample: importing source directly in execute (the compiled artifact is the truth)

6. **title**: Include scenario-based step-by-step guidance in the PROMPT
   **context**: Add a passage at the end of each PROMPT: "If you are not sure how to use this, follow these steps:". Give the agent a fallback when it is uncertain.

7. **title**: printToolHelp appends "→ use proof-or-stop session_brief to see what to do now" at the end of the output
   **context**: Every --help output guides the agent back to session_brief at the end (in case it looked up --help precisely because it did not know what to do)

8. **title**: fixture verifies the long PROMPT contains the necessary keywords
   **context**: grep the long description of the 4 core commands and assert they contain structural markers like "When to use", "When NOT", "Example"

### Test directions

- happy: all 4 PROMPTs contain the 5-part structure (when-to-use / when-not / examples / step-by-step / counterexample)
- edge: each PROMPT is a reasonable length (200-500 lines), neither too short nor too long
- adversarial: take a new Claude session and run `proof-or-stop story_create --help`, observe whether it actually learned the usage

### Acceptance

- the 4 long PROMPTs are written
- take a clean session, run proof-or-stop help → proof-or-stop story_create --help → have Claude create a story, and observe whether it uses it correctly on the first try

### Touchpoints

- Modify: the ToolDef interface and MAIN_TOOLS array in `packages/main/src/cli-engine.ts`
- Modify: the printToolHelp function in `packages/main/src/cli-engine.ts:207-235`
- Create (optional): the `packages/main/src/cli-prompts/` directory, putting the 4 long PROMPTs into separate files

---

## Story 5: stale state detection [P1]

### Description

CC's todo_reminder injects a system-reminder every 10 turns of not using TodoWrite. proof-or-stop does not have this — once the agent forgets to advance, the story hangs forever and no one reminds it.

proof-or-stop's activity.jsonl already records the timestamps of all commands. **Consuming it is enough to do stale state detection**.

Fix goal: before each proof-or-stop command runs, first print a warning to stderr (non-blocking); if a stale state is detected (timeout without advancing, an in_progress item stuck, a long time with no proof-or-stop call), let the agent see it.

### Checklist

1. **title**: Create src/core/stale-detector.ts
   **context**: Export `detectStaleState(ctx: HandlerContext): string[]` returning a warning array. Each warning is one line of readable text.

2. **title**: Implement rule 1 — the story has had no event in a phase for over 30 minutes
   **context**: Read the active story's events; if the last event is more than 30 minutes ago, warn `Story B-xxx has been in the PHASE phase for N minutes without advancing`

3. **title**: Implement rule 2 — a checklist item has been in_progress for over 30 minutes
   **context**: Scan checklist.items for status === 'in_progress' && (Date.now() - new Date(item.startTime).getTime()) > 30min, warn `CHK-xxx has been in_progress for N minutes; have you already finished it and forgotten to mark done?`

4. **title**: Implement rule 3 — more than 60 minutes since the last proof-or-stop command of any kind
   **context**: Read the last record of activity.jsonl; if it is more than 60 minutes ago, warn `It has been N minutes since the last proof-or-stop command; remember to keep following the flow`

5. **title**: Implement rule 4 — an open bug unfixed for over 24 hours
   **context**: Scan bug.json for status === 'open' and createdAt more than 24h ago, warn `Bug BUG-xxx has been open for over 24h; consider fixing it first`

6. **title**: runCli calls detectStaleState before dispatching the command
   **context**: Output each warning to stderr. Note: only detect when there is an active story, to avoid commands like proof-or-stop help being bothered.

7. **title**: thresholds are configurable via proof-or-stop.config.json
   **context**: config adds `staleThresholds: { phaseStale: 30, itemStale: 30, idleProofOrStop: 60, bugStale: 1440 }` (unit: minutes)

8. **title**: fixture verifies the trigger condition of each rule
   **context**: Construct mocks of the 4 stale states and assert that the corresponding warning appears for each

### Test directions

- happy: no warning is output when there is no stale state
- edge: triggers correctly when 1 second past the threshold
- adversarial: does not throw when activity.jsonl is corrupted / story.events is missing

### Acceptance

- Manually create an item that has been in_progress for over 30 minutes, run any proof-or-stop command and observe whether it prints a warning
- After running once, do checklist_update done, then run a command again and it should no longer warn

### Touchpoints

- Create: `packages/main/src/core/stale-detector.ts`
- Modify: `packages/main/src/cli-engine.ts:519-530` (runCli calls detectStaleState after createMainRegistry)
- Modify: `packages/main/src/core/config.ts` add staleThresholds

---

## Story 6: Hook System [P1]

### Description

CC has PreToolUse / PostToolUse / SessionStart / Stop hooks, with users hanging their own shell scripts in settings.json. proof-or-stop has none at all.

Why proof-or-stop needs them:

- after the agent runs `story_advance phase=DEV` it wants to automatically `git fetch origin main && git merge`, and there is currently no mechanism
- the user wants to automatically push the error log when a proof-or-stop command errors
- **the observer wants to be notified when proof-or-stop state changes** (more elegant than polling activity.jsonl)

This is also the key infrastructure for connecting the observer to proof-or-stop — the observer does not need to poll; hanging a PostCommand hook lets it receive events in real time.

### Checklist

1. **title**: Add a hooks field definition to proof-or-stop.config.json
   **context**: The ProofOrStopConfig in core/config.ts adds:
   ```ts
   hooks?: {
     preCommand?: Record<string /* commandName or "*" */, string[] /* shell commands */>
     postCommand?: Record<string, string[]>
     onError?: Record<string, string[]>
     onPhaseChange?: Record<string /* "FROM->TO" or "*" */, string[]>
   }
   ```

2. **title**: Create the src/core/hooks.ts dispatch framework
   **context**: Export `runHooks(stage: 'preCommand' | 'postCommand' | 'onError' | 'onPhaseChange', commandName: string, env: Record<string, string>): Promise<void>`. Match the commandName or the wildcard "*", and spawn the shell commands. Environment variables are passed to the hook script (PROOF_OR_STOP_STORY_ID, PROOF_OR_STOP_PHASE, PROOF_OR_STOP_COMMAND, PROOF_OR_STOP_ERROR, etc.).

3. **title**: invoke the preCommand hooks in cli-engine.ts run()
   **context**: After parsing the args and validating, and before executing the handler, call runHooks('preCommand', cmd, env). If a hook returns a non-zero exit, decide whether to block the main command (default does not block, just outputs a warning)

4. **title**: invoke the postCommand hooks in run()
   **context**: After the handler finishes executing, call runHooks('postCommand', cmd, env). Add PROOF_OR_STOP_RESULT_JSON to the env

5. **title**: Add the onError hook to the error path of run()
   **context**: When an error is caught, call runHooks('onError', cmd, env), adding PROOF_OR_STOP_ERROR to the env

6. **title**: Add an onPhaseChange hook trigger in story-advance.ts
   **context**: After a phase transition succeeds, look up the hook by the "FROM->TO" format and call runHooks('onPhaseChange', `${oldPhase}->${newPhase}`, env)

7. **title**: Implement hook timeout protection
   **context**: Each hook command has a default 30-second timeout; on timeout, kill the process and output a warning. Prevent a problematic hook from dragging down proof-or-stop

8. **title**: Write hook docs + examples
   **context**: Add a section "Hooks" to docs/guide.md, containing a full configuration example and several common use cases (auto sync, telegram notify, auto backup)

9. **title**: fixture verifies hook dispatch
   **context**: Construct a temporary proof-or-stop.config.json containing an echo hook, run a proof-or-stop command, and assert the hook was executed (by checking the echo output)

### Test directions

- happy: all 4 categories of hooks can trigger normally and pass env variables
- edge: the hook command does not exist / the hook output is huge / the hook executes slowly but does not time out
- adversarial: the hook command has a SQL injection risk (when the user misconfigures) / the hook is an infinite loop

### Acceptance

- Configure a postCommand hook that writes a log to /tmp/proof-or-stop.log, run any command and observe the log being written
- Observe the onPhaseChange hook being triggered during story_advance

### Touchpoints

- Create: `packages/main/src/core/hooks.ts`
- Modify: `packages/main/src/core/config.ts` add the hooks field
- Modify: the run function in `packages/main/src/cli-engine.ts:575-594`
- Modify: `packages/main/src/handlers/story-advance.ts` add the onPhaseChange trigger
- Create: `docs/guide-hooks.md`

---

## Story 7: command metadata + dry-run support [P2]

### Description

CC has no explicit metadata, but proof-or-stop is a CLI tool and the agent needs to know:

- does `test_auto` take 30 seconds or 5 minutes to run once? (decides whether to wait)
- is `story_discard` irreversible? (decides whether confirm is needed)
- is `arch_trace` read-only or does it write state?

Dangerous commands (story_discard, dev_merge, fixture_migrate, fixture_batch_add in bulk) should support `--dry-run` to show what would be done without actually doing it.

2026-06-10 convergence note: the main CLI did not land a separate `ToolDef.supportsDryRun` field, and this item should no longer be tracked as a missing requirement. The currently effective contract is already carried jointly by the command schema (`dryRun` / `confirm`), the handler's dry-run short-circuit behavior, and the operator-safety prose of `COMMAND_POLICIES`; what needs filling in is to surface this existing contract directly into help/policy, rather than building another parallel metadata.

### Checklist

1. **title**: Derive the dry-run contract from schema + COMMAND_POLICIES, do not add a `supportsDryRun` field
   **context**:
   ```ts
   // dry-run source of truth: do not add ToolDef.supportsDryRun
   // - schema.dryRun / schema.confirm = the only mechanical signal
   // - the handler dry-run branch = the real execution boundary
   // - COMMAND_POLICIES reason/replacement = the user-readable operation semantics
   // help output aggregates these three tiers directly, no second metadata is maintained
   ```

2. **title**: Fill in metadata for all MAIN_TOOLS
   **context**: Fill in according to each command's actual behavior. The read-only class (story_get / story_list / checklist_get) is marked read-only. The state-mutating class is marked writes-state. The git-operation class is marked writes-fs. The test_* class is marked spawns-process + slow.

3. **title**: Mark the 4 irreversible commands
   **context**: story_discard / dev_merge / fixture_migrate / test_auto (which does git restore). The metadata of these commands adds `irreversible: true`

4. **title**: printHelp groups by stability
   **context**: Put deprecated commands at the bottom, and mark experimental commands separately with [exp]

5. **title**: irreversible commands require --confirm by default
   **context**: cli-engine.ts checks before dispatch; if the command is irreversible and no --confirm was passed, print a warning + jump to a dry-run report, without actually executing

6. **title**: Implement a general dry-run framework
   **context**: The handler function accepts ctx.dryRun: boolean. On dry-run, only print the plan without actually changing the store. Conventional output format:
   ```
   [DRY-RUN] story_discard B-042 would:
     - delete worktree .worktrees/B-042/
     - delete branch story/B-042
     - mark story as DISCARDED
   → add --confirm to execute for real
   ```

7. **title**: Implement the dry-run path for the 4 irreversible commands
   **context**: Each command implements a plan() function returning "what would be done"; on dry-run, only call plan() + print; on normal execution, call plan() + execute()

8. **title**: fixture verifies dry-run
   **context**: Run `story_discard B-test --dry-run` and assert the story still exists in the store + the output contains "[DRY-RUN]"

### Test directions

- happy: the dry-run output of each irreversible command meets expectations
- edge: real execution after dry-run succeeds
- adversarial: a race condition where dry-run executes + state is changed externally in the meantime + real execution

### Acceptance

- `proof-or-stop help` output is grouped by stability
- `proof-or-stop story_discard B-xxx` refuses to execute by default, prompting to add --confirm
- `proof-or-stop story_discard B-xxx --dry-run` outputs the plan and does not change the store

### Touchpoints

- Modify: `packages/main/src/cli-engine.ts` ToolDef + MAIN_TOOLS + printHelp
- Modify: `packages/main/src/handlers/worktree.ts`, `fixture.ts`, etc. handlers containing irreversible operations

---

## Story 8: progress streaming completion [P2]

### Description

`test_auto` runs from 30 seconds to several minutes, during which the agent cannot see intermediate progress. CC's streaming gives the agent a real-time signal that it is still running and not stuck. proof-or-stop has `ctx.log` but does not use it in many places.

The watchdog mechanism (kill after 2 minutes of no activity) also needs these log calls to reset lastActivity. **Missing progress logs = the watchdog kills slow commands by mistake**.

### Checklist

1. **title**: grep all uses of ctx.log + find the high-latency functions
   **context**: Find which handlers run for over 5 seconds but have sparse log calls. Focus on: test_auto / test_story / arch_trace / aux_scan / fixture_migrate

2. **title**: Add progress logs to test_auto
   **context**: Before processing each fixture file, log a line `[Ns] processing fixtureName: total=X executable=Y`; every 10 cases, output a line `[Ns] running cases: K/Total`

3. **title**: Add progress logs to arch_trace / aux_scan
   **context**: Log a line each for the scanning phase, the parsing phase, and the analysis phase

4. **title**: Unify the log format with a timestamp
   **context**: Reference the `[${elapsed}s] ${msg}` format of cli-engine.ts:524, and ensure all logs use this format (the runtime adds it automatically, the handler does not need to add it itself)

5. **title**: progress reporting for asynchronous tasks inside the handler
   **context**: For example, test_auto runs multiple fixture files; after each file finishes, log a line. You can add a helper `progressFor(label, items, fn)` that logs automatically

6. **title**: fixture verifies the watchdog does not kill slow commands by mistake
   **context**: Construct a command that runs for 3 minutes but logs once every 30 seconds, and assert the watchdog does not kill it (IDLE_TIMEOUT is 2 minutes)

### Test directions

- happy: continuous output during a long command
- edge: the log output frequency is exactly at the IDLE_TIMEOUT boundary
- adversarial: when the log itself fails to write, it does not affect the main flow

### Acceptance

- Run `proof-or-stop test_auto` and observe stderr continuously having timestamped output
- Deliberately construct a fixture that takes 5 minutes to finish, and observe whether it is killed by the watchdog by mistake

### Touchpoints

- Modify: `packages/main/src/handlers/test-auto.ts`
- Modify: `packages/main/src/handlers/test-story.ts`
- Modify: `packages/utils/src/handlers/aux-trace.ts`
- Modify: `packages/utils/src/handlers/aux.ts`

---

## Story 9: schemaVersion + empty migration [P3]

### Description

The JSON files written by proof-or-stop's store have no schemaVersion field. **When we want to change the field structure of story.json / checklist.json in the future, old story files will blow up**.

CC has [src/migrations/](src/migrations/) to handle schema upgrades. Doing this now costs 0 (schemaVersion=1 + one empty migration); when we really need to change the schema in the future, just add a v1→v2 migration directly.

### Checklist

1. **title**: Add a schemaVersion field to all store types
   **context**: StoryInfo / ChecklistData / BugData / TestEvidenceData / ReviewData in types.ts all add `schemaVersion: 1`

2. **title**: Create the src/core/migrations.ts framework
   **context**: Export `migrateStory(data: any): StoryInfo`, `migrateChecklist(data: any): ChecklistData`, etc. Internally branch by schemaVersion. v1 is a noop (just fill in schemaVersion=1)

3. **title**: store.readJson calls migrate internally
   **context**: All read* methods call the corresponding migrate function after reading. Let old-format data upgrade automatically (the new schemaVersion is carried along on write)

4. **title**: fixture verifies v0 → v1 auto migration
   **context**: Construct an old story.json without schemaVersion, and after readStory assert the returned data contains schemaVersion=1

5. **title**: Write a doc explaining the migration policy
   **context**: Add a schema-migration.md to docs/decisions, spelling out the flow for future schema changes:
   - bump schemaVersion
   - add a migrate function
   - write at least one old → new data fixture
   - no breaking changes allowed, only additive

### Test directions

- happy: old-format read auto-fills schemaVersion
- edge: after write, read again and the format is still correct
- adversarial: abnormal cases such as schemaVersion being a string / a negative number / missing

### Acceptance

- Manually delete the schemaVersion from some existing story.json, and read returns normally
- Manually add schemaVersion=999, and read reports a clear error

### Touchpoints

- Modify: `packages/main/src/core/types.ts`
- Create: `packages/main/src/core/migrations.ts`
- Modify: `packages/main/src/core/store.ts` readJson
- Create: `docs/requirements/decisions/schema-migration.md`

---

## Story 10: search command + call-stack recursion guard [P3]

### Description

Two independent but both-P3 small improvements, merged into one story.

**search command**: CC has ToolSearchTool that uses select/keyword to find tools. proof-or-stop has 40+ commands, and when the agent is unsure what a certain feature is called it has to grep through the help output.

**call-stack recursion guard**: proof-or-stop already has the `__proofOrStopTestAutoRunning` global flag to prevent test_auto recursion, but it only targets one command. It needs to be generalized into a call stack.

### Checklist

1. **title**: Implement proof-or-stop search
   **context**: Add ToolDef `{ name: 'search', description: 'Search proof-or-stop commands by keyword', schema: { keyword: z.string() } }`. The handler uses a simple BM25 to match over the descriptions of all MAIN_TOOLS and outputs a list sorted by relevance

2. **title**: search output format
   **context**:
   ```
   proof-or-stop search decision
     - testintent_record (0.85): append the testIntent review result
     - story_review     (0.70): adversarial review of testIntent completeness
     - checklist_update (0.55): update a checklist item
   → add --help to see the full parameters
   ```

3. **title**: fuzzy matching Chinese + English
   **context**: tokenize supports both Chinese and English at the same time, to avoid the Chinese word for "decision" failing to match the English "decision"

4. **title**: Implement a general call stack
   **context**: The cli-engine.ts run() function pushes the command name onto `globalThis.__proofOrStopCallStack` at the start, and pops it at the end. The fixture runner also pushes when calling `$handlers.foo()`.

5. **title**: recursion detection
   **context**: Before pushing, check whether the stack already contains this command name. If it does, throw `Recursion detected: ${stack.join(' → ')} → ${cmd}`

6. **title**: Remove the old __proofOrStopTestAutoRunning flag
   **context**: The general call stack already covers this case, and the old flag can be deleted. But first ensure the fixture runner also goes through the general stack

7. **title**: fixture verifies recursion is detected
   **context**: Construct a fixture case that calls `$handlers.test_auto()` and assert it throws a "Recursion detected" error

### Test directions

- happy: search returns relevant commands; the call stack pushes/pops normally
- edge: search returns an empty result when the keyword matches no command
- adversarial: a fixture internally calls multi-level nested commands, ensuring recursion is detected rather than an infinite loop

### Acceptance

- `proof-or-stop search decision` outputs at least 3 relevant commands
- Deliberately construct a recursive fixture and run test_auto to see whether it is detected

### Touchpoints

- Modify: `packages/main/src/cli-engine.ts` add the search ToolDef + run() adds the call stack
- Create: `packages/main/src/handlers/search.ts`
- Modify: `packages/main/src/handlers/test-auto.ts` remove __proofOrStopTestAutoRunning
- Modify: `packages/main/src/handlers/test-runner-core.ts` the fixture runner adds the call-stack push

---

## Implementation Recommendations

### Recommended landing order

Sorted by ROI, **do Stories 1-4 (P0) first**.

```
Week 1 (core refactor):
  Day 1-2: Story 1 (full nextStepHint coverage)
  Day 3:   Story 2 (silent catch fix)
  Day 4:   Story 3 (session_brief)
  Day 5-7: Story 4 (PROMPT-ify 4 core commands)

Week 2 (infrastructure):
  Day 8-9:  Story 5 (stale state detection)
  Day 10-12: Story 6 (Hook system)

After Week 3 (optional):
  Story 7-10 done as actual needs dictate
```

P0 + P1 are 12 days of effort in total; after finishing them, proof-or-stop's "the agent uses it wrong" problem will be significantly reduced.

### Do not do it all at once

After each story lands, **run it for at least a week** and observe the activity.jsonl data:

- whether the frequency of the agent calling proof-or-stop rises (the hint is working)
- whether silent failures decrease (health.jsonl is not empty)
- whether new sessions actually run session_brief on startup (the CLAUDE.md guidance takes effect)
- if the data does not move → the refactor did not take effect → investigate why the agent did not adopt it

Do not do all the stories at once and then wait for the long-term effect. **Each story is independently verifiable**.

### Dependencies between stories

```
Story 1 (nextStepHint)  ← independent
Story 2 (silent catch)  ← independent
Story 3 (session_brief) ← independent
Story 4 (PROMPT-ify)    ← independent (but synergizes with Story 3 — 4 references session_brief at the end of the PROMPT)

Story 5 (stale)         ← depends on the health.ts framework of Story 2
Story 6 (hooks)         ← depends on the decorateResult design of Story 1

Story 7-10 ← independent
```

The 4 P0 stories are completely dependency-free and can run in parallel.

### Verification telemetry

After each story lands, run this analysis:

```bash
# Story 1 verification: proof-or-stop command call frequency
cat docs/story/activity.jsonl | jq -r '.tool' | sort | uniq -c | sort -rn

# Story 2 verification: whether health.jsonl is being written reasonably
ls ~/.proof-or-stop/health.jsonl
wc -l ~/.proof-or-stop/health.jsonl

# Story 3 verification: how many session_brief calls per day
cat docs/story/activity.jsonl | grep session_brief | wc -l

# Story 4 verification: observe whether new sessions reduce proof-or-stop call errors
# look at the ratio of status=fail in activity.jsonl
```

## One-sentence Summary

**proof-or-stop's current problem is not "the mechanisms are not enough", it is "the communication with the agent is not enough"**. It has the phase gate, the Final Checklist, the signed review, physical verification — these are all correct, but **these signals are not clearly conveyed to the agent**.

CC's TodoWrite is powerful not because its data structure is complex (it is actually extremely minimal), but because its PROMPT + reminder + result reinforce, three-in-one, makes the model internalize the usage habit.

Porting this "communication three-in-one" to proof-or-stop is the most valuable thing learned from CC. The other mechanisms (cache, deferred, autoCompact) are all CC's specializations for the LLM-context scenario, and do not apply directly to a CLI tool.

## B-5ea4 Retrospective (2026-04-08): Engineering Done ≠ Task Done

A real-world lesson from the proof-or-stop-agent project's B-5ea4 (avatar-escalation-resume-loop). This story's engineering completeness was 9/9 but its user-value completeness was 0/5 — an instance of the proof-or-stop flow's **most severe blind spot**.

### What the engineering view saw (all green)
- EscalationQueue added an answered event + answerPromise API → ✓
- intercept goes through wait-then-resume for both low-confidence + llm-failed → ✓
- spawn a 2nd claude subprocess + the same sessionId → ✓
- the canonical resume prompt keeps the 2nd claude from being hijacked by the CLAUDE.md project context → ✓
- /code summary outputs the three time segments wall=/wait=/active= → ✓
- all 8 unit fixtures pass → ✓
- three-way checks-and-balances by the reviewer passed → ✓
- 2 real-machine manual tests (a 3-question batch + a 1+1 single question), all 9/9 event verification points passed → ✓

### What the user view saw (failing)
Running `/code You must call the AskUserQuestion tool to ask me one question: 1+1=? options 2/3/4` on a real machine, the last segment the user actually saw:

```
[claude] session ea3045f9 started   ← the 2nd claude
Question sent, waiting for you to choose.   ← said by claude, looks like it is still waiting
[✓ claude-code ea3045f9 exit=0 3t $0.0711 wall=100.4s wait=9.8s active=90.6s]
> 
```

After reading this, the user would ask: "**Did it actually finish or not? What does 'question sent, waiting for you to choose' mean? I already chose just now, didn't I?**" There was not a single line of plain language telling the user "the answer has been pushed to Claude Code, and it has completed the task based on your answer".

### 4 root causes
1. **The PLAN phase did not write an outcome transcript** — understanding_set's outcome field at the time only wrote one abstract sentence "the escalation event chain is wired up", without writing "after the user finishes typing the command, the terminal will show lines X/Y/Z one after another".
2. **During the DEV phase real-machine test, the main agent read the output with an engineer's eye** — it verified 9 event points (session count, stub detection, event emit, event subscribe, queue answer, resume spawn, time accounting, cap), but **did not put itself in the user's shoes and read the final output from the top**, asking "after reading this string of text, would the user feel the task is done?"
3. **The three-way checks-and-balances only cover engineering, not product** — the testIntent written by the test-intent agent is all engineering behavior; the test-case-reviewer reviews testIntent coverage; the reviewer has no "pretend I am the user" step. With all 9/9 engineering metrics passing, the reviewer still passed.
4. **The smoke fixture culture is "prove the event flow is connected"** — emphasizing "the LLM really reacts as expected" and "the tool call really happened", without emphasizing "after the user reads this output, do they feel the task is over?"

### What the proof-or-stop framework changed as a result

1. **CLAUDE.md** added a new chapter "User-Value Acceptance (takes precedence over technical-chain verification)", clearly writing "engineering done ≠ task done", the PLAN phase must produce a user-facing transcript, real-machine testing must switch perspective, and a 5-question DONE self-check checklist. The full B-5ea4 retrospective is also written there.
2. **story-advance.ts**'s PLAN/DEV/TEST/DONE phase hints all added a "⚠ user-value acceptance" reminder section, so every time the phase advances, the main agent is re-prompted once "do not only stare at the event log".
3. **this cc-learnings.md** added this section as a permanent learning record of the proof-or-stop framework.

### Not done yet but should be done

- **product-reviewer agent**: a 4th category of role parallel to test-case-reviewer, specifically reviewing "whether the outcome is achieved from the user's perspective". The current review phase only has engineering-perspective reviewers; adding this is what completes the three-way checks-and-balances. Belongs to a future story.
- **A soft quality check on understanding_set's outcome field during the review phase**: if the outcome length < 100 or it contains too many abstract words ("chain, event, mechanism, closed loop", etc.), the reviewer prompt adds a line "question whether the outcome is a user-facing transcript". Belongs to a future story.
- **The DONE gate mandatorily requires evidence/live-smoke-transcript.json**: take the PLAN outcome as expected, the real-machine actual transcript as actual, and the diffed product as a required DONE deliverable. Belongs to a future story (be careful: a hard gate would penalize stories that do not need a user-facing transcript, such as pure refactors / proof-or-stop framework fixes, and may need a type-aware waiver).

### One-sentence summary

**All of proof-or-stop's previous mechanisms are extensions of a programmer's mindset** (fixture, reviewer, phase gate, smoke). What B-5ea4 exposed is that proof-or-stop **has no extension of a product mindset** — a mechanism that forces the main agent, at every advancement, to be asked "from the user's perspective, do you say it is done?" The change this time adds the minimum viable version of that product-mindset channel: write the rule in CLAUDE.md + a repeated reminder in the phase hint. The next time someone makes the same mistake under the proof-or-stop flow, they will at least be prompted once at any of the PLAN/DEV/TEST/DONE advancements.

## References

- `/Users/xiaoxx/Documents/GitHub/CC/src/tools/TodoWriteTool/prompt.ts` — PROMPT-style reference
- `/Users/xiaoxx/Documents/GitHub/CC/src/utils/attachments.ts:3266-3317` — the periodic reminder injection logic
- `/Users/xiaoxx/Documents/GitHub/CC/src/services/compact/autoCompact.ts:67-70` — circuit-breaker example
- `/Users/xiaoxx/Documents/GitHub/CC/src/tools.ts:191` — the cross-system cache key comment
- `packages/main/src/handlers/story-advance.ts:432-449` — the only existing nextStepHint reference
- `packages/main/src/cli-engine.ts:534-553` — the existing watchdog implementation
- `packages/main/src/cli-engine.ts:556-573` — the existing activity.jsonl write
