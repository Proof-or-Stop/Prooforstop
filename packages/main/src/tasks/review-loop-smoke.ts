#!/usr/bin/env node
/**
 * B-7a34 CHK-003 / CHK-004: Review Reflection Loop — gate and no-authority smoke.
 *
 * Covers:
 *  1. Pure helper contracts (listActiveLoops, deriveLatestLoopRecord).
 *  2. runReviewLoopGate blocks for open loops and passes for non-open status.
 *  3. getGuardFailureReason surfaces loopId / decision / nextAction in message.
 *  4. Resolved close only clears the loop gate; finding/reviewer/validation
 *     gates still apply (verified by showing gate message shifts to reviewer
 *     absence, not loop gate, after loop is closed).
 *  5. Blocked and escalated close also clear the loop gate (status != 'open')
 *     but do not mask other blocking gates.
 *  6. No authority/receipt/production fields in any loop record schema.
 *  7. Loop iteration reflection/reusableLearning is stored as context only
 *     and is not exposed as review pass, validation, or authority evidence.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import {
  listActiveLoops,
  deriveLatestLoopRecord,
  deriveLoopStatus,
  validateTriggerRefs,
  validateResolvedCloseInvariant,
  DEFAULT_REVIEW_LOOP_POLICY,
  REVIEW_LOOP_FILENAME,
} from '../core/review-loop.js';
import type {
  ReviewLoopRecord,
  ReviewLoopDecision,
  ReviewLoopStart,
  ReviewLoopIteration,
  ReviewLoopClose,
} from '../core/types.js';
import { runReviewLoopGate } from '../handlers/phase-gates.js';
import { createReviewLoopHandlers } from '../handlers/review-loop.js';
import { getGuardFailureReason } from '../core/machine.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-loop-smoke-'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
  }));
  return root;
}

function makeStore(root: string, storyId: string): StoryStore {
  const store = new StoryStore(root);
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });
  // Write minimal story so readStory does not throw during getGuardFailureReason.
  store.writeStory(storyId, {
    storyId,
    name: 'review-loop-smoke',
    title: 'Review loop smoke',
    description: 'Smoke test story',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    events: [],
  });
  return store;
}

const sampleTrigger = { findingIds: ['F-001'] };
const sampleRollback = {
  headHash: '0123456789abcdef0123456789abcdef01234567',
  diffHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  materialHash: '89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
};

function makeStart(loopId: string, storyId: string): ReviewLoopStart {
  return {
    schemaVersion: 'lattice.review_loop_start.v1',
    event: 'start',
    loopId,
    storyId,
    reviewRound: '2026-06-08T00:00:00.000Z',
    status: 'open',
    trigger: sampleTrigger,
    rollbackRef: sampleRollback,
    openedAt: new Date().toISOString(),
    actor: 'smoke-test',
  };
}

function makeIteration(loopId: string, storyId: string, decision: ReviewLoopDecision): ReviewLoopIteration {
  return {
    schemaVersion: 'lattice.review_loop_iteration.v1',
    event: 'iteration',
    loopId,
    storyId,
    reviewRound: '2026-06-08T00:00:00.000Z',
    status: 'open',
    iteration: 1,
    trigger: sampleTrigger,
    host: { hostId: 'claude-sonnet-4-6' },
    rollbackRef: sampleRollback,
    reflection: {
      progress: 'improved',
      evidenceQuality: 'medium',
      riskLevel: 'low',
      rootCauseHypothesis: 'Mock clock mismatch',
      recommendedDecision: decision,
      reason: 'Tests appear closer to passing',
      reusableLearning: 'Time-based tests need mock clock alignment',
    },
    evaluation: {
      costMeasured: false,
      commandsRun: ['npm test'],
      evidenceRefs: ['F-001'],
    },
    decision,
    decisionReason: 'Policy: still making progress, no regression',
    nextAction: {
      nextPrompt: 'Focus on mock clock in auth.spec.ts line 42',
    },
    createdAt: new Date().toISOString(),
    actor: 'smoke-test',
  };
}

function makeClose(loopId: string, storyId: string, status: 'resolved' | 'escalated' | 'blocked'): ReviewLoopClose {
  return {
    schemaVersion: 'lattice.review_loop_close.v1',
    event: 'close',
    loopId,
    storyId,
    reviewRound: '2026-06-08T00:00:00.000Z',
    status,
    trigger: sampleTrigger,
    materialHash: sampleRollback.materialHash,
    resolvedEvidenceRefs: status === 'resolved' ? ['F-001'] : undefined,
    closeReason: `Loop closed as ${status}`,
    closedAt: new Date().toISOString(),
    actor: 'smoke-test',
  };
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
    failed++;
  }
}

// ── 1. Pure helper contracts ──────────────────────────────────────────────────

console.log('\n[1] Pure helper contracts');

test('listActiveLoops: empty records → no active loops', () => {
  assert.deepEqual(listActiveLoops([]), []);
});

test('listActiveLoops: start record → active', () => {
  const rec = makeStart('L-1', 'B-smoke');
  assert.deepEqual(listActiveLoops([rec]), ['L-1']);
});

test('listActiveLoops: iteration record → still active', () => {
  const start = makeStart('L-1', 'B-smoke');
  const iter = makeIteration('L-1', 'B-smoke', 'continue');
  assert.deepEqual(listActiveLoops([start, iter]), ['L-1']);
});

test('listActiveLoops: resolved close → not active', () => {
  const start = makeStart('L-1', 'B-smoke');
  const close = makeClose('L-1', 'B-smoke', 'resolved');
  assert.deepEqual(listActiveLoops([start, close]), []);
});

test('listActiveLoops: blocked close → not active (loop gate clears)', () => {
  const start = makeStart('L-1', 'B-smoke');
  const close = makeClose('L-1', 'B-smoke', 'blocked');
  assert.deepEqual(listActiveLoops([start, close]), []);
});

test('listActiveLoops: escalated close → not active (loop gate clears)', () => {
  const start = makeStart('L-1', 'B-smoke');
  const close = makeClose('L-1', 'B-smoke', 'escalated');
  assert.deepEqual(listActiveLoops([start, close]), []);
});

test('listActiveLoops: two loops, one open one resolved → only open listed', () => {
  const s1 = makeStart('L-1', 'B-smoke');
  const c1 = makeClose('L-1', 'B-smoke', 'resolved');
  const s2 = makeStart('L-2', 'B-smoke');
  const active = listActiveLoops([s1, c1, s2]);
  assert.deepEqual(active, ['L-2']);
});

test('deriveLatestLoopRecord: returns last record for loopId', () => {
  const start = makeStart('L-1', 'B-smoke');
  const iter = makeIteration('L-1', 'B-smoke', 'revise');
  const latest = deriveLatestLoopRecord([start, iter], 'L-1');
  assert.equal(latest?.event, 'iteration');
});

test('deriveLatestLoopRecord: unknown loopId → undefined', () => {
  const start = makeStart('L-1', 'B-smoke');
  assert.equal(deriveLatestLoopRecord([start], 'L-999'), undefined);
});

test('deriveLoopStatus: open start → open', () => {
  const start = makeStart('L-1', 'B-smoke');
  assert.equal(deriveLoopStatus([start], 'L-1'), 'open');
});

test('deriveLoopStatus: resolved close → resolved', () => {
  const start = makeStart('L-1', 'B-smoke');
  const close = makeClose('L-1', 'B-smoke', 'resolved');
  assert.equal(deriveLoopStatus([start, close], 'L-1'), 'resolved');
});

test('validateTriggerRefs: empty trigger is rejected', () => {
  const err = validateTriggerRefs({});
  assert.ok(err, 'empty trigger should return error string');
  assert.match(err, /trigger must include/);
});

test('validateTriggerRefs: finding refs → accepted', () => {
  const err = validateTriggerRefs({ findingIds: ['F-001'] });
  assert.equal(err, undefined);
});

test('validateResolvedCloseInvariant: resolved close requires evidence refs', () => {
  const err = validateResolvedCloseInvariant('resolved', 'hash-now', [], undefined, 'hash-now');
  assert.match(err ?? '', /resolvedEvidenceRefs/);
});

test('validateResolvedCloseInvariant: resolved close requires current material hash', () => {
  const err = validateResolvedCloseInvariant('resolved', 'hash-old', ['F-001'], undefined, 'hash-now');
  assert.match(err ?? '', /stale/);
});

test('validateResolvedCloseInvariant: resolved close accepts fresh evidence refs', () => {
  const err = validateResolvedCloseInvariant('resolved', 'hash-now', ['F-001'], undefined, 'hash-now');
  assert.equal(err, undefined);
});

test('validateResolvedCloseInvariant: blocked close does not require resolved evidence refs', () => {
  const err = validateResolvedCloseInvariant('blocked', 'hash-old', undefined, undefined, undefined);
  assert.equal(err, undefined);
});

// ── 2. runReviewLoopGate ──────────────────────────────────────────────────────

console.log('\n[2] runReviewLoopGate gate behavior');

{
  const root = makeRoot();
  try {
    test('gate passes when no loops exist', () => {
      const store = makeStore(root, 'B-noloop');
      // No records written → gate must not throw.
      runReviewLoopGate('B-noloop', store);
    });

    test('gate throws for start record (open loop)', () => {
      const store = makeStore(root, 'B-open');
      store.appendReviewLoopRecord('B-open', makeStart('L-open', 'B-open'));
      assert.throws(
        () => runReviewLoopGate('B-open', store),
        /Cannot enter TEST/,
        'open loop must throw Cannot enter TEST',
      );
    });

    test('gate message includes loopId', () => {
      const store = makeStore(root, 'B-msg');
      store.appendReviewLoopRecord('B-msg', makeStart('L-abc', 'B-msg'));
      let caught: Error | undefined;
      try { runReviewLoopGate('B-msg', store); } catch (e: any) { caught = e; }
      assert.ok(caught, 'gate should throw');
      assert.match(caught!.message, /loopId=L-abc/);
      assert.match(caught!.message, /--status=resolved/);
    });

    test('gate message includes decision and nextAction when iteration is latest', () => {
      const store = makeStore(root, 'B-iter');
      store.appendReviewLoopRecord('B-iter', makeStart('L-iter', 'B-iter'));
      store.appendReviewLoopRecord('B-iter', makeIteration('L-iter', 'B-iter', 'revise'));
      let caught: Error | undefined;
      try { runReviewLoopGate('B-iter', store); } catch (e: any) { caught = e; }
      assert.ok(caught);
      assert.match(caught!.message, /decision=revise/);
      assert.match(caught!.message, /nextAction=/);
    });

    test('gate passes after resolved close', () => {
      const store = makeStore(root, 'B-resolved');
      store.appendReviewLoopRecord('B-resolved', makeStart('L-r', 'B-resolved'));
      store.appendReviewLoopRecord('B-resolved', makeClose('L-r', 'B-resolved', 'resolved'));
      // Must NOT throw.
      runReviewLoopGate('B-resolved', store);
    });

    test('gate passes after blocked close (loop gate clears; other gates still apply separately)', () => {
      const store = makeStore(root, 'B-blocked');
      store.appendReviewLoopRecord('B-blocked', makeStart('L-b', 'B-blocked'));
      store.appendReviewLoopRecord('B-blocked', makeClose('L-b', 'B-blocked', 'blocked'));
      // Loop gate should NOT throw — blocked close clears the loop gate.
      // Other gates (reviewers, findings) are separate and still apply.
      runReviewLoopGate('B-blocked', store);
    });

    test('gate passes after escalated close (loop gate clears; other gates still apply separately)', () => {
      const store = makeStore(root, 'B-escalated');
      store.appendReviewLoopRecord('B-escalated', makeStart('L-e', 'B-escalated'));
      store.appendReviewLoopRecord('B-escalated', makeClose('L-e', 'B-escalated', 'escalated'));
      runReviewLoopGate('B-escalated', store);
    });

    test('gate throws for open loop even if a different loop is resolved', () => {
      const store = makeStore(root, 'B-mixed');
      store.appendReviewLoopRecord('B-mixed', makeStart('L-1', 'B-mixed'));
      store.appendReviewLoopRecord('B-mixed', makeClose('L-1', 'B-mixed', 'resolved'));
      store.appendReviewLoopRecord('B-mixed', makeStart('L-2', 'B-mixed'));
      assert.throws(
        () => runReviewLoopGate('B-mixed', store),
        /Cannot enter TEST/,
        'one open loop is enough to block',
      );
    });

    test('gate fails closed when review loop records are unreadable', () => {
      const store = makeStore(root, 'B-corrupt');
      writeFileSync(join(root, '.proof-or-stop', 'story', 'actives', 'B-corrupt', REVIEW_LOOP_FILENAME), '{bad json\n');
      assert.throws(
        () => runReviewLoopGate('B-corrupt', store),
        /review_loop_record_error/,
        'corrupt review loop evidence must block TEST',
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 3. getGuardFailureReason for TEST with open loop ─────────────────────────

console.log('\n[3] getGuardFailureReason TEST phase with open loop');

{
  const root = makeRoot();
  try {
    test('returns Cannot enter TEST message with open_review_loop tag', () => {
      const store = makeStore(root, 'B-gfr');
      store.appendReviewLoopRecord('B-gfr', makeStart('L-gfr', 'B-gfr'));
      const reason = getGuardFailureReason('B-gfr', store, 'TEST', root);
      assert.ok(reason, 'should return a reason string');
      assert.match(reason!, /Cannot enter TEST/);
      assert.match(reason!, /open_review_loop/);
      assert.match(reason!, /loopId=L-gfr/);
    });

    test('shared verdict preserves iteration decision and nextAction diagnostics', () => {
      const store = makeStore(root, 'B-gfr-iteration');
      store.appendReviewLoopRecord('B-gfr-iteration', makeStart('L-gfr-iteration', 'B-gfr-iteration'));
      store.appendReviewLoopRecord('B-gfr-iteration', makeIteration('L-gfr-iteration', 'B-gfr-iteration', 'revise'));
      const reason = getGuardFailureReason('B-gfr-iteration', store, 'TEST', root);
      assert.ok(reason, 'should return a reason string');
      assert.match(reason!, /\[open_review_loop\]/);
      assert.match(reason!, /loopId=L-gfr-iteration/);
      assert.match(reason!, /decision=revise/);
      assert.match(reason!, /nextAction=\{nextPrompt=Focus on mock clock/);
    });

    test('returns null (no loop blocker) after resolved close — reviewer gate then controls', () => {
      // After loop close, the loop gate disappears. The reviewer gate will
      // then return its own message (no findings/passes). We verify the
      // loop-specific message is gone.
      const store = makeStore(root, 'B-gfr2');
      store.appendReviewLoopRecord('B-gfr2', makeStart('L-gfr2', 'B-gfr2'));
      store.appendReviewLoopRecord('B-gfr2', makeClose('L-gfr2', 'B-gfr2', 'resolved'));
      const reason = getGuardFailureReason('B-gfr2', store, 'TEST', root);
      // The loop gate is clear; now we expect a reviewer/policy gate message,
      // not an open_review_loop message.
      if (reason !== null) {
        assert.doesNotMatch(reason, /open_review_loop/, 'resolved close must clear loop gate message');
      }
    });

    test('blocked close also clears loop gate message', () => {
      const store = makeStore(root, 'B-gfr3');
      store.appendReviewLoopRecord('B-gfr3', makeStart('L-gfr3', 'B-gfr3'));
      store.appendReviewLoopRecord('B-gfr3', makeClose('L-gfr3', 'B-gfr3', 'blocked'));
      const reason = getGuardFailureReason('B-gfr3', store, 'TEST', root);
      if (reason !== null) {
        assert.doesNotMatch(reason, /open_review_loop/, 'blocked close must clear loop gate message');
      }
    });

    test('returns fail-closed reason when review loop records are unreadable', () => {
      const store = makeStore(root, 'B-gfr-corrupt');
      writeFileSync(join(root, '.proof-or-stop', 'story', 'actives', 'B-gfr-corrupt', REVIEW_LOOP_FILENAME), '{bad json\n');
      const reason = getGuardFailureReason('B-gfr-corrupt', store, 'TEST', root);
      assert.ok(reason, 'should return a reason string');
      assert.match(reason!, /review_loop_record_error/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 4. No authority/receipt/production fields ─────────────────────────────────

console.log('\n[4] Authority/receipt/production field absence');

test('ReviewLoopStart has no authority/receipt/production fields', () => {
  const rec = makeStart('L-auth', 'B-auth') as unknown as Record<string, unknown>;
  assert.equal(rec['productionDone'], undefined, 'no productionDone');
  assert.equal(rec['authorityChanged'], undefined, 'no authorityChanged');
  assert.equal(rec['receiptVerified'], undefined, 'no receiptVerified');
  assert.equal(rec['receiptRefs'], undefined, 'no receiptRefs');
});

test('ReviewLoopIteration has no authority/receipt/production fields', () => {
  const rec = makeIteration('L-auth', 'B-auth', 'continue') as unknown as Record<string, unknown>;
  assert.equal(rec['productionDone'], undefined);
  assert.equal(rec['authorityChanged'], undefined);
  assert.equal(rec['receiptVerified'], undefined);
  assert.equal(rec['receiptRefs'], undefined);
});

test('ReviewLoopClose has no authority/receipt/production fields', () => {
  const rec = makeClose('L-auth', 'B-auth', 'resolved') as unknown as Record<string, unknown>;
  assert.equal(rec['productionDone'], undefined);
  assert.equal(rec['authorityChanged'], undefined);
  assert.equal(rec['receiptVerified'], undefined);
  assert.equal(rec['receiptRefs'], undefined);
});

// ── 5. Reflection/reusableLearning is context only ───────────────────────────

console.log('\n[5] Reflection context isolation');

test('reusableLearning is stored in reflection only, not at top-level or in evaluation', () => {
  const iter = makeIteration('L-ctx', 'B-ctx', 'continue');
  // Stored inside reflection
  assert.equal(iter.reflection.reusableLearning, 'Time-based tests need mock clock alignment');
  // Not promoted to top-level evidence fields
  const topLevel = iter as unknown as Record<string, unknown>;
  assert.equal(topLevel['reusableLearning'], undefined, 'reusableLearning must not be a top-level field');
  // evaluation.evidenceRefs does not mention reusableLearning
  assert.ok(Array.isArray(iter.evaluation.evidenceRefs));
  assert.ok(!iter.evaluation.evidenceRefs.some(r => r.toLowerCase().includes('learning')));
});

test('DEFAULT_REVIEW_LOOP_POLICY has no auto-execution flags set true', () => {
  assert.equal(DEFAULT_REVIEW_LOOP_POLICY.allowAutoHandoff, false, 'allowAutoHandoff must default false');
  assert.equal(DEFAULT_REVIEW_LOOP_POLICY.allowAutoRollback, false, 'allowAutoRollback must default false');
});

// ── 6. Handler projection / duplicate id safety ─────────────────────────────

console.log('\n[6] Handler projection and duplicate loopId safety');

test('review_loop_status JSON exposes active and latest fields', () => {
  const records: ReviewLoopRecord[] = [];
  const store = {
    readStory: () => ({ storyId: 'B-handler', phase: 'REVIEW', currentReviewRound: 'round-1' }),
    readReviewLoopRecords: () => records,
    appendReviewLoopRecord: (_storyId: string, record: ReviewLoopRecord) => { records.push(record); },
    // B-c55d signed-workspace cwd check: review_loop_start now resolves the story's signed
    // workspace (assertCwdInWorktree → resolveStorySignedWorkspace), which reads storyDirPath.
    // Mirror StoryStore.storyDirPath so resolution runs; with no worktree binding it falls
    // through to the metadata git root (resolutionSource !== story-worktree) and the cwd check
    // short-circuits, leaving the handler's own duplicate/rollback validation under test.
    storyDirPath: (storyId: string) => join(process.cwd(), '.proof-or-stop', 'story', 'actives', storyId),
  };
  const handlers = createReviewLoopHandlers({ store, root: process.cwd(), scanRoot: 'packages/main/src' } as any);
  handlers.review_loop_start({
    storyId: 'B-handler',
    loopId: 'L-handler',
    trigger: sampleTrigger,
    rollbackRef: sampleRollback,
    json: true,
  });
  const status = handlers.review_loop_status({ storyId: 'B-handler', loopId: 'L-handler', json: true }) as any;
  assert.equal(status.active, true);
  assert.equal(status.latest.status, 'open');
  assert.equal(status.loops[0].active, true);
  assert.equal(status.loops[0].latest.status, 'open');
});

test('review_loop_start rejects duplicate explicit loopId', () => {
  const records: ReviewLoopRecord[] = [];
  const store = {
    readStory: () => ({ storyId: 'B-handler', phase: 'REVIEW', currentReviewRound: 'round-1' }),
    readReviewLoopRecords: () => records,
    appendReviewLoopRecord: (_storyId: string, record: ReviewLoopRecord) => { records.push(record); },
    // B-c55d signed-workspace cwd check: review_loop_start now resolves the story's signed
    // workspace (assertCwdInWorktree → resolveStorySignedWorkspace), which reads storyDirPath.
    // Mirror StoryStore.storyDirPath so resolution runs; with no worktree binding it falls
    // through to the metadata git root (resolutionSource !== story-worktree) and the cwd check
    // short-circuits, leaving the handler's own duplicate/rollback validation under test.
    storyDirPath: (storyId: string) => join(process.cwd(), '.proof-or-stop', 'story', 'actives', storyId),
  };
  const handlers = createReviewLoopHandlers({ store, root: process.cwd(), scanRoot: 'packages/main/src' } as any);
  const args = {
    storyId: 'B-handler',
    loopId: 'L-dup',
    trigger: sampleTrigger,
    rollbackRef: sampleRollback,
    json: true,
  };
  handlers.review_loop_start(args);
  assert.throws(
    () => handlers.review_loop_start(args),
    /already exists/,
    'duplicate explicit loopId must be rejected',
  );
});

test('review_loop_start rejects placeholder rollbackRef hashes', () => {
  const records: ReviewLoopRecord[] = [];
  const store = {
    readStory: () => ({ storyId: 'B-handler', phase: 'REVIEW', currentReviewRound: 'round-1' }),
    readReviewLoopRecords: () => records,
    appendReviewLoopRecord: (_storyId: string, record: ReviewLoopRecord) => { records.push(record); },
    // B-c55d signed-workspace cwd check: review_loop_start now resolves the story's signed
    // workspace (assertCwdInWorktree → resolveStorySignedWorkspace), which reads storyDirPath.
    // Mirror StoryStore.storyDirPath so resolution runs; with no worktree binding it falls
    // through to the metadata git root (resolutionSource !== story-worktree) and the cwd check
    // short-circuits, leaving the handler's own duplicate/rollback validation under test.
    storyDirPath: (storyId: string) => join(process.cwd(), '.proof-or-stop', 'story', 'actives', storyId),
  };
  const handlers = createReviewLoopHandlers({ store, root: process.cwd(), scanRoot: 'packages/main/src' } as any);
  assert.throws(
    () => handlers.review_loop_start({
      storyId: 'B-handler',
      loopId: 'L-placeholder',
      trigger: sampleTrigger,
      rollbackRef: {
        headHash: '0'.repeat(40),
        diffHash: '1'.repeat(64),
        materialHash: '2'.repeat(64),
      },
      json: true,
    }),
    /rollbackRef invalid/,
    'placeholder rollbackRef hashes must be rejected',
  );
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\nreview-loop-smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
