# B-5d18 — Real-machine acceptance (validate per-command timeout)

User-perspective verification of the fix: a hung validate command must fail **loud**
(exit 124, attributed to the command) at a per-command ceiling, instead of the cli-engine
~300s global no-output idle watchdog silently force-exiting the whole `validate` (which never
re-stamps `test-evidence.materialHash` → silently blocks DONE for every story).

## 5-question user-value self-check

1. **Who is the user / what do they do?** A developer (or autopilot) runs `lattice validate`
   during DEV→TEST / DONE gating.
2. **What was broken?** If any validate command hung, the global idle watchdog would silently
   force-exit the entire `validate` process. No attribution, and `test-evidence.materialHash`
   was never re-stamped → every story's DONE gate silently blocked.
3. **What does the fix deliver?** `runValidationCommand` now always arms a per-command
   wall-clock timeout (explicit `timeoutMs`, else `DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS=240000`,
   strictly below the 300s watchdog and above the ~160s build). A hung command's whole process
   group is killed (SIGTERM→SIGKILL) and attributed exit 124 / `timedOut`.
4. **How is it observed?** `lattice validate` runs all 6 commands; the registered
   `validate-command-timeout-smoke` (18 assertions) proves the kill, fast-pass, default-arming,
   and process-group reap of a SIGTERM-ignoring grandchild. Direct runtime demos below.
5. **Any gap vs. user need?** None. Windows uses `taskkill /t /f` (with an `.on('error')`
   guard so a missing taskkill can't crash the process); POSIX uses process-group signalling.

## Expected (from PLAN)

- `lattice validate` → all 6 configured commands pass; suite reports PASS.
- A hung command is killed at its per-command ceiling with `code:124, timedOut:true`,
  in roughly `timeoutMs` wall-clock — NOT left to run until the 300s global watchdog.
- The default ceiling is used when a command sets no explicit `timeoutMs`.

## Actual (observed on this machine, 2026-06-19, darwin)

```
$ lattice validate
✓ Project validation commands passed
  ✓ configured validate.commands[0]: npm --prefix packages/main run build  (tsc)
  ✓ configured validate.commands[1]: authority client smoke passed
  ✓ configured validate.commands[2]: authority completion smoke passed
  ✓ configured validate.commands[3]: review pass and discard smoke passed
  ✓ configured validate.commands[4]: init-window data-loss smoke passed
  ✓ configured validate.commands[5]: validate-command-timeout smoke passed: 18 assertions

# Live per-command kill (explicit timeoutMs=500):
{"label":"demo-hung","code":124,"timedOut":true,"wallMs":550}

# Live default-arming path (no explicit timeoutMs; tiny injected default=500):
{"label":"demo-default","code":124,"timedOut":true}

# Diagnosis evidence (CHK-001:edge) — why the slow smokes never actually deadlocked:
resolveMainRepoRoot(os.tmpdir()) => same tmp path  (isolated:true)
```

## Diff (expected vs actual)

None. Actual matches expected on every point:
- 6/6 validate commands green.
- Hung command killed loud at 124/timedOut in ~550ms (≈ the 500ms ceiling), not the 300s watchdog.
- Default-arming path also kills at 124 with no explicit `timeoutMs`.
- `lattice validate --story=B-5d18` reports verificationCoverage covered=6/6, missingRequired=0.

## Dual-host review

Genuine cross-provider review over 4 rounds: Claude (concept/quality/test-coverage lanes) +
Codex host-2 (`codex exec`). Codex round-1 caught the process-group MAJOR (only the direct
child was killed); Claude caught the win32 124-contract MAJOR and the taskkill error-handler
F-001. All resolved; round-4 both hosts clean (Codex PASS).
