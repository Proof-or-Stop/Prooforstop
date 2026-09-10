import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { assessReviewConvergence } from '../packages/main/dist/core/review-convergence.js';
import { canMintReviewRoundGuard, reviewRoundMintStallAdjudication } from '../packages/main/dist/core/machine.js';
assert.equal(assessReviewConvergence(4, [3, 2, 2, 1]).stalled, false,
  'U11: verified blocker reduction must not be classified as a stall');
assert.equal(assessReviewConvergence(4, [3, 3, 3, 3]).stalled, true,
  'two consecutive non-improving comparisons still request adjudication');
const root = mkdtempSync(join(tmpdir(), 'convergence-net-progress-'));
try {
  const store = new StoryStore(root);
  const storyId = 'B-progress';
  const counts = [3, 2, 2, 1];
  const times = counts.map((_, i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString());
  store.writeStory(storyId, { storyId, name: storyId, title: 'Progress witness', description: 'Progress witness',
    type: 'chore', phase: 'DEV', priority: 'high', createdAt: times[0], startedAt: times[0], endedAt: null,
    currentReviewRound: times.at(-1), events: times.map(timestamp => ({ phase: 'REVIEW', action: 'advance', timestamp })) });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Core work', status: 'done', startTime: null, endTime: null }] });
  store.writeFindings(storyId, { findings: counts.flatMap((n, i) => Array.from({ length: n }, (_, j) => ({
    id: `F-${i}-${j}`, desc: 'Verified blocker', category: 'adversarial', severity: 'critical', status: 'open',
    evidenceState: 'verified', reviewRound: times[i],
  }))) });
  const ctx = { store, storyId, projectRoot: root };
  assert.equal(reviewRoundMintStallAdjudication(ctx).blocked, false, 'the real machine stall consumer accepts improving work');
  assert.equal(canMintReviewRoundGuard(ctx), true, 'the actual DEV to REVIEW gate remains reachable');
  console.log('PASS U11 convergence-net-progress');
} finally { rmSync(root, { recursive: true, force: true }); }
