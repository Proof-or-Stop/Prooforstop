# Plan: B-cfdd Soft REVIEW convergence-stall advisory

> **Scope.** Add a SOFT, advisory-only detector that warns when REVIEW rounds keep cycling without
> converging (recent rounds show no downward trend in blocking findings) past a threshold. It appends
> an English advisory + escalation hint to the `story_advance REVIEW` output and MUST NEVER block a
> transition. Decision **Option C**. Reuse existing helpers (`resolveReviewRoundCount`,
> `isFindingBlocking`, `effectiveBlockingSeverities`) — do not duplicate round/blocking logic.
> Thresholds are module constants (no CLI/config). All artifacts and the advisory string are English-only.

## CHK-001: Per-round inputs accessor (round count + per-round blocking counts)

**Owner**: lattice-implementer  **DependsOn**: none
**Files**:
- Reuse `resolveReviewRoundCount(store, storyId)` from `packages/main/src/core/advisory.ts` for the round count (already exists).
- Add a read-only accessor (in `core/review-convergence.ts` new, or extend `advisory.ts`) returning `{ roundCount, perRoundBlockingCounts: number[] }`: group the story's findings by `reviewRound`, and for each round count the findings that are blocking via `isFindingBlocking` + the round's `effectiveBlockingSeverities` (from `guard-utils.ts resolveEffectiveBlockingSeverities`). Order the array by round.

**Verify**:
- A smoke / unit drives a synthetic store and asserts roundCount + the ordered per-round blocking array match expectations.
- Single-round / no-finding story → roundCount=1, no spurious entries.

**DoneWhen**:
- Accessor returns correct round count (reusing the existing helper) and per-round blocking counts derived from the canonical blocking decision, with no duplicated round/blocking logic.

## CHK-002: Pure assessReviewConvergence + thresholds + English message builder

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**:
- In the same module: `export function assessReviewConvergence(roundCount: number, perRoundBlockingCounts: number[]): { stalled: boolean; message?: string }`. Pure, no I/O.
- Module constants `STALL_MIN_ROUNDS` (e.g. 4) and `STALL_WINDOW` (e.g. 3).
- Heuristic (trend-based, NOT a raw ceiling): `stalled = roundCount >= STALL_MIN_ROUNDS && lastWindowShowsNoDownwardTrend(perRoundBlockingCounts, STALL_WINDOW)` where "no downward trend" means the recent window's blocking counts are not strictly decreasing toward 0 (still surfacing new blockers).
- `message` is English-only and includes both escalation hints (Debugging Contract escalation + dismiss-don't-re-round).

**Verify**:
- `stalled=true` for [2,2,1] at round 4 (with English message); `stalled=false` for [2,1,0]; `stalled=false` when roundCount < STALL_MIN_ROUNDS.

**DoneWhen**:
- Pure function returns correct verdicts for healthy-decreasing / stalled / below-threshold series; thresholds are module constants; message English-only.

## CHK-003: Wire the advisory into REVIEW-entry output + smoke (non-blocking)

**Owner**: lattice-implementer  **DependsOn**: CHK-002
**Files**:
- In `packages/main/src/handlers/transition-effects.ts`, at the REVIEW-entry output (where "Active reviewers" / "launch in parallel" is printed): call the accessor + `assessReviewConvergence`, and when `stalled`, append `message` to the output. Optionally one line in `session_brief` REVIEW rendering.
- Add a smoke (`packages/main/src/tasks/*-smoke.ts` style) covering: (a) healthy decreasing -> no advisory, (b) stalled flat/rising -> advisory, (c) below STALL_MIN_ROUNDS -> no advisory, (d) single clean round -> no advisory; AND assert that with the advisory present, a REVIEW->TEST transition still succeeds (advisory-only). Wire `test:*` into `packages/main/package.json` and into the root test chain so `lattice validate` runs it.

**Verify**:
- `npm --prefix packages/main run build` clean; the new smoke passes; `lattice validate` green with the smoke invoked.
- Manual: re-entering REVIEW on a stalled story shows the advisory; the same story still advances to TEST.

**DoneWhen**:
- Advisory appears only on stalled stories, never on healthy/below-threshold ones; REVIEW->TEST still succeeds with the advisory present (proven non-blocking); smoke wired into validate.
