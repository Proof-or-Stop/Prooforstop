# Plan — B-8d44: run-driver live claude -p engine adapter

## Summary
Build `experiments/recovery-runner/live-engine.mjs` = a `makeLiveEngine({agentRun, reviewArtifact, model, tasksDir, budgets})` factory returning the `async (cell, attempt) => engineResult` that `run-driver.mjs --engine` plugs in. Per cell it sets up a fresh workspace, applies the §6 injection at the §3 fixed point, runs the cell's pre-reg arm (A1/A2/A2prime/A3/A4) with live `claude -p` (reusing run-recovery's core), and emits the RAW evidence run-driver's `buildCanonicalRecord` delegates to `adjudicate.mjs` + `checks.mjs` — never classifying itself. The agent calls are injectable so `live-engine-selfcheck.mjs` drives the whole adapter + run-driver with a deterministic stub (no claude -p), wired as the 7th selfcheck. The live multi-day campaign is a separate next story.

## CHK-001 — Engine factory skeleton + run-driver --engine wiring
**Files:** `experiments/recovery-runner/live-engine.mjs` (create), `experiments/recovery-runner/run-recovery.mjs` (export helpers).
Export `makeLiveEngine(opts)` -> `async (cell, attempt) => engineResult`. Default `agentRun`/`reviewArtifact` = live claude -p (reuse run-recovery.mjs — export `agentRun`/`reviewArtifact`/`tokensFromUsage`/`budgetExceeded` there, or factor a shared module). Provide the run-driver `--engine` entrypoint (default export or a thin shim run-driver can import). Return `{infraVoid:true, voidReason}` on claude overload/529/exec error or an arm-loop infra failure.
Done when: `run-driver.mjs --engine experiments/recovery-runner/live-engine.mjs` loads the engine (no live run needed to verify loading).

## CHK-002 — Per-cell workspace + §6 injection at the §3 fixed point
**Files:** `experiments/recovery-runner/live-engine.mjs`.
Per cell: mkdtemp a fresh ws, resolve the task by `cell.taskId` under `tasksDir`, copy the prompt + any agent-editable files; capture the acceptance script path + `expectedHash`. If `cell.scenarioId != null`, apply the injection at the pre-reg §3 fixed point (immediately before the first agent action) via the task's `subtle-wrong-output.mjs` `inject(ws, task)` (or the scenario module), and set `injectionApplied=true`; ablation cells (`scenarioId==null`) apply none (`injectionApplied=false`).
Done when: a cell with a scenario writes the injected payload at the fixed point; an ablation cell does not; the acceptance path/hash are recorded.

## CHK-003 — Map + implement the 5 pre-reg arms (A1/A2/A2prime/A3/A4)
**Files:** `experiments/recovery-runner/live-engine.mjs`.
Per pre-reg §1: **A1** one agent pass, output final (no loop); **A2** naive-retry up to R=3 on acceptance fail; **A2prime** A2 bounded by token+wall budget (reuse `budgetExceeded`; token binds first; hard-truncate; emit `budgetPass/tokenInBand/wallInBand/truncated/tokenBudget/wallBudgetMs`); **A3** A2 then EXACTLY ONE review pass via `reviewArtifact` using a shared `buildReviewContext()` snapshot (the SAME structured context A4's reviewer gets; findings reported, not iterated); **A4** full loop with the review gate (refuse to ship on no-artifact / acceptance-fail / reviewer-BLOCK). Reuse run-recovery's loop core; do NOT carry over a4b.
Done when: each arm runs its loop via the injected agent and produces the per-arm behavior (A2prime budget caps fire; A3 does one review; A4 gates shipping).

## CHK-004 — Collect RAW §7 evidence (no in-adapter classification)
**Files:** `experiments/recovery-runner/live-engine.mjs`.
Return `engineResult` with the fields buildCanonicalRecord consumes: `acceptanceScriptPath`/`expectedHash`/`runAcceptance` (harnessAcceptance); `baselineFailures`/`postFailures` (hiddenRegression — from a clean-checkout baseline vs post-run hidden ground-truth); `changedPaths`/`allowedPaths`/`junkPatterns` (diffHygiene); `newContent`/`createdPaths`/`permEvents`/`processEvents`/`newBrokenBeyondRef`/`terminalStopEvent` (adjudicate's 5 unsafe detectors + state machine); plus `runId`/`modelId`/`headHash`/`materialHash`/`tokensSpent`/`wallClockMs`/`agentCallCount`/`evidenceRefs`/`harnessLogDigest`/`injectionApplied` and the A2prime budget fields. Instrument `changedPaths`/`createdPaths`/`newContent` via a ws before/after snapshot and `processEvents`/`permEvents`/destructive cmds from the claude -p JSON tool events. The adapter MUST NOT set `adjudicatedOutcome` (run-driver -> adjudicate.mjs owns it).
Done when: a produced engineResult fed through run-driver's `buildCanonicalRecord` yields a record passing `validateRecord`, with the three pass flags + adjudicatedOutcome derived by the harness (not the adapter).

## CHK-005 — Offline engine selfcheck (stub agent, no claude -p) + wire into npm test
**Files:** `experiments/recovery-runner/live-engine-selfcheck.mjs` (create), `experiments/recovery-runner/run-selfchecks.mjs`, `package.json` (if needed).
Build `makeLiveEngine` with a DETERMINISTIC stub `agentRun`/`reviewArtifact` (no claude -p) and drive `runDriver()` over a small synthetic cell set (each arm x {null + 1-2 scenarios}) against 1-2 real corpus tasks. Assert: every record passes `validateRecord`; the three pass flags + `adjudicatedOutcome` match the stub's known behavior (a stub shipping a ground-truth-failing payload under A2prime => amplified; an A4 stub whose reviewer BLOCKs => safe-stop; a clean stub => completed/recovered); `injectionApplied` correct; an unsafe-action stub makes the corresponding adjudicate detector fire; `infraVoid` re-run works when the stub signals overload. NO live claude -p. Wire as the 7th selfcheck in `run-selfchecks.mjs` / `npm run test:experiments`.
Done when: `node experiments/recovery-runner/live-engine-selfcheck.mjs` passes offline; `run-selfchecks.mjs` shows 7/7; `npm test` green.

## Verification
- `node experiments/recovery-runner/live-engine-selfcheck.mjs` (offline, no claude -p)
- `node experiments/recovery-runner/run-selfchecks.mjs` (7/7)
- `npm test` (full suite green)
