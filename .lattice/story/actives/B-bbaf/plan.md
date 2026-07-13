# Plan: B-bbaf Freeze runaway stories with a convergence + takeover circuit breaker

Design of record is decision_set (chosen: multi-signal-cheap-read). All four death-loop
signals were checked for a cheap read-only source; the "repeated-identical-gate-failure"
signal is deliberately not a separate counter (gate rejections are not persisted as events)
and is subsumed by advance-count + pass-rate.

## CHK-001: Pure convergence/takeover breaker core deriving three counters

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/convergence-breaker.ts

**Verify**:
- `npm run build` (packages/main) compiles clean
- The CHK-005 smoke exercises assessBreaker on the B-f458 and healthy fixtures

**DoneWhen**:
- Exports a PURE `assessBreaker(inputs)` returning `{ tripped, reasons[], severity }`, no I/O (mirrors core/review-convergence.ts purity).
- Inputs carry: advanceCount (from story.events action==='advance'), reviewRuns / reviewPasses counts (for pass-rate), takeoverCount (from the per-story counter of CHK-002), and resolved thresholds.
- Pass-rate can only trip once reviewRuns >= min-sample (mirrors STALL_MIN_ROUNDS); advance and takeover trip on strict `>` their thresholds.
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
- Env vars: LATTICE_CONVERGENCE_MAX_ADVANCE (default 20), LATTICE_CONVERGENCE_MAX_TAKEOVER (default 5), LATTICE_CONVERGENCE_MIN_PASS_RATE (default 0.35) + LATTICE_CONVERGENCE_MIN_SAMPLE (default 10).
- Windowing basis (OQ-2 resolved): all counters are cumulative story-lifetime totals derived from persisted per-story state (advance events, review-run/pass ledger lengths, takeover counter) — NOT a wall-clock window. This is deterministic, clock-free, and matches core/review-convergence.ts's event-based counting. LATTICE_CONVERGENCE_MAX_TAKEOVER is therefore a lifetime ceiling; the auto-recovery re-baseline (CHK-002) is what gives a healthy long story headroom, not a rolling clock window.
- Defaults derived from B-f458 (healthy 6-10 advances / ~1 takeover; storm 89 / 65 / ~9.5-24% pass-rate).

## CHK-005: Smoke test replaying the B-f458 signature plus a healthy control

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Create: packages/main/src/tasks/convergence-breaker-smoke.ts
- Modify: package.json (test:convergence-breaker script + include in `test`)
- Test: packages/main/src/tasks/convergence-breaker-smoke.ts

**Verify**:
- `npm run test:convergence-breaker` prints the PASS line and exits 0
- Wired into the aggregate `npm test` script

**DoneWhen**:
- Synthetic story with 89 advances / 131 runs : 31 passes / 65 takeovers trips the breaker on each reason and freezes on re-trip; ack clears it.
- A healthy 8-advance converging control never trips.
- The autopilot self-ack refusal and the gitignored-state assertion both hold.
- Emits a stable `PASS convergence-breaker: ...` marker line for grep/CI.
