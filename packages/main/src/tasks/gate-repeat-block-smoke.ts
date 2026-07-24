#!/usr/bin/env node
/**
 * B-cc54 — the repeat-block breaker must key on the ACTUAL blocker.
 *
 * A repeat-block breaker already exists (B-bbaf): it counts same-(command,reason)
 * gate failures and freezes the story at the threshold. The defect is its dedup
 * key. gateFailureDigest normalizes the reason and then hashes only the first 200
 * characters. For a structured gate failure that prefix is an invariant banner,
 * while the part naming WHICH precondition is unmet sits far beyond it — and
 * digit normalization erases the rest.
 *
 * Reproduced on B-cc54 itself: three different blockers (missing intent snapshot
 * -> missing acceptance binding -> missing verificationIntentRefs) all collapsed
 * onto ONE key, so fixing one precondition at a time was misread as a stuck loop
 * and froze the story. Clearing that freeze requires an interactive human ack,
 * which an unattended run can never obtain — so a false positive here is exactly
 * the "needs a human" failure this story exists to remove.
 *
 * Cases:
 *   1 progress resets  — same banner, DIFFERENT gap set => different key   (the bug)
 *   2 real loop trips  — identical blocker repeated      => same key, accumulates
 *   3 back-compat      — unstructured reasons keep the historical prefix key
 *   4 fail-closed      — a genuinely stuck loop still reaches the threshold
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// NOTE: this smoke deliberately imports ONLY pre-existing exports, so it still
// compiles against the unfixed tree and fails on an ASSERTION (a behavioural
// RED) rather than on a missing symbol.
import {
  DEFAULT_CONVERGENCE_THRESHOLDS,
  bumpGateFailureCount,
  gateFailureDigest,
  maxGateFailureCount,
  readGateFailureCounts,
} from '../core/convergence-breaker.js';

/** The invariant banner every ProofStory DEV-gate refusal starts with. */
const BANNER =
  'Cannot enter DEV: ProofStory DEV gate is enforce and required intent artifacts are incomplete.\n'
  + 'ProofStory diagnostics for B-cc54\nMode: enforce\nStatus: fail\nBlocking: yes\n'
  + 'Hardening level: high_assurance\nLedger: missing, 0/5 milestone threshold (within_threshold)\n'
  + 'Trigger reasons (6):\n'
  + '  - high_assurance_risk: High-risk or gate/security wording selects high-assurance intent hardening.\n'
  + '  - collision_required_high_assurance: High-assurance work requires an independent intent-collision result.\n'
  + '  - red_evidence_required: Bug, regression, or explicit behavior-change work should have red evidence.\n';

function proofStoryReason(gaps: string[]): string {
  return `${BANNER}Diagnostic gaps (${gaps.length}):\n`
    + gaps.map(g => `  - ${g} [warn; proofstory.json]: this precondition is not satisfied.`).join('\n');
}

/** The three real blockers B-cc54 hit, in the order it hit them. */
const GAPS_ROUND_1 = ['missing_original_intent_snapshot', 'missing_intent_collision', 'missing_red_evidence'];
const GAPS_ROUND_2 = ['missing_acceptance_binding', 'missing_spike_evidence'];
const GAPS_ROUND_3 = ['missing_verification_intent_refs'];

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'gate-repeat-block-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Case 1: the bug. Same banner, different gap set => the key MUST differ. */
function assertProgressResetsTheKey(): void {
  const r1 = proofStoryReason(GAPS_ROUND_1);
  const r2 = proofStoryReason(GAPS_ROUND_2);
  const r3 = proofStoryReason(GAPS_ROUND_3);

  // Precondition of the bug: the first 200 normalized chars really are identical.
  const norm = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
  assert.equal(norm(r1), norm(r2), 'fixture must reproduce the invariant 200-char banner');
  assert.equal(norm(r2), norm(r3), 'fixture must reproduce the invariant 200-char banner');

  const d1 = gateFailureDigest('story_advance', r1);
  const d2 = gateFailureDigest('story_advance', r2);
  const d3 = gateFailureDigest('story_advance', r3);
  assert.notEqual(d1, d2, 'different unmet preconditions must not share a repeat-block key');
  assert.notEqual(d2, d3, 'different unmet preconditions must not share a repeat-block key');
  assert.notEqual(d1, d3, 'different unmet preconditions must not share a repeat-block key');

  // End to end: progressive completion must never accumulate toward a trip.
  withDir((dir) => {
    bumpGateFailureCount(dir, 'story_advance', r1);
    bumpGateFailureCount(dir, 'story_advance', r2);
    bumpGateFailureCount(dir, 'story_advance', r3);
    assert.equal(
      maxGateFailureCount(readGateFailureCounts(dir)), 1,
      'progressive artifact completion must not look like a repeat loop',
    );
    assert.ok(
      1 < DEFAULT_CONVERGENCE_THRESHOLDS.maxGateRepeat,
      'and must stay strictly under the trip threshold',
    );
  });
}

/** Case 2 + 4: an identical blocker still accumulates and still reaches the threshold. */
function assertRealLoopStillTrips(): void {
  const stuck = proofStoryReason(GAPS_ROUND_1);
  assert.equal(
    gateFailureDigest('story_advance', stuck),
    gateFailureDigest('story_advance', proofStoryReason([...GAPS_ROUND_1])),
    'the same blocker must produce a stable key regardless of array identity',
  );

  withDir((dir) => {
    const threshold = DEFAULT_CONVERGENCE_THRESHOLDS.maxGateRepeat;
    for (let i = 0; i < threshold; i++) bumpGateFailureCount(dir, 'story_advance', stuck);
    assert.ok(
      maxGateFailureCount(readGateFailureCounts(dir)) >= threshold,
      'a genuinely stuck loop must still reach the trip threshold (fail-closed)',
    );
  });
}

/** Case 3: reasons carrying no structured signal keep the historical behaviour. */
function assertUnstructuredReasonsUnchanged(): void {
  const a = 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)';
  const b = 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 41)';
  assert.equal(
    gateFailureDigest('story_advance', a),
    gateFailureDigest('story_advance', b),
    'timestamp/counter noise must still collapse to one key',
  );
  assert.notEqual(
    gateFailureDigest('story_advance', a),
    gateFailureDigest('story_advance', 'a completely different failure reason'),
    'genuinely different unstructured reasons must still differ',
  );
}

/** Adversarial: the widening must come from the blocker set, not from free text. */
function assertKeyIsNotWidenedByFreeText(): void {
  const base = proofStoryReason(GAPS_ROUND_1);
  const chatty = `${base}\n  note: retried at a different moment, operator was impatient.`;
  assert.equal(
    gateFailureDigest('story_advance', base),
    gateFailureDigest('story_advance', chatty),
    'appending free text must not change the key (otherwise a real loop could reset forever)',
  );
}

function main(): void {
  assertProgressResetsTheKey();
  console.log('  ok 1 different unmet preconditions get different repeat-block keys');
  assertRealLoopStillTrips();
  console.log('  ok 2 an identical blocker still accumulates to the trip threshold');
  assertUnstructuredReasonsUnchanged();
  console.log('  ok 3 unstructured reasons keep the historical prefix key');
  assertKeyIsNotWidenedByFreeText();
  console.log('  ok 4 free text does not widen the key (no reset-forever hole)');
  console.log('gate-repeat-block-smoke: PASS');
}

main();
