#!/usr/bin/env node
/**
 * B-bbaf CHK-005: convergence + takeover circuit breaker smoke.
 *
 * Replays the B-f458 death-loop signature (89 advances / 131:31 review / 65
 * takeovers) against the pure core and the on-disk state machine, and asserts a
 * healthy converging control never trips. Also covers the fourth signal
 * (repeated-identical-gate-failure), the env-threshold resolver, the human-ack
 * refusal under autopilot, and the gitignored-artifact registration.
 *
 * No CLI spawn: the pure functions are exercised directly, and the I/O helpers
 * against a throwaway temp story dir.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessBreaker,
  resolveConvergenceThresholds,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  resumeBreakerState,
  isInteractiveAckAllowed,
  gateFailureDigest,
  bumpGateFailureCount,
  resetGateFailureCounts,
  readGateFailureCounts,
  maxGateFailureCount,
  readBreakerState,
  writeBreakerState,
  bumpTakeoverCount,
  readTakeoverCount,
  type BreakerCounters,
} from '../core/convergence-breaker.js';
import {
  findRuntimeArtifactEntry,
  isMaterialExcludedRuntimeArtifactPath,
  listRuntimeArtifactIgnorePatterns,
} from '../core/runtime-artifact-registry.js';

const T = DEFAULT_CONVERGENCE_THRESHOLDS;

// The B-f458 storm fixture.
const STORM: BreakerCounters = {
  advanceCount: 89,
  reviewRunCount: 131,
  reviewPassCount: 31,
  takeoverCount: 65,
  maxGateRepeat: 3,
};
// A healthy converging control: 8 advances, passing reviews, ~1 takeover, no repeats.
const HEALTHY: BreakerCounters = {
  advanceCount: 8,
  reviewRunCount: 12,
  reviewPassCount: 11,
  takeoverCount: 1,
  maxGateRepeat: 0,
};

// ── 1. assessBreaker: storm trips on all four reasons; healthy never trips ────
{
  const a = assessBreaker(STORM, resolveConvergenceThresholds({}), null);
  assert.equal(a.tripped, true, 'storm must trip');
  const joined = a.reasons.join(' | ');
  assert.match(joined, /advance-count 89>20/, 'advance reason');
  assert.match(joined, /takeover 65>5/, 'takeover reason');
  assert.match(joined, /pass-rate 31\/131=24%<35%/, 'pass-rate reason');
  assert.match(joined, /gate-repeat 3>=2/, 'gate-repeat reason');
  // Budget available (spent 0) => first trip auto-recovers, does not freeze.
  assert.equal(a.action, 'auto-recover', 'first trip auto-recovers');
  assert.equal(a.nextState.frozen, false, 'first trip not frozen');
  assert.equal(a.nextState.autoRecoveriesSpent, 1, 'recovery spent');
  assert.equal(a.nextState.advanceBaseline, 89, 're-baselined to current advances');
}
{
  const a = assessBreaker(HEALTHY, resolveConvergenceThresholds({}), null);
  assert.equal(a.tripped, false, 'healthy control never trips');
  assert.equal(a.action, 'proceed', 'healthy proceeds');
}

// ── 2. Graduated: first trip auto-recovers, re-trip freezes ───────────────────
{
  const first = assessBreaker(STORM, T, null);
  assert.equal(first.action, 'auto-recover');
  // After re-baseline, advances keep climbing past baseline+maxAdvance -> re-trip.
  const worse: BreakerCounters = { ...STORM, advanceCount: 89 + 25 };
  const second = assessBreaker(worse, T, first.nextState);
  assert.equal(second.action, 'freeze', 're-trip freezes after budget spent');
  assert.equal(second.nextState.frozen, true, 'frozen after re-trip');
  // An already-frozen state stays frozen.
  const third = assessBreaker(worse, T, second.nextState);
  assert.equal(third.action, 'freeze', 'stays frozen');
}

// ── 3. Auto-recovery genuinely rescues a healthy-but-long story ───────────────
{
  // A story that trips once then STOPS growing (delta back under threshold) must
  // not freeze on the next assessment.
  const first = assessBreaker(STORM, T, null); // auto-recover, baseline=89
  const steady: BreakerCounters = { advanceCount: 92, reviewRunCount: 131, reviewPassCount: 130, takeoverCount: 1, maxGateRepeat: 0 };
  const next = assessBreaker(steady, T, first.nextState);
  assert.equal(next.tripped, false, 'after recovery a now-healthy story does not trip');
  assert.equal(next.action, 'proceed');
}

// ── 4. Threshold resolver: defaults, override, typo fallback ──────────────────
{
  assert.equal(resolveConvergenceThresholds({}).maxAdvance, 20, 'default maxAdvance');
  assert.equal(resolveConvergenceThresholds({ LATTICE_CONVERGENCE_MAX_ADVANCE: '5' }).maxAdvance, 5, 'override');
  for (const bad of ['abc', '-1', '1e9', '', '  ']) {
    assert.equal(
      resolveConvergenceThresholds({ LATTICE_CONVERGENCE_MAX_ADVANCE: bad }).maxAdvance,
      20,
      `garbage ${JSON.stringify(bad)} falls back to default`,
    );
  }
  // With MAX_ADVANCE=5 a story trips at 6 advances (delta 6>5) but not at 5.
  const th = resolveConvergenceThresholds({ LATTICE_CONVERGENCE_MAX_ADVANCE: '5' });
  const at5: BreakerCounters = { advanceCount: 5, reviewRunCount: 0, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: 0 };
  const at6: BreakerCounters = { ...at5, advanceCount: 6 };
  assert.equal(assessBreaker(at5, th, null).tripped, false, '5 advances does not trip at MAX_ADVANCE=5');
  assert.equal(assessBreaker(at6, th, null).tripped, true, '6 advances trips at MAX_ADVANCE=5');
}

// ── 5. Pass-rate min-sample gate: low sample never trips ──────────────────────
{
  const lowSample: BreakerCounters = { advanceCount: 0, reviewRunCount: 1, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: 0 };
  assert.equal(assessBreaker(lowSample, T, null).tripped, false, '0/1 (below min-sample) never trips pass-rate');
}

// ── 6. Fail-open on malformed input ───────────────────────────────────────────
{
  const junk = { advanceCount: NaN, reviewRunCount: undefined, reviewPassCount: null, takeoverCount: 'x', maxGateRepeat: Infinity } as unknown as BreakerCounters;
  const a = assessBreaker(junk, T, null);
  assert.equal(a.tripped, false, 'malformed input fails open (no trip, no throw)');
}

// ── 7. Fourth signal: digest grouping, bump-to-threshold, reset ───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-'));
  try {
    // Same command + reason that differs only in volatile ids/numbers => same digest.
    const d1 = gateFailureDigest('story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)');
    const d2 = gateFailureDigest('story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 41)');
    assert.equal(d1, d2, 'digest collapses volatile ids/timestamps/numbers to the same key');
    const d3 = gateFailureDigest('story_advance', 'a completely different failure reason');
    assert.notEqual(d1, d3, 'different reasons yield different digests');

    // Two failures with the same digest => count 2 => trips gate-repeat.
    bumpGateFailureCount(dir, 'story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)');
    bumpGateFailureCount(dir, 'story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 41)');
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 2, 'same-reason repeats accumulate to 2');
    const trip: BreakerCounters = { advanceCount: 0, reviewRunCount: 0, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: maxGateFailureCount(readGateFailureCounts(dir)) };
    assert.equal(assessBreaker(trip, T, null).tripped, true, 'gate-repeat 2>=2 trips');

    // Two DIFFERENT reasons stay at 1 each and do not trip.
    resetGateFailureCounts(dir);
    bumpGateFailureCount(dir, 'story_advance', 'reason ALPHA');
    bumpGateFailureCount(dir, 'story_advance', 'reason BETA');
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 1, 'distinct reasons do not accumulate');

    // Reset (as on a successful advance) clears the counter.
    resetGateFailureCounts(dir);
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 0, 'reset clears the gate-failure counter');

    // Missing file fails open to 0.
    const emptyDir = mkdtempSync(join(tmpdir(), 'cbreaker-empty-'));
    assert.equal(maxGateFailureCount(readGateFailureCounts(emptyDir)), 0, 'missing counter file reads as 0');
    rmSync(emptyDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 8. State + takeover I/O round-trip ────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-io-'));
  try {
    assert.equal(readBreakerState(dir), null, 'no state file => null');
    assert.equal(readTakeoverCount(dir), 0, 'no takeover file => 0');
    bumpTakeoverCount(dir);
    bumpTakeoverCount(dir);
    assert.equal(readTakeoverCount(dir), 2, 'takeover counter increments');

    const frozen = assessBreaker({ ...STORM, advanceCount: 200 }, T, { advanceBaseline: 0, autoRecoveriesSpent: 1, frozen: false, trippedReasons: [] });
    assert.equal(frozen.action, 'freeze');
    writeBreakerState(dir, frozen.nextState);
    const round = readBreakerState(dir);
    assert.ok(round && round.frozen === true, 'frozen state round-trips');

    // Ack clears it.
    const resumed = resumeBreakerState(round, { advanceCount: 200 });
    assert.equal(resumed.frozen, false, 'resume clears frozen');
    assert.equal(resumed.autoRecoveriesSpent, 0, 'resume restores the recovery budget');
    assert.equal(resumed.advanceBaseline, 200, 'resume re-baselines to current advances');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 9. Human-ack refusal under autopilot / non-interactive ────────────────────
{
  assert.equal(isInteractiveAckAllowed({}, true), true, 'interactive TTY, no autopilot => allowed');
  assert.equal(isInteractiveAckAllowed({}, false), false, 'no TTY => refused');
  assert.equal(isInteractiveAckAllowed({ LATTICE_AUTOPILOT: '1' }, true), false, 'autopilot marker => refused even at a TTY');
  assert.equal(isInteractiveAckAllowed({ CI: 'true' }, true), false, 'CI marker => refused');
  assert.equal(isInteractiveAckAllowed({ LATTICE_AUTOPILOT: '0' }, true), true, 'falsey autopilot marker => allowed');
}

// ── 10. Gitignored-artifact registration (F-008 DONE-merge safety) ────────────
{
  for (const f of ['breaker-state.json', 'takeover-count.json', 'gate-failure-counts.json']) {
    const entry = findRuntimeArtifactEntry(`.lattice/story/actives/B-bbaf/${f}`);
    assert.ok(entry, `${f} is registered as a runtime artifact`);
    assert.equal(isMaterialExcludedRuntimeArtifactPath(`.lattice/story/actives/B-bbaf/${f}`), true, `${f} is material-hash excluded`);
  }
  const patterns = listRuntimeArtifactIgnorePatterns();
  for (const glob of ['**/breaker-state.json', '**/takeover-count.json', '**/gate-failure-counts.json']) {
    assert.ok(patterns.includes(glob), `ignore pattern ${glob} is listed`);
  }
}

console.log('PASS convergence-breaker: storm trips 4 signals + auto-recover->freeze->ack, healthy control clean, gate-repeat digest/reset, thresholds, autopilot refusal, gitignored state');
