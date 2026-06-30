# Prewrite Scope Guard — Setup, Multi-Host Semantics, and Verification

The **prewrite scope guard** is a story-scoped projection that tracks whether an
agent dispatched to implement a checklist item stays within its declared scope
contract. Starting a guard session tells Proofbound which runtime host is running
the agent so it can choose the right protection strategy.

B-e781 closure status: the B-43de M4-M12 parent roadmap rows are closed by
local machine evidence and row-level claim boundaries. The B-997b wave 1 guard
behavior remains limited to canonical scope rows, lifecycle/runtime artifact
classification, truthful guard capability labels, and acknowledgement
visibility. Retired Authority Server production/runtime conformance remains a
non-goal; local evidence rows must not imply production receipts or a broader
capability unlock.

- **`native-pretool` (pre-tool blocking)** — a host with a verified pre-tool
  hook can reject a forbidden write before the file is modified.
- **`wrapped-preapply` (dispatch pre-apply blocking)** — Codex and
  Antigravity/agy can use this only when running through Proofbound
  dispatch/pre-apply flow.
- **`watcher-fallback` (post-write detection)** — any host without a verified
  pre-tool or wrapped-preapply context is observed after the fact. Proofbound
  detects the violation when `guard_session_check` runs and blocks lifecycle
  progression, but the forbidden file has already been written.

The protection level that `guard_session_check` applies is the same regardless
of mode — every forbidden write is recorded and blocks the lifecycle gate.  The
difference is *when* the intervention happens.

Provider strings in this guide describe scope-guard behavior, not owner-session
identity. Owner-session identity should flow through the canonical
`LATTICE_SESSION_ID` host-adapter contract described in
`docs/requirements/decisions/owner-session-contract-execution-plan.md`; provider
labels such as `codex`, `claude-code`, `antigravity`, and `agy` are diagnostic
context and must not become new core owner-lease exceptions. Since B-9089,
generic lifecycle and owner-lease code consumes the shared owner-session facade;
host-specific session envs belong only in adapter, dispatch, or test code.

## Multi-host semantics

| Host / provider string | Guard mode | Mechanism |
|---|---|---|
| `claude`, `claude-code`, `claude_code`, `claudecode` with verified hook | `native-pretool` | Host hook fires before the write |
| `codex` with verified Codex hook | `native-pretool` | Codex native hook fires before the write |
| `codex` through Proofbound dispatch/pre-apply flow | `wrapped-preapply` | Proofbound wrapper checks the patch before apply |
| `antigravity`, `agy` through Proofbound dispatch/pre-apply flow | `wrapped-preapply` | Proofbound wrapper checks the patch before apply while preserving the Antigravity CLI host identity |
| `codex`, `antigravity`, `agy` without a verified context | `watcher-fallback` | Diff detected after write; no pre-tool interception |
| `gemini`, `gemini-cli` | legacy/deprecated compatibility only | Not a current guard-provider path; use `antigravity`/`agy` for current third-host flows |
| Any other string | `watcher-fallback` | Default; no pre-tool hook assumption |

`guard_session_start` derives the mode automatically from the `provider` you
pass.  You never configure the mode directly.

> **Important:** Proofbound never overclaims `native-pretool` mode. Even if you
> pass `provider=claude-code` or `provider=codex`, the guard session can only
> intercept writes when a verified host hook is installed. Without that proof,
> it reports `wrapped-preapply` only for dispatch/pre-apply flow or
> `watcher-fallback` otherwise.

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
lattice guard_session_start '{"storyId":"B-xxxx","provider":"antigravity","viaDispatch":true}'
lattice guard_session_start '{"storyId":"B-xxxx","provider":"agy","viaDispatch":true}'
```

Output includes `guardMode: native-pretool`, `guardMode: wrapped-preapply`, or
`guardMode: watcher-fallback` so you can confirm which strategy is in effect.

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
- A warning when a native-pretool-capable session lacks a verified hook (the
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
| `activeMissingHook` | Native-pretool-capable sessions without the PreToolUse hook installed; field name retained for JSON compatibility |
| `hasMisconfigured` | `true` when `activeMissingHook` is non-empty |
| `hasViolations` | `true` when any session has violations |

## Resolving violations

When `guard_session_check` detects forbidden writes:

1. **Remove the out-of-scope changes** — revert or delete the file(s) listed
   under "VIOLATIONS".
2. **Or acknowledge a necessary expansion** — if the scope genuinely needs to
   widen, run `scope_contract_acknowledge` and then re-run `guard_session_check`.
3. Re-run `story_advance` once the session shows 0 violations.

Acknowledgement is not a silent pass. The acknowledged expansion remains warn
and reviewer-visible as a `scope.out_of_scope:<path>` row with `blocking=false`;
review, validation, and DONE gates still need their own evidence.

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
being written in the first place. For CI runners, Codex agents,
Antigravity/agy agents outside dispatch/pre-apply flow, and legacy Gemini
compatibility sessions, this is the expected and correct behavior — the gate
still catches the violation before the story moves to REVIEW.

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
