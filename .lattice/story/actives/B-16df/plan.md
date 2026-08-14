# Plan: B-16df verification_evidence_add ignores validate.commands[].timeoutMs, capping mechanical receipts at 270s regardless of configured budget

Chosen option: **checklist-layer-lookup** — implement the `{command,args}` matching and
config lookup in `packages/main/src/handlers/checklist.ts` (which already one-way imports
both `core/validation-executor.ts` and `handlers/verifier.ts`, so no circular import is
created), and thread the resolved `timeoutMs` into all 4 existing `runSingleAllowlistedCommand`
call sites via one shared helper. `resolveCommandTimeoutMs` and the `lattice validate`
execution path (`executeValidationPlan`/`runValidationCommand`) are not touched.

## CHK-001: RED repro proves runSingleAllowlistedCommand ignores validate.commands[].timeoutMs

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: `packages/main/src/tasks/validate-command-timeout-smoke.ts`

**Change**: Add a new case (section 6, after the existing process-group-kill case) to the
existing smoke, following its hermetic style (temp `projectRoot`, no real config/git-status
side effects):
1. Write a temp `lattice.config.json` to a fresh tmpdir project root with a `validate.commands`
   entry: `{"command": NODE, "args": [<args that make the process sleep ~1.5s, e.g. "-e",
   "setTimeout(() => {}, 1500)">], "timeoutMs": 700}` (small on purpose — the test must run
   fast, not wait anywhere near 270s).
2. Call `runSingleAllowlistedCommand` (already imported from `../core/validation-executor.js`)
   with a command string that parses (via `parseAllowlistedCommand`) to the exact same
   `{executable, args}` as the configured entry above, `projectRoot` = the temp dir, and
   **no** `options.timeoutMs`.
3. Assert `result.timedOut === true` and `result.code === 124` — the configured 700ms override
   should kill a command that runs ~1.5s.

Must FAIL on current main: today `runSingleAllowlistedCommand` never reads the temp
`lattice.config.json`, so it always falls back to the hardcoded 270_000ms default, the ~1.5s
command completes normally before that, and `timedOut` is `false`.

**Verify**:
- `npm --prefix packages/main run build` clean.
- `node packages/main/dist/tasks/validate-command-timeout-smoke.js` exits 1 (`FAIL: ...`) on
  current main.
- The same command exits 0 after CHK-002.

**DoneWhen**:
- The new case is genuinely red today: it fails because `timedOut` is `false` when it should
  be `true`, not because of an unrelated error.
- The command used to prove the timeout is short (~1.5s), so the smoke stays fast in both the
  red and green states — no test should ever wait near 270s or the configured budget.
- Registered nowhere new: this smoke is already in `lattice.config.json` `validate.commands`
  per its own docstring; no config change needed for CHK-001 itself.

## CHK-002: Thread validate.commands[].timeoutMs into runSingleAllowlistedCommand's call sites via a shared checklist.ts helper

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: `packages/main/src/handlers/checklist.ts`

**Change**:
1. Add `configuredValidationCommands` to the existing import from `../handlers/verifier.js`
   (new one-way import edge: `checklist.ts` → `verifier.ts`; `verifier.ts` does not import
   `checklist.ts`, so this does not create a cycle). Add `parseAllowlistedCommand` to the
   existing import from `../core/validation-executor.js` (already imported in this file for
   `runSingleAllowlistedCommand`, so no new import edge).
2. Add a private helper, e.g.:
   ```ts
   function resolvePinnedCommandTimeoutMs(root: string, command: string): number | undefined {
     const { executable, args } = parseAllowlistedCommand(command);
     const configured = configuredValidationCommands(root);
     const match = configured.find(
       (c) => c.command === executable && c.args.length === args.length && c.args.every((a, i) => a === args[i]),
     );
     return match?.timeoutMs;
   }
   ```
   Export it (non-default) so CHK-003's regression coverage can unit-test it directly without
   needing a real timed wait.
3. At each of the 4 existing call sites (currently `(command, cwd) =>
   runSingleAllowlistedCommand(command, root, { cwd })`, lines ~1557, 1648, 1779, 1858), change
   to pass `timeoutMs: resolvePinnedCommandTimeoutMs(root, command)` alongside `cwd`. When the
   helper returns `undefined` (no match), this preserves exactly today's behavior
   (`options.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS` inside
   `runSingleAllowlistedCommand`, unchanged).

Do **not** modify `core/validation-executor.ts` (`runSingleAllowlistedCommand`,
`resolveCommandTimeoutMs`) or `handlers/verifier.ts` (`configuredValidationCommands`) — both are
reused as-is.

**Verify**:
- `npm --prefix packages/main run build` clean (tsc succeeds — confirms no circular-import
  breakage between `checklist.ts`, `validation-executor.ts`, `verifier.ts`).
- `node packages/main/dist/tasks/validate-command-timeout-smoke.js` (CHK-001's new case) exits 0.

**DoneWhen**:
- All 4 call sites route through the one shared helper; no duplicated matching logic.
- `resolveCommandTimeoutMs`, `executeValidationPlan`, `runValidationCommand` are byte-for-byte
  unmodified (diff limited to `checklist.ts`).
- A pinned command with no matching `validate.commands[]` entry still gets the 270s default
  (verified in CHK-003, not re-verified here).

## CHK-003: Regression coverage: unmatched commands keep the 270s default, and matching does not cross-match by executable alone

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: `packages/main/src/tasks/validate-command-timeout-smoke.ts`

**Change**: Add two more cases to the same smoke, both unit-testing
`resolvePinnedCommandTimeoutMs` directly (imported from `../handlers/checklist.js`) against a
temp `lattice.config.json` — no real timed waits needed for either case:
1. **Unmatched default**: temp config has one or more `validate.commands` entries, none of
   which match a given pinned command string. Assert
   `resolvePinnedCommandTimeoutMs(root, pinnedCommand) === undefined` (so the caller falls
   through to the 270s default, not a wrong non-matching entry's value).
2. **Args-based disambiguation**: temp config has two entries sharing the same executable
   (e.g. `node`) but different `args`, with different `timeoutMs` values (e.g. 700 and 5000).
   Assert `resolvePinnedCommandTimeoutMs` returns the exact matching entry's `timeoutMs` for
   each of the two corresponding pinned command strings — i.e. matching compares the full args
   array, not just the executable.

**Verify**:
- `node packages/main/dist/tasks/validate-command-timeout-smoke.js` exits 0 with both new cases
  passing (increased assertion count logged).

**DoneWhen**:
- The unmatched case and the disambiguation case are both direct, fast unit assertions on
  `resolvePinnedCommandTimeoutMs` (no dependency on real elapsed time).
- Full smoke suite (`node packages/main/dist/tasks/validate-command-timeout-smoke.js`) still
  passes all pre-existing assertions (sections 1-6) plus the two new ones.
