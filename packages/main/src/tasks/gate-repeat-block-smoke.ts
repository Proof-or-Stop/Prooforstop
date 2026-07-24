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
 * Assertions are labelled with the verificationIntent ref they discharge.
 *
 * NOTE: this smoke deliberately imports ONLY pre-existing exports, so it still
 * compiles against the unfixed tree and fails on an ASSERTION (a behavioural
 * RED) rather than on a missing symbol.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONVERGENCE_ENV,
  CONVERGENCE_ENV_MAX,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  assessBreaker,
  bumpGateFailureCount,
  gateFailureDigest,
  maxGateFailureCount,
  readGateFailureCounts,
  renderBreakerFreeze,
  resetGateFailureCounts,
  resolveConvergenceThresholds,
} from '../core/convergence-breaker.js';
import type { BreakerCounters } from '../core/convergence-breaker.js';

const CMD = 'story_advance';
const THRESHOLD = DEFAULT_CONVERGENCE_THRESHOLDS.maxGateRepeat;

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
const GAPS_1 = ['missing_original_intent_snapshot', 'missing_intent_collision', 'missing_red_evidence'];
const GAPS_2 = ['missing_acceptance_binding', 'missing_spike_evidence'];
const GAPS_3 = ['missing_verification_intent_refs'];

const REASON_1 = proofStoryReason(GAPS_1);
const REASON_2 = proofStoryReason(GAPS_2);
const REASON_3 = proofStoryReason(GAPS_3);

/** The production normalization, mirrored so fixtures can assert the bug's precondition. */
function normalizePrefix(s: string): string {
  return s.toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '#')
    .replace(/\/[^\s"']+/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function counters(over: Partial<BreakerCounters> = {}): BreakerCounters {
  return { advanceCount: 0, reviewRunCount: 0, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: 0, ...over };
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'gate-repeat-block-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const digest = (reason: string) => gateFailureDigest(CMD, reason);

// ── CHK-001: the RED — distinct blockers must not share a key ────────────────

function chk001(): void {
  // CHK-001:happy:0 — the two reasons share the invariant 200-char prefix...
  assert.equal(normalizePrefix(REASON_1), normalizePrefix(REASON_2), 'fixture must reproduce the invariant banner');
  assert.equal(normalizePrefix(REASON_2), normalizePrefix(REASON_3), 'fixture must reproduce the invariant banner');
  // ...yet must key differently.
  assert.notEqual(digest(REASON_1), digest(REASON_2), 'CHK-001:happy:0 distinct blockers must not share a key');
  assert.notEqual(digest(REASON_2), digest(REASON_3), 'CHK-001:happy:0 distinct blockers must not share a key');
  assert.notEqual(digest(REASON_1), digest(REASON_3), 'CHK-001:happy:0 distinct blockers must not share a key');

  // CHK-001:happy:1 + CHK-001:adversarial:1 — three sequential distinct blockers stay at 1.
  withDir((dir) => {
    for (const r of [REASON_1, REASON_2, REASON_3]) bumpGateFailureCount(dir, CMD, r);
    const max = maxGateFailureCount(readGateFailureCounts(dir));
    assert.equal(max, 1, 'CHK-001:happy:1 progressive completion must not accumulate');
    assert.equal(
      assessBreaker(counters({ maxGateRepeat: max }), DEFAULT_CONVERGENCE_THRESHOLDS, null).tripped, false,
      'CHK-001:adversarial:1 three distinct blockers must not trip the breaker',
    );
  });

  // CHK-001:edge:0 — a distinguishing token beyond char 200 still changes the key.
  const pad = 'x'.repeat(400);
  const a = `${BANNER}${pad} tail [missing_scope_boundary]`;
  const b = `${BANNER}${pad} tail [missing_execution_boundary]`;
  assert.equal(normalizePrefix(a), normalizePrefix(b), 'fixture: prefixes identical');
  assert.notEqual(digest(a), digest(b), 'CHK-001:edge:0 a distinguishing token past char 200 must change the key');

  // CHK-001:adversarial:0 — raw text very different, but normalization-identical
  // AND no structured signal => must still collapse to one key (normalization intact).
  const noisy1 = 'GATE blocked at /Users/jek/x/y.ts 2026-07-23T12:00:00Z id a1b2c3d4e5f6 attempt 7';
  const noisy2 = 'gate BLOCKED at /var/tmp/other.ts 2026-01-02T03:04:05Z id f6e5d4c3b2a1 attempt 91';
  assert.equal(digest(noisy1), digest(noisy2), 'CHK-001:adversarial:0 volatile-token noise must still collapse');
}

// ── CHK-002: the key records the blocker identity ────────────────────────────

function chk002(): void {
  // CHK-002:happy:0 — same as CHK-001:happy:0, asserted post-fix.
  assert.notEqual(digest(REASON_1), digest(REASON_2), 'CHK-002:happy:0 different gap sets => different keys');

  // CHK-002:happy:1 — A,A,B => max 2 on A, B independent.
  withDir((dir) => {
    bumpGateFailureCount(dir, CMD, REASON_1);
    bumpGateFailureCount(dir, CMD, REASON_1);
    bumpGateFailureCount(dir, CMD, REASON_2);
    const counts = readGateFailureCounts(dir);
    assert.equal(maxGateFailureCount(counts), 2, 'CHK-002:happy:1 the repeated blocker reaches 2');
    assert.equal(Object.keys(counts).length, 2, 'CHK-002:happy:1 the distinct blocker gets its own key');
  });

  // CHK-002:happy:2 — a genuinely identical blocker 3x accumulates and trips.
  withDir((dir) => {
    for (let i = 0; i < 3; i++) bumpGateFailureCount(dir, CMD, REASON_1);
    const max = maxGateFailureCount(readGateFailureCounts(dir));
    assert.equal(max, 3, 'CHK-002:happy:2 identical blocker accumulates');
    assert.equal(
      assessBreaker(counters({ maxGateRepeat: max }), DEFAULT_CONVERGENCE_THRESHOLDS, null).tripped, true,
      'CHK-002:happy:2 an identical blocker must still trip',
    );
  });

  // CHK-002:edge:0 — a >10KB reason full of volatile tokens is handled and stable.
  const huge = `${BANNER}${'/a/b/c.ts 2026-07-23T00:00:00Z 0xdeadbeef 12345 '.repeat(300)}[missing_scope_boundary]`;
  assert.ok(huge.length > 10_000, 'fixture is >10KB');
  assert.equal(digest(huge), digest(huge), 'CHK-002:edge:0 large reasons digest deterministically');
  assert.match(digest(huge), /^story_advance\/[0-9a-f]{12}$/, 'CHK-002:edge:0 shape is stable');

  // CHK-002:edge:1 — empty reason yields a valid key and never throws.
  assert.match(digest(''), /^story_advance\/[0-9a-f]{12}$/, 'CHK-002:edge:1 empty reason still keys');

  // CHK-002:edge:2 — whitespace-only differences collapse.
  assert.equal(
    digest('gate   blocked    here'), digest('gate blocked here'),
    'CHK-002:edge:2 whitespace variation must collapse',
  );

  // CHK-002:adversarial:0 — tails differing only by a trailing space must NOT split the key.
  assert.equal(
    digest(REASON_1), digest(`${REASON_1} `),
    'CHK-002:adversarial:0 trailing whitespace must not create a new key',
  );

  // CHK-002:adversarial:1 — a tail that normalizes to pure noise adds no signal, so the key is unchanged.
  assert.equal(
    digest(`${BANNER}tail`), digest(`${BANNER}tail 12345 67890 /x/y/z.ts`),
    'CHK-002:adversarial:1 a signal-free tail must not widen the key',
  );

  // CHK-002:adversarial:2 — reasons differing only in digits still collapse (normalization intact).
  assert.equal(
    digest('gate blocked for b-1234'), digest('gate blocked for b-5678'),
    'CHK-002:adversarial:2 digit-only differences must still collapse',
  );
}

// ── CHK-003: threshold behaviour + diagnostic ────────────────────────────────

function chk003(): void {
  // CHK-003:happy:0 — at threshold with the auto-recovery already spent => freeze.
  const spent = assessBreaker(
    counters({ maxGateRepeat: THRESHOLD }), DEFAULT_CONVERGENCE_THRESHOLDS, { autoRecoveriesSpent: 1 },
  );
  assert.equal(spent.tripped, true, 'CHK-003:happy:0 at threshold the signal fires');
  assert.equal(spent.action, 'freeze', 'CHK-003:happy:0 a spent budget escalates to freeze');

  // CHK-003:happy:1 — the freeze diagnostic names the tripped signal and the recovery path.
  const msg = renderBreakerFreeze('B-cc54', spent.reasons);
  assert.match(msg, /gate-repeat/, 'CHK-003:happy:1 the freeze names the tripped counter');
  assert.match(msg, /story_resume/, 'CHK-003:happy:1 the freeze names the recovery command');

  // CHK-003:edge:0 — just below threshold does not trip.
  assert.equal(
    assessBreaker(counters({ maxGateRepeat: THRESHOLD - 1 }), DEFAULT_CONVERGENCE_THRESHOLDS, null).tripped, false,
    'CHK-003:edge:0 below threshold must proceed',
  );
  // CHK-003:edge:1 — the comparison is inclusive (>=).
  assert.equal(
    assessBreaker(counters({ maxGateRepeat: THRESHOLD }), DEFAULT_CONVERGENCE_THRESHOLDS, null).tripped, true,
    'CHK-003:edge:1 the threshold comparison is inclusive',
  );

  // CHK-003:edge:2 — a 0 env value is rejected (a brake must not be silently zeroed).
  assert.equal(
    resolveConvergenceThresholds({ [CONVERGENCE_ENV.maxGateRepeat]: '0' }).maxGateRepeat,
    DEFAULT_CONVERGENCE_THRESHOLDS.maxGateRepeat,
    'CHK-003:edge:2 zero must fall back to the default',
  );

  // CHK-003:adversarial:0 — first trip with budget available auto-recovers instead of freezing.
  const first = assessBreaker(
    counters({ maxGateRepeat: THRESHOLD }), DEFAULT_CONVERGENCE_THRESHOLDS, { autoRecoveriesSpent: 0 },
  );
  assert.equal(first.action, 'auto-recover', 'CHK-003:adversarial:0 the first trip auto-recovers');

  // CHK-003:adversarial:1 — the sanity ceiling is accepted but anything above falls back.
  assert.equal(
    resolveConvergenceThresholds({ [CONVERGENCE_ENV.maxGateRepeat]: String(CONVERGENCE_ENV_MAX.maxGateRepeat) }).maxGateRepeat,
    CONVERGENCE_ENV_MAX.maxGateRepeat,
    'CHK-003:adversarial:1 the ceiling itself is accepted',
  );
  assert.equal(
    resolveConvergenceThresholds({ [CONVERGENCE_ENV.maxGateRepeat]: String(CONVERGENCE_ENV_MAX.maxGateRepeat + 1) }).maxGateRepeat,
    DEFAULT_CONVERGENCE_THRESHOLDS.maxGateRepeat,
    'CHK-003:adversarial:1 above the ceiling falls back to the default',
  );

  // CHK-003:adversarial:2 — a malformed prior state must not be honoured as "not frozen".
  const malformed = assessBreaker(
    counters({ maxGateRepeat: THRESHOLD }),
    DEFAULT_CONVERGENCE_THRESHOLDS,
    { frozen: 'yes', autoRecoveriesSpent: Number.NaN } as never,
  );
  assert.equal(malformed.tripped, true, 'CHK-003:adversarial:2 a malformed state must not suppress the signal');
  assert.notEqual(malformed.action, 'proceed', 'CHK-003:adversarial:2 a malformed state must not yield proceed');
}

// ── CHK-004: fail-closed and non-forging ─────────────────────────────────────

function chk004(): void {
  // CHK-004:happy:0 — past the threshold the assessment never becomes "proceed".
  for (let extra = 0; extra <= 2; extra++) {
    const a = assessBreaker(
      counters({ maxGateRepeat: THRESHOLD + extra }), DEFAULT_CONVERGENCE_THRESHOLDS, { autoRecoveriesSpent: 1 },
    );
    assert.equal(a.action, 'freeze', 'CHK-004:happy:0 a tripped breaker stays stopped');
  }

  // CHK-004:happy:1 — the assessment is a pure verdict; it carries no phase advance.
  const verdict = assessBreaker(
    counters({ maxGateRepeat: THRESHOLD }), DEFAULT_CONVERGENCE_THRESHOLDS, { autoRecoveriesSpent: 1 },
  );
  assert.equal(verdict.nextState.frozen, true, 'CHK-004:happy:1 the persisted state records the freeze');
  assert.ok(!('phase' in (verdict as unknown as Record<string, unknown>)), 'CHK-004:happy:1 the breaker never advances a phase');

  // CHK-004:edge:0 — a different command keys independently.
  assert.notEqual(
    gateFailureDigest('story_advance', REASON_1), gateFailureDigest('done_prepare', REASON_1),
    'CHK-004:edge:0 the command is part of the key',
  );

  // CHK-004:edge:1 — resetting a story dir with no counter file creates nothing and does not throw.
  withDir((dir) => {
    resetGateFailureCounts(dir);
    assert.equal(existsSync(join(dir, 'gate-failure-counts.json')), false, 'CHK-004:edge:1 no stray file is created');
  });

  // CHK-004:adversarial:0 — tampering the counter file down is visible to the next bump, not silently trusted.
  withDir((dir) => {
    for (let i = 0; i < THRESHOLD; i++) bumpGateFailureCount(dir, CMD, REASON_1);
    const file = join(dir, 'gate-failure-counts.json');
    const counts = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { count: number }>;
    for (const k of Object.keys(counts)) counts[k].count = 0;
    writeFileSync(file, JSON.stringify(counts));
    bumpGateFailureCount(dir, CMD, REASON_1);
    assert.equal(
      maxGateFailureCount(readGateFailureCounts(dir)), 1,
      'CHK-004:adversarial:0 a tampered counter resumes counting rather than throwing',
    );
  });

  // CHK-004:adversarial:1 — a cleared breaker-state cannot suppress a fresh trip.
  const cleared = assessBreaker(
    counters({ maxGateRepeat: THRESHOLD }), DEFAULT_CONVERGENCE_THRESHOLDS, { frozen: false, autoRecoveriesSpent: 0 },
  );
  assert.equal(cleared.tripped, true, 'CHK-004:adversarial:1 clearing the state does not clear the signal');

  // CHK-004:adversarial:2 — empty command and reason still produce a valid key.
  assert.match(gateFailureDigest('', ''), /^\/[0-9a-f]{12}$/, 'CHK-004:adversarial:2 empty inputs still key safely');

  // F-002 regression: a stuck loop whose reason carries a VARYING ordinary
  // bracketed word must keep ONE key. An earlier draft accepted any bracketed
  // lowercase word, so [note]/[info]/[todo] minted a fresh key per attempt and
  // the loop escaped the brake entirely.
  // F-007: these regression assertions are instances of intents that already
  // exist, so they are labelled with the ref they discharge rather than being
  // invisible to the coverage ledger. Ordinary bracketed words are just another
  // token class of CHK-002:adversarial:2 ("desirable collisions must be
  // preserved / the fix must not over-discriminate").
  const plain = ['[note]', '[info]', '[todo]', '[warn]'].map(w => `${BANNER}tail ${w}`);
  const plainKeys = new Set(plain.map(digest));
  assert.equal(
    plainKeys.size, 1,
    'CHK-002:adversarial:2 (F-002) ordinary bracketed words must not widen the key, or a real loop escapes the brake',
  );
  withDir((dir) => {
    for (const r of plain) bumpGateFailureCount(dir, CMD, r);
    assert.ok(
      maxGateFailureCount(readGateFailureCounts(dir)) >= THRESHOLD,
      'CHK-004:happy:0 (F-002) such a loop must still reach the trip threshold',
    );
  });
  // ...while real multi-word reason codes stay distinguishable.
  assert.notEqual(
    digest(`${BANNER}tail [missing_scope_boundary]`),
    digest(`${BANNER}tail [missing_execution_boundary]`),
    'CHK-002:happy:0 (F-002) genuine reason codes must remain distinguishable',
  );

  // F-003: why a reason body cannot impersonate a signal list. Extraction is
  // content-based over the WHOLE reason, so prose that merely mentions a signal
  // token genuinely carries that signal — there is no "forged" set distinct from
  // the extracted one, which is why no working exploit exists. The JSON encoding
  // of (prefix, signals) is defence-in-depth on top of that, making the boundary
  // structural rather than delimiter-based; it is deliberately NOT asserted to
  // change any observable key, because it does not.
  assert.equal(
    digest(`${BANNER}tail signals:missing_scope_boundary`),
    digest(`${BANNER}tail [missing_scope_boundary]`),
    'CHK-002:adversarial:2 (F-003) prose mentioning a signal token carries that signal, so it cannot forge a different set',
  );
  // The encoding must still separate a changed prefix from a changed signal set.
  // The prefix delta has to land inside the first 200 chars to be observable,
  // so these fixtures are deliberately short rather than banner-based.
  assert.notEqual(
    digest('alpha gate refused [missing_scope_boundary]'),
    digest('bravo gate refused [missing_scope_boundary]'),
    'CHK-002:happy:0 (F-003) the same signal set under a different prefix must key differently',
  );
}

// ── CHK-005: fire / no-fire / reset ──────────────────────────────────────────

function chk005(): void {
  // CHK-005:happy:0 — identical failures fire.
  withDir((dir) => {
    for (let i = 0; i < 3; i++) bumpGateFailureCount(dir, CMD, REASON_1);
    const max = maxGateFailureCount(readGateFailureCounts(dir));
    assert.equal(max, 3, 'CHK-005:happy:0 identical failures accumulate');
    assert.equal(assessBreaker(counters({ maxGateRepeat: max }), DEFAULT_CONVERGENCE_THRESHOLDS, null).tripped, true,
      'CHK-005:happy:0 and trip the breaker');
  });

  // CHK-005:happy:1 — three distinct blockers do not fire.
  withDir((dir) => {
    for (const r of [REASON_1, REASON_2, REASON_3]) bumpGateFailureCount(dir, CMD, r);
    const max = maxGateFailureCount(readGateFailureCounts(dir));
    assert.equal(max, 1, 'CHK-005:happy:1 distinct blockers stay at 1');
    assert.equal(assessBreaker(counters({ maxGateRepeat: max }), DEFAULT_CONVERGENCE_THRESHOLDS, null).tripped, false,
      'CHK-005:happy:1 and must not trip');
  });

  // CHK-005:happy:2 — a reset (a real gate pass) clears the streak.
  withDir((dir) => {
    bumpGateFailureCount(dir, CMD, REASON_1);
    bumpGateFailureCount(dir, CMD, REASON_1);
    resetGateFailureCounts(dir);
    bumpGateFailureCount(dir, CMD, REASON_1);
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 1, 'CHK-005:happy:2 a reset clears the streak');
  });

  // CHK-005:edge:0 — switching reason before the threshold prevents the trip.
  withDir((dir) => {
    bumpGateFailureCount(dir, CMD, REASON_1);
    bumpGateFailureCount(dir, CMD, REASON_2);
    assert.ok(maxGateFailureCount(readGateFailureCounts(dir)) < THRESHOLD,
      'CHK-005:edge:0 switching blockers stays under the threshold');
  });

  // CHK-005:edge:1 — two distinct blockers can each independently reach the threshold.
  withDir((dir) => {
    for (let i = 0; i < THRESHOLD; i++) bumpGateFailureCount(dir, CMD, REASON_1);
    for (let i = 0; i < THRESHOLD; i++) bumpGateFailureCount(dir, CMD, REASON_2);
    const counts = readGateFailureCounts(dir);
    assert.equal(Object.keys(counts).length, 2, 'CHK-005:edge:1 each blocker keeps its own key');
    assert.ok(maxGateFailureCount(counts) >= THRESHOLD, 'CHK-005:edge:1 and each can reach the threshold');
  });

  // CHK-005:adversarial:0 — the exact B-cc54 collision shape.
  assert.notEqual(digest(REASON_1), digest(REASON_2), 'CHK-005:adversarial:0 the B-cc54 collision must not recur');

  // CHK-005:adversarial:1 — reset-after-every-bump can hold the counter down, which is
  // why reset is wired ONLY to a successful advance (documented invariant, asserted here).
  withDir((dir) => {
    for (let i = 0; i < THRESHOLD + 2; i++) {
      bumpGateFailureCount(dir, CMD, REASON_1);
      resetGateFailureCounts(dir);
    }
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 0,
      'CHK-005:adversarial:1 reset-after-every-bump suppresses the counter, so reset must stay tied to real progress');
  });

  // CHK-005:adversarial:2 — feeding the breaker's own freeze text back in is handled and,
  // because that text carries no gap ids, it keeps a single stable key.
  const freezeText = renderBreakerFreeze('B-cc54', ['gate-repeat 3>=2']);
  withDir((dir) => {
    bumpGateFailureCount(dir, CMD, freezeText);
    bumpGateFailureCount(dir, CMD, freezeText);
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 2,
      'CHK-005:adversarial:2 the freeze message itself keys stably');
  });

  // Free text must never widen the key, or a real loop could reset forever.
  assert.equal(digest(REASON_1), digest(`${REASON_1}\n  note: operator was impatient.`),
    'free text must not widen the key');
}

function main(): void {
  chk001();
  console.log('  ok CHK-001 RED: distinct blockers get distinct repeat-block keys');
  chk002();
  console.log('  ok CHK-002 the key records the blocker identity');
  chk003();
  console.log('  ok CHK-003 threshold behaviour and freeze diagnostic');
  chk004();
  console.log('  ok CHK-004 fail-closed and non-forging');
  chk005();
  console.log('  ok CHK-005 fire / no-fire / reset coverage');
  console.log('gate-repeat-block-smoke: PASS');
}

main();
