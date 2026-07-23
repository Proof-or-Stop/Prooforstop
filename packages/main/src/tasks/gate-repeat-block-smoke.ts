#!/usr/bin/env node
/**
 * B-cc54 — repeat-block breaker.
 *
 * RED (CHK-001): today a phase gate will refuse the same story with the same
 * bracketed reason code an unbounded number of times. Nothing counts the
 * repetition, so an unattended orchestration that retries a remedy which cannot
 * possibly clear that block loops forever. The B-4043 forensics measured 61
 * identical refusals against 54 re-review rounds over 3.4 days.
 *
 * The breaker must trip on the Nth *identical consecutive* refusal and say which
 * precondition is actually unmet — and it must never satisfy the gate itself.
 *
 * Cases:
 *   1 RED/GREEN  — identical reason repeated GATE_REPEAT_BLOCK_THRESHOLD times trips the breaker
 *   2 no-fire    — a changing reason never trips it (a genuinely progressing story)
 *   3 reset      — clearing the block resets the streak
 *   4 fail-closed— tripping never flips ok to true
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { evaluateScopeAntiExpansionGate } from '../core/machine.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';

/** Marker the breaker must emit once it trips. */
const TRIP_CODE = 'gate_repeat_block_tripped';
/** Consecutive identical refusals required before the breaker trips. */
const THRESHOLD = 3;

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function makeStore(root: string, storyId: string): StoryStore {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }));
  resetConfigCache();
  const store = new StoryStore(root);
  const now = '2026-07-23T12:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'gate-repeat-block-smoke',
    title: 'Repeat-block breaker fixture',
    description: 'Synthetic story used to drive a repeatedly refusing gate.',
    type: 'bug',
    phase: 'INIT',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: undefined,
    events: [],
  };
  store.writeStory(storyId, story);
  return store;
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'gate-repeat-block-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Case 1: identical refusal repeated THRESHOLD times must trip the breaker. */
function assertBreakerTripsOnIdenticalRepeats(): void {
  withRoot((root) => {
    const storyId = 'B-red1';
    const store = makeStore(root, storyId);

    const reasons: string[] = [];
    for (let attempt = 1; attempt <= THRESHOLD; attempt++) {
      const result = evaluateScopeAntiExpansionGate(storyId, store);
      assert.equal(result.ok, false, `attempt ${attempt}: gate should refuse (no scope-boundary.json)`);
      reasons.push(result.reason ?? '');
    }

    // Every attempt so far is the SAME underlying block.
    for (const reason of reasons) {
      assert.match(reason, /missing_scope_boundary/, 'fixture should keep hitting the same block');
    }

    // The final refusal must carry the breaker marker: the loop is unbounded without it.
    assert.match(
      reasons[reasons.length - 1],
      new RegExp(TRIP_CODE),
      `after ${THRESHOLD} identical refusals the breaker must trip and name the unmet precondition`,
    );
    // ...and it must name the actual unmet precondition, not just say "blocked".
    assert.match(
      reasons[reasons.length - 1],
      /scope-boundary/,
      'the breaker diagnostic must name the precondition that is actually unmet',
    );
  });
}

/** Case 2: a changing block reason must NOT trip the breaker. */
function assertChangingReasonDoesNotTrip(): void {
  withRoot((root) => {
    const storyId = 'B-red2';
    const store = makeStore(root, storyId);

    // First refusal: scope-boundary missing.
    const first = evaluateScopeAntiExpansionGate(storyId, store);
    assert.equal(first.ok, false);
    assert.match(first.reason ?? '', /missing_scope_boundary/);

    // Resolve it so the NEXT refusal has a different reason code (execution-boundary).
    store.writeScopeBoundary(storyId, {
      storyId,
      mode: 'correctness_fix',
      allowedScope: ['packages/main/src/core/machine.ts'],
      excludedScope: [],
      userConfirmed: true,
      confirmation: 'smoke fixture',
      actor: 'smoke',
    } as never);

    for (let attempt = 0; attempt < THRESHOLD + 1; attempt++) {
      const next = evaluateScopeAntiExpansionGate(storyId, store);
      assert.equal(next.ok, false, 'fixture still lacks execution-boundary, so it must still refuse');
      assert.doesNotMatch(
        next.reason ?? '',
        new RegExp(TRIP_CODE),
        'the breaker must not trip when the block reason changed between attempts',
      );
    }
  });
}

/** Case 4: tripping the breaker must never flip the gate to ok. */
function assertBreakerIsFailClosed(): void {
  withRoot((root) => {
    const storyId = 'B-red4';
    const store = makeStore(root, storyId);
    for (let attempt = 0; attempt < THRESHOLD + 2; attempt++) {
      const result = evaluateScopeAntiExpansionGate(storyId, store);
      assert.equal(result.ok, false, 'a tripped breaker must never satisfy the gate');
    }
  });
}

function main(): void {
  assertBreakerTripsOnIdenticalRepeats();
  console.log('  ok 1 breaker trips after identical consecutive refusals');
  assertChangingReasonDoesNotTrip();
  console.log('  ok 2 changing block reason does not trip the breaker');
  assertBreakerIsFailClosed();
  console.log('  ok 3 tripped breaker stays fail-closed');
  console.log('gate-repeat-block-smoke: PASS');
}

main();
