# Proof-or-Stop Hooks Guide

Proof-or-Stop exposes 4 event points in every command's lifecycle and lets you configure shell hook commands in `proof-or-stop.config.json`. The design is inspired by Claude Code's PreToolUse / PostToolUse / SessionStart / Stop mechanism, and its goal is to decouple "things the agent wants to do after a command finishes" from the Proof-or-Stop framework core.

## Claude Code Prompt Reminder

Proof-or-Stop initialization merges a Claude Code `UserPromptSubmit` hook into `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git -C \"$CLAUDE_PROJECT_DIR\" rev-parse --show-toplevel 2>/dev/null || echo \"$CLAUDE_PROJECT_DIR\")/.claude/hooks/session-brief-reminder.cjs\""
          }
        ]
      }
    ]
  }
}
```

This hook is only a soft reminder: it locates the repository from the hook JSON's `cwd`, `CLAUDE_PROJECT_DIR`, or the current cwd, reads `.proof-or-stop/activity.jsonl`, `docs/story/activity.jsonl`, and the story-scoped `docs/story/actives/*/activity.jsonl`, and looks for the most recent `session_brief` heartbeat. By default, anything within 60 minutes is treated as fresh and the hook stays silent; when the most recent heartbeat is older than 60 minutes or there is no fresh record, it prints:

```text
Run proof-or-stop session_brief first to restore context
```

The threshold can be adjusted with `PROOF_OR_STOP_SESSION_BRIEF_FRESH_MINUTES`. Malformed stdin, a missing activity file, and single-line parse failures all exit zero and must never block the user's prompt. Claude Code hooks/settings belong only to `.claude/`; Proof-or-Stop init does not create adapter-owned settings outside the supported host directories.

## When to Use

- After the agent runs `story_advance phase=DEV`, automatically run `git fetch origin main && git merge`
- When a command errors, push the error log to Slack / WeCom / Telegram
- Observer-style tools that want real-time notifications when the Proof-or-Stop state changes (more elegant than polling activity.jsonl)
- Automatically back up the fixture directory before entering the TEST phase
- Copy the understanding/decision JSON to an external archive when leaving the PLAN phase

## Schema

Add a `hooks` field to `proof-or-stop.config.json`:

```json
{
  "scanRoot": "src",
  "storyDir": "docs/story/actives",
  "hooks": {
    "preCommand": {
      "*":              ["./scripts/notify-start.sh"],
      "story_advance":  ["./scripts/sync-main.sh"]
    },
    "postCommand": {
      "*": ["./scripts/log-result.sh"]
    },
    "onError": {
      "*": ["./scripts/push-error.sh"]
    },
    "onPhaseChange": {
      "*":              ["./scripts/notify-phase.sh"],
      "DEV->TEST_CASE": ["./scripts/freeze-deps.sh"],
      "TEST->DONE":     ["./scripts/cut-release.sh"]
    }
  }
}
```

Each stage is a `Record<string, string[]>`: the key is the match condition, and the value is an array of shell commands (run serially in array order).

## The 4 Stages

| Stage | Trigger timing | Key match rule |
|---|---|---|
| `preCommand` | Before the handler runs (arguments already parsed, phase gate already passed) | `commandName` or `"*"` |
| `postCommand` | After the handler returns successfully, before `process.exit(0)` | `commandName` or `"*"` |
| `onError` | After the handler throws, before `process.exit(1)` | `commandName` or `"*"` |
| `onPhaseChange` | After `story_advance` persists the new phase | The literal `"FROM->TO"` or `"*"` |

**Exact match + the `"*"` wildcard both run**—this is not a fallback. For example, with `preCommand: { "story_advance": [...], "*": [...] }`, running `story_advance` runs both groups serially (the exact match first, then the wildcard).

## Environment Variables

Each hook command receives the full `process.env` through `child_process.spawn`, plus the injected environment variables listed below.

`buildHookEnv` ([core/hooks.ts](../packages/main/src/core/hooks.ts)) exports only the canonical `PROOF_OR_STOP_*` names. Retired environment-variable spellings are not read or dual-written.

| Variable | Stages it appears in | Meaning |
|---|---|---|
| `PROOF_OR_STOP_STAGE` | all | the current Proof-or-Stop stage name (`preCommand`/`postCommand`/`onError`/`onPhaseChange`) |
| `PROOF_OR_STOP_COMMAND` | all | the current Proof-or-Stop command name (e.g. `story_advance`) |
| `PROOF_OR_STOP_CWD` | all | the process cwd when the hook fired |
| `PROOF_OR_STOP_ROOT` | all | the current Proof-or-Stop project root (after `--root` resolution) |
| `PROOF_OR_STOP_ARGS_JSON` | preCommand / postCommand / onError | the argument JSON passed to the handler (truncated to 8KB) |
| `PROOF_OR_STOP_RESULT_JSON` | postCommand | the handler return value JSON (truncated to 8KB) |
| `PROOF_OR_STOP_ERROR` | onError | the error.message string |
| `PROOF_OR_STOP_STORY_ID` | onPhaseChange + any stage when an active story exists | the current Proof-or-Stop story id (`B-xxxx`) |
| `PROOF_OR_STOP_PHASE` | any stage when an active story exists | the current phase (at the time the hook runs) |
| `PROOF_OR_STOP_OLD_PHASE` | onPhaseChange | the phase before the transition |
| `PROOF_OR_STOP_NEW_PHASE` | onPhaseChange | the phase after the transition |

## Behavior Contract

1. **Non-blocking failure**: a hook exiting non-zero, throwing, or not being found never blocks the main command. It prints a `[proof-or-stop-hook] failed (exit N): <stage> <cmd>` warning to stderr and appends a `category=hook:exec` health issue to `~/.proof-or-stop/health.jsonl`.
2. **30-second timeout**: each hook command is timed independently and receives `SIGKILL` after 30 seconds. It prints `[proof-or-stop-hook] timeout (30s): ...` to stderr, with health category `hook:timeout`.
3. **stdout limit**: a hook's stdout is echoed to stderr only for the first 200 characters, to avoid polluting the main command's JSON output (this matters most for postCommand: an agent piping into jq does not want hook notes mixed into the JSON).
4. **Sequential execution**: commands within the same stage are awaited serially in array order, each one waiting for the previous to finish. preCommand fully completes before the handler runs; postCommand fully completes before `process.exit(0)`.
5. **Concurrency**: exact-match + wildcard commands also run in order—the exact match runs to completion first, then the wildcard.
6. **Environment variable truncation**: both `PROOF_OR_STOP_RESULT_JSON` and `PROOF_OR_STOP_ARGS_JSON` are truncated to 8KB to prevent blowing up the env (the default ARG_MAX on macOS / Linux is roughly 256KB; Windows is far stricter).
7. **stage validation**: an invalid stage key under `hooks` is silently ignored (PROBE class, no health written).

## Examples

### Example 1: Automatically rebase from main on every `story_advance`

```json
{
  "hooks": {
    "preCommand": {
      "story_advance": [
        "git fetch origin main >/dev/null 2>&1 && git merge --no-edit origin/main || true"
      ]
    }
  }
}
```

This is hooked into preCommand rather than postCommand because merging after the advance could produce conflicts the agent cannot see. A failing preCommand does not block either, but it at least surfaces the conflict in the Proof-or-Stop command's stderr.

### Example 2: Trigger a Telegram notification on onPhaseChange

```json
{
  "hooks": {
    "onPhaseChange": {
      "*": [
        "curl -s -XPOST \"https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage\" -d chat_id=$TG_CHAT_ID -d text=\"proof-or-stop $PROOF_OR_STOP_STORY_ID: $PROOF_OR_STOP_OLD_PHASE→$PROOF_OR_STOP_NEW_PHASE\""
      ]
    }
  }
}
```

`TG_BOT_TOKEN` / `TG_CHAT_ID` are inherited through the shell environment (the hook's env is derived from `process.env`).

### Example 3: Snapshot the fixture directory before entering TEST

```json
{
  "hooks": {
    "onPhaseChange": {
      "TEST_CASE_REVIEW->TEST": [
        "tar czf /tmp/proof-or-stop-fixtures-$PROOF_OR_STOP_STORY_ID.tgz tests/fixtures/"
      ]
    }
  }
}
```

When `test_auto` finishes, it runs `git restore + git clean -fd` on the fixturesDir; should broken code cause the fixtures to be lost, this tar archive is the last-resort backup.

### Example 4: Push errors to a webhook

```json
{
  "hooks": {
    "onError": {
      "*": [
        "curl -s -XPOST $WEBHOOK_URL -H 'Content-Type: application/json' -d \"{\\\"command\\\":\\\"$PROOF_OR_STOP_COMMAND\\\",\\\"error\\\":\\\"$(echo $PROOF_OR_STOP_ERROR | head -c 200)\\\"}\""
      ]
    }
  }
}
```

Mind the shell escaping—this is fine for simple cases, but for anything complex wrap it in a standalone shell script and write `["./scripts/push-error.sh"]` in the hook, reading the env from inside the script.

## Debugging

- Hook didn't fire? Run `proof-or-stop doctor` and check `health.jsonl` for `hook:exec` / `hook:timeout` / `hook:resolve` entries
- Hook didn't receive the environment variables? Prepend `env | sort > /tmp/proof-or-stop-env-debug.txt` to the hook command
- Hook output polluting the main command? Check whether stdout returned a non-empty string—postCommand should write logs to a file rather than stdout

## Unsupported Scenarios

- **Synchronous blocking hooks**: all stages are fire-and-await, but a failure never aborts the main command. If you need "hook fail → block the main command" semantics, `kill -9` the parent process yourself from inside the script (not recommended; the behavior is counterintuitive).
- **Cross-command state sharing**: each hook is spawned independently and shares no stdout/state with the others. If you need it, write a file or pass it through environment variables.
- **Cancelling the main command**: an onError hook already runs after the main command has failed, so it cannot be used to "retry" the main command. To retry, the agent calls it again itself.

## Cooperation with the Stale-detector

`proof-or-stop doctor` now also aggregates `hook:*` health issues, which together with the `stale-detector`'s stderr warnings form Proof-or-Stop's "self-observation" system:

- stale-detector: proactively prints soft reminders before each command runs (phase stuck / item stuck in_progress / idle proof-or-stop / open bug overdue)
- hook: spawns user scripts at event points, leaving a trail in `~/.proof-or-stop/health.jsonl`
- doctor: aggregates the health status of both

See `core/stale-detector.ts` and `core/hooks.ts` for details.
