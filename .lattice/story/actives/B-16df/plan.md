# Plan: B-16df verification_evidence_add ignores validate.commands[].timeoutMs, capping mechanical receipts at 270s regardless of configured budget

Chosen option: **checklist-layer-lookup** — implement the `{command,args}` matching and
config lookup in `packages/main/src/handlers/checklist.ts` (which already one-way imports
both `core/validation-executor.ts` and `handlers/verifier.ts`, so no circular import is
created), and thread the resolved `timeoutMs` into all 4 existing `runSingleAllowlistedCommand`
call sites via one shared helper. `resolveCommandTimeoutMs` and the `lattice validate`
execution path (`executeValidationPlan`/`runValidationCommand`) are not touched.

## CHK-001: RED repro proves runSingleAllowlistedCommand ignores validate.commands[].timeoutMs

**CORRECTION (recorded during DEV, after CHK-002's implementer caught a real plan flaw)**:
the original design below (section 6 = a single assertion calling
`runSingleAllowlistedCommand` directly with `{}`) can NEVER turn green after CHK-002, because
the chosen fix (checklist-layer-lookup) only makes `checklist.ts`'s callers config-aware —
`runSingleAllowlistedCommand` itself is deliberately unmodified (scope-boundary.json). A test
that bypasses `checklist.ts` entirely can't observe the fix. Corrected design below splits
section 6 into 6a (a permanent, still-true-after-the-fix characterization of the low-level
primitive) and 6b (the actual red→green assertion, exercising the real fixed surface). This
correction does not reopen the circular-import question (decision_set's
`executor-layer-lazy-import` alternative stays rejected) — it only fixes which surface CHK-001
exercises.

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: `packages/main/src/tasks/validate-command-timeout-smoke.ts`

**Change**: Add a new case (section 6, after the existing process-group-kill case) to the
existing smoke, following its hermetic style (temp `projectRoot`, no real config/git-status
side effects):
1. Write a temp `lattice.config.json` to a fresh tmpdir project root with a `validate.commands`
   entry: `{"command": "node", "args": ["-e", "setTimeout(() => {}, 1500)"], "timeoutMs": 700}`
   (small on purpose — the test must run fast, not wait anywhere near 270s). Command string:
   `node -e "setTimeout(() => {}, 1500)"`.
2. **6a (permanent characterization, stays true before AND after CHK-002)**: call
   `runSingleAllowlistedCommand` (already imported from `../core/validation-executor.js`)
   directly with `projectRoot` = the temp dir and **no** `options.timeoutMs`. Assert
   `result.timedOut === false` — calling the low-level primitive directly, bypassing
   `checklist.ts`'s resolver, is documented/by-design to keep using the 270s default; this is
   not the bug being fixed and must NOT be asserted as `timedOut === true`.
3. **6b (the real red→green assertion)**: dynamically import the compiled checklist handler
   module — `const checklistMod: any = await import('../handlers/checklist.js');` (dynamic,
   not a static top-level import, so this file still compiles before CHK-002 adds the export —
   a static import of a not-yet-existing named export would be a TypeScript compile error,
   breaking every section, not just this one). Assert
   `typeof checklistMod.resolvePinnedCommandTimeoutMs === 'function'` (red today: the export
   does not exist yet). When present, call
   `checklistMod.resolvePinnedCommandTimeoutMs(pinnedRoot, pinnedCommand)` to get the resolved
   timeout, then call `runSingleAllowlistedCommand(pinnedCommand, pinnedRoot, { timeoutMs:
   resolved })` — mirroring exactly what the 4 real call sites in `checklist.ts` do post-fix —
   and assert `result.timedOut === true` and `result.code === 124`.

Must FAIL on current main at 6b's `typeof ... === 'function'` check (or, if that's patched
around, at the final `timedOut === true` assertion): today `checklist.ts` exports no such
helper and `runSingleAllowlistedCommand` never reads config on its own.

**Verify**:
- `npm --prefix packages/main run build` clean.
- `node packages/main/dist/tasks/validate-command-timeout-smoke.js` exits 1 on current main
  (before CHK-002's export exists).
- The same command exits 0 once CHK-002's `resolvePinnedCommandTimeoutMs` export and its 4
  rewired call sites are present — verify this by temporarily stashing CHK-002's
  `checklist.ts` diff, rebuilding, confirming red, then restoring it and rebuilding again to
  confirm green (mirrors the controlled-experiment discipline the CHK-002 implementer already
  used to find this flaw).

**DoneWhen**:
- 6a documents the primitive's permanent direct-call behavior (never expected to flip).
- 6b is genuinely red before CHK-002's export exists and genuinely green after, exercising the
  same combined call shape (`resolvePinnedCommandTimeoutMs` + `runSingleAllowlistedCommand`)
  the 4 real call sites use.
- The command used to prove the timeout is short (~1.5s), so the smoke stays fast in both
  states — no test should ever wait near 270s or the configured budget.
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
- `node packages/main/dist/tasks/validate-command-timeout-smoke.js` (CHK-001's corrected 6a/6b
  cases, see CHK-001's CORRECTION note) exits 0: 6a still asserts the direct-call default
  (unchanged), 6b's `resolvePinnedCommandTimeoutMs` export now exists and, combined with
  `runSingleAllowlistedCommand`, honors the configured override.

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
