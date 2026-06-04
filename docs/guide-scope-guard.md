# Prewrite Scope Guard — Setup, Multi-Host Semantics, and Verification

The **prewrite scope guard** is a story-scoped projection that tracks whether an
agent dispatched to implement a checklist item stays within its declared scope
contract.  Starting a guard session tells Lattice which runtime host is running
the agent so it can choose the right protection strategy:

- **`active` (pre-tool blocking)** — Claude Code exposes a `PreToolUse` hook
  that fires *before* a tool write is committed.  When this hook is installed,
  a forbidden write can be intercepted and rejected before the file is modified.
- **`watcher-fallback` (post-write detection)** — Every other host (Codex,
  Gemini, headless runners, …) can only be observed after the fact.  Lattice
  detects the violation when `guard_session_check` runs and blocks lifecycle
  progression, but the forbidden file has already been written.

The protection level that `guard_session_check` applies is the same regardless
of mode — every forbidden write is recorded and blocks the lifecycle gate.  The
difference is *when* the intervention happens.

## Multi-host semantics

| Host / provider string | Guard mode | Mechanism |
|---|---|---|
| `claude`, `claude-code`, `claude_code`, `claudecode` | `active` | Claude Code `PreToolUse` hook fires before the write |
| `codex` | `watcher-fallback` | Diff detected after write; no pre-tool interception |
| `gemini`, `gemini-cli` | `watcher-fallback` | Same as Codex |
| Any other string | `watcher-fallback` | Default; no pre-tool hook assumption |

`guard_session_start` derives the mode automatically from the `provider` you
pass.  You never configure the mode directly.

> **Important:** Lattice never overclaims `active` mode.  Even if you pass
> `provider=claude-code`, the guard session will still only block lifecycle
> progression — it cannot intercept writes in real time unless the Claude Code
> `PreToolUse` hook is installed in `.claude/settings.json`.  See the
> [hook installation](#claude-code-pretooluse-hook-installation) section below.

## Lifecycle of a guard session

```
guard_session_start  →  [DEV work]  →  guard_session_check  →  story_advance
                                                ↓
                                       violations detected?
                                       yes → block advance, surface paths
                                       no  → pass, lifecycle continues
```

A guard session is automatically re-checked at each `story_advance` gate
(`runGuardSessionGate` in `handlers/guard-session.ts`).  You can also run
`guard_session_check` manually at any time without affecting the lifecycle.

## Commands

### Start a guard session

```bash
lattice guard_session_start '{"storyId":"B-xxxx","provider":"claude-code"}'
lattice guard_session_start '{"storyId":"B-xxxx","provider":"codex"}'
```

Output includes `guardMode: active` or `guardMode: watcher-fallback` so you can
confirm which strategy is in effect.

### Check for violations

```bash
lattice guard_session_check '{"storyId":"B-xxxx"}'
```

Re-evaluates the current worktree diff against the scope contract.  Violation
list is overwritten each time — clearing the out-of-scope changes and re-running
check returns to a clean state.

### Simulate a write (dry-run)

```bash
lattice guard_session_check '{"storyId":"B-xxxx","simulatedWrites":["src/forbidden.ts"]}'
```

Injects a path as if it had been written without touching the file.  Useful for
testing scope contracts without making real changes.

### Inspect current state

```bash
lattice guard_session_status '{"storyId":"B-xxxx"}'
lattice guard_session_status '{"storyId":"B-xxxx","json":true}'
```

### Run `lattice doctor` to see all active guard sessions

```bash
lattice doctor
```

The "Guard session scan" section reports:

- Whether the Claude Code `PreToolUse` hook is installed
- Each story with an active guard session and its mode / violation count
- A `⚠` warning when `guardMode=active` but the hook is not installed (the
  session behaves like `watcher-fallback` in practice)

### JSON output

```bash
lattice doctor --format=json | jq '.guardSessions'
```

Fields:

| Field | Meaning |
|---|---|
| `preToolUseHook.installed` | `true` when `.claude/settings.json` has at least one `PreToolUse` entry |
| `preToolUseHook.hookCount` | Number of hook definitions registered |
| `sessions` | All stories with a guard-session.json (including stopped) |
| `active` | Sessions whose status is not `stopped` |
| `withViolations` | Sessions with at least one violation |
| `activeMissingHook` | `active`-mode sessions without the PreToolUse hook installed |
| `hasMisconfigured` | `true` when `activeMissingHook` is non-empty |
| `hasViolations` | `true` when any session has violations |

## Resolving violations

When `guard_session_check` detects forbidden writes:

1. **Remove the out-of-scope changes** — revert or delete the file(s) listed
   under "VIOLATIONS".
2. **Or acknowledge a necessary expansion** — if the scope genuinely needs to
   widen, run `scope_contract_acknowledge` and then re-run `guard_session_check`.
3. Re-run `story_advance` once the session shows 0 violations.

## Claude Code PreToolUse hook installation

The `PreToolUse` hook lets Claude Code intercept a tool call *before* it writes
a file.  Without it, the guard session can only detect violations after the fact.

### Check whether it is installed

```bash
lattice doctor
# look for: PreToolUse hook (Claude Code): installed (N hooks)
# or:       PreToolUse hook (Claude Code): not installed
```

Or via JSON:

```bash
lattice doctor --format=json | jq '.guardSessions.preToolUseHook'
```

### Installing the hook

Add a `PreToolUse` entry to `.claude/settings.json` (create the file if absent):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git -C \"$CLAUDE_PROJECT_DIR\" rev-parse --show-toplevel 2>/dev/null || echo \"$CLAUDE_PROJECT_DIR\")/.claude/hooks/prewrite-scope-guard.cjs\""
          }
        ]
      }
    ]
  }
}
```

> **Note:** A `prewrite-scope-guard.cjs` hook script is not yet shipped as a
> managed asset.  Until it is, the guard session provides watcher-fallback
> protection for all providers.  `lattice doctor` will report the hook as
> "not installed" and advise accordingly.  This is correct and expected during
> the current rollout phase.

### Managed asset drift

`lattice check` scans managed assets (CLAUDE.md, `.claude/hooks`, …) for drift.
Once the `prewrite-scope-guard.cjs` hook becomes a managed asset, `lattice check`
will report it as `MISSING` and `lattice check --apply` will install it.

## Watcher-fallback: what it means in practice

A `watcher-fallback` guard session still provides meaningful protection:

- Every `story_advance` re-checks the diff before allowing lifecycle progression.
- `guard_session_check` can be called manually at any point during DEV.
- Violations are recorded in the session and surfaced in `lattice doctor`.
- The lifecycle gate blocks if violations are present, regardless of mode.

The only thing `watcher-fallback` cannot do is prevent the forbidden file from
being written in the first place.  For CI runners, Codex agents, and Gemini
agents, this is the expected and correct behavior — the gate still catches the
violation before the story moves to REVIEW.

## Scope contract prerequisites

A guard session requires a scope contract to check against.  If none exists,
`guard_session_check` clears any violations and returns a clean state — it never
fabricates violations from a missing contract.

```bash
# Set up a scope contract before starting a guard session
lattice scope_contract_set '{"storyId":"B-xxxx","mode":"enforce","allowedModify":["src/foo.ts"],...}'
# or derive one from the plan
lattice scope_contract_init_from_plan '{"storyId":"B-xxxx"}'

# Then start the guard session
lattice guard_session_start '{"storyId":"B-xxxx","provider":"claude-code"}'
```

See `docs/requirements/decisions/lifecycle-artifact-scope.md` for the scope
contract classifier policy.
