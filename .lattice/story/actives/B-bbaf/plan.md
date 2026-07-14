# Plan: B-bbaf Freeze runaway stories with a convergence + takeover circuit breaker

Design of record is decision_set (chosen: multi-signal-cheap-read). All FOUR death-loop
signals have a cheap read-only per-story source (no hot-path activity-log scan): advance-count
(story.events), pass-rate (review ledgers), takeover-frequency (per-story counter bumped in the
existing takeover audit write), and repeated-identical-gate-failure (per-story counter bumped at
the existing cli-engine failure write site, reset on advance — CHK-006). The gate-failure signal
was originally excluded on a WRONG premise (that gate rejections are not persisted); they ARE
persisted to activity.jsonl at cli-engine.ts:1256-1260, so it is included as the sharpest brake.

## CHK-001: Pure convergence/takeover breaker core deriving four signals

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/convergence-breaker.ts

**Verify**:
- `npm run build` (packages/main) compiles clean
- The CHK-005 smoke exercises assessBreaker on the B-f458 and healthy fixtures

**DoneWhen**:
- Exports a PURE `assessBreaker(inputs)` returning `{ tripped, reasons[], severity }`, no I/O (mirrors core/review-convergence.ts purity).
- Inputs carry: advanceCount (from story.events action==='advance'), reviewRuns / reviewPasses counts (for pass-rate), takeoverCount (from the per-story counter of CHK-002), maxGateRepeat (from the per-story gate-failure counter of CHK-006), and resolved thresholds.
- Pass-rate can only trip once reviewRuns >= min-sample (mirrors STALL_MIN_ROUNDS); advance, takeover, and gate-repeat trip on strict `>=`/`>` their thresholds.
- On any malformed/missing input the function fails open (tripped=false) and never throws.

## CHK-002: Graduated freeze state with a one-shot auto-recovery budget (gitignored artifact)

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/convergence-breaker.ts (state read/write + graduated logic + takeover-count read)
- Modify: packages/main/src/core/story-owner-lease.ts (bump the per-story takeover counter inside the existing takeover audit write, right after appendActivityLog)
- Modify: packages/main/src/core/runtime-artifact-registry.ts (register breaker-state artifact)
- Modify: .gitignore (glob so breaker-state.json is never tracked)

**Verify**:
- `git check-ignore .lattice/story/actives/B-bbaf/breaker-state.json` returns the path (ignored)
- The CHK-005 smoke drives first-trip -> auto-recover -> re-trip -> frozen, and asserts the takeover counter increments on a takeover

**DoneWhen**:
- Per-story breaker-state.json persists `{ windowBaseline, autoRecoveriesSpent, frozen, trippedReasons, counterSnapshot, takeoverCount }` under `.lattice/story/actives/<id>/`.
- The takeover-counter bump lives in story-owner-lease.ts inside the existing takeover audit write (right after appendActivityLog), serialized by the same lease write; the breaker reads takeoverCount cheaply. The single legitimate forceTakeover is counted, never blocked here.
- First pathological trip re-baselines the window and increments autoRecoveriesSpent to 1 (budget=1), advance proceeds.
- A re-trip while autoRecoveriesSpent>=1 sets frozen=true (no further auto-recovery).
- Registered in runtime-artifact-registry.ts with a matching .gitignore glob (story-owner-lease.ts F-008 pattern); never dirties a DONE merge.

## CHK-003: Enforce the freeze at story_advance + a human-only ack resume command

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/cli-engine.ts (pre-transition breaker check in the story_advance path + rejection render)
- Modify: packages/main/src/registry.ts (new `story_resume` ack command)

**Verify**:
- Frozen fixture: `lattice story_advance` is rejected with a message naming the tripped counters + next action
- `lattice story_resume --ack --reason=...` (interactive) clears it; `LATTICE_AUTOPILOT=1 lattice story_resume ...` is refused

**DoneWhen**:
- When breaker-state.frozen, mutating story_advance (and takeover-carrying commands) are hard-blocked with a rejection that names each tripped counter and points at `done_prepare --dryRun`.
- `story_resume --ack --reason=<text>` clears frozen only in an interactive session; it refuses under non-interactive/autopilot (stdin-not-a-TTY or an explicit autopilot env signal), so a looping agent cannot self-ack.
- The single legitimate forceTakeover human-override path is unchanged (only counted, never blocked here).

## CHK-004: Env-tunable thresholds with evidence-derived defaults

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/convergence-breaker.ts (threshold resolver)

**Verify**:
- Smoke asserts default trip at advance>20; `LATTICE_CONVERGENCE_MAX_ADVANCE=5` trips at 6; `abc`/`-1`/`1e9` fall back to default

**DoneWhen**:
- `resolveConvergenceThresholds(env)` mirrors resolveBurnAlertThresholds: typo-safe fallback, per-variable sanity ceilings, no NaN/Infinity.
- Env vars: LATTICE_CONVERGENCE_MAX_ADVANCE (default 20), LATTICE_CONVERGENCE_MAX_TAKEOVER (default 5), LATTICE_CONVERGENCE_MIN_PASS_RATE (default 0.35) + LATTICE_CONVERGENCE_MIN_SAMPLE (default 10), LATTICE_CONVERGENCE_MAX_GATE_REPEAT (default 2).
- Windowing basis (OQ-2 resolved): all counters are cumulative story-lifetime totals derived from persisted per-story state (advance events, review-run/pass ledger lengths, takeover counter, gate-failure counter) — NOT a wall-clock window. This is deterministic, clock-free, and matches core/review-convergence.ts's event-based counting. LATTICE_CONVERGENCE_MAX_TAKEOVER is a lifetime ceiling; the auto-recovery re-baseline (CHK-002) gives a healthy long story headroom, and the gate-failure counter resets on a successful advance so only current repeats count.
- Defaults derived from B-f458. CORRECTED figures (fixing the stale "<10%"): the storm was 89 advances / 65 takeovers; review pass-rate was ~23.7% overall (31 pass / 131 run_start), collapsing to ~9.5% in the post-16:00 window (42 run_start / 4 pass) — the sub-window figure, not the overall rate. Default MIN_PASS_RATE 0.35 sits safely above the ~24% overall storm rate.

## CHK-006: Fourth signal — repeated-identical-gate-failure counter (bump at failure site, reset on advance)

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/convergence-breaker.ts (readGateFailureCounts / bumpGateFailureCount / resetGateFailureCounts + gate-repeat signal in assessBreaker)
- Modify: packages/main/src/cli-engine.ts (bump on the story-scoped failure catch at ~1256; reset on a successful story_advance)

**Verify**:
- Smoke: two `story_advance` failures with the same reason digest push the counter to 2 and assessBreaker trips gate-repeat; a successful advance resets to 0
- Two failures with DIFFERENT reasons stay at 1 each and do not trip

**DoneWhen**:
- A per-story `gate-failure-counts.json` (gitignored, registered like breaker-state) maps digest(command + normalized error reason) -> `{ count, lastReason, lastAt }`, bumped at the cli-engine failure catch where `activeStory` + `cmd` + `error.message` are already in scope (no hot-path activity-log scan).
- assessBreaker trips when the max per-key count `>=` LATTICE_CONVERGENCE_MAX_GATE_REPEAT (default 2), reasons name the command + digest.
- A successful `story_advance` resets that story's gate-failure counts to empty (progress = fresh slate), so a recovered story is never frozen on stale repeats.
- Missing/corrupt counter file fails open (count 0, never throws); the bump is best-effort and never breaks the failure catch path.

## CHK-005: Smoke test replaying the B-f458 signature plus a healthy control

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-006
**Files**:
- Create: packages/main/src/tasks/convergence-breaker-smoke.ts
- Modify: package.json (test:convergence-breaker script + include in `test`)
- Test: packages/main/src/tasks/convergence-breaker-smoke.ts

**Verify**:
- `npm run test:convergence-breaker` prints the PASS line and exits 0
- Wired into the aggregate `npm test` script

**DoneWhen**:
- Synthetic story with 89 advances / 131 runs : 31 passes / 65 takeovers trips the breaker on each reason (advance, pass-rate, takeover, gate-repeat) and freezes on re-trip; ack clears it.
- The gate-repeat signal trips at 2 same-reason failures and resets to 0 on a successful advance.
- A healthy 8-advance converging control never trips (all four signals below threshold).
- The autopilot self-ack refusal and the gitignored-state assertion (breaker-state.json AND gate-failure-counts.json) both hold.
- Emits a stable `PASS convergence-breaker: ...` marker line for grep/CI.
