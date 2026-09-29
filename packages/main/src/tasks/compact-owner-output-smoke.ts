#!/usr/bin/env node
/**
 * Lab compact-owner-output: in run 5 (2026-09-29) `dispatch` and
 * `review_run_start` printed the whole worker/reviewer prompt (~8K tokens each,
 * ~100K of the ~286K tokens of tool output the owner re-sent every later turn).
 * A managed host_run rebuilds the exact prompt from the recorded envelope, so
 * `summary: true` must keep the record and replace the body with its size and
 * digest.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetSessionIdForTest } from '../core/owner-session.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { renderReviewRunStartOutput } from '../handlers/review-run.js';

process.env.PROOF_OR_STOP_SESSION_ID = `fixture-compact-${process.pid}`;
process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex';
resetSessionIdForTest();
const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-consumer-smoke-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['checkout', '-qB', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: root });
  execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: root });
  execFileSync('git', [
    'commit', '-qm', 'smoke baseline',
    '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>',
  ], { cwd: root });
  // Topology-authority dispatch is intentionally fail-closed on an empty
  // story-owned diff. Exercise the complete registry on a real story branch
  // with one committed production delta instead of weakening that gate for a
  // synthetic HEAD==main fixture.
  execFileSync('git', ['checkout', '-qb', 'story/B-dispatch-consumer'], { cwd: root });
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/example.ts'), 'export const dispatchConsumerSmoke = true;\n', 'utf8');
  execFileSync('git', ['add', 'packages/main/src/example.ts'], { cwd: root });
  execFileSync('git', [
    'commit', '-qm', 'seed story-owned dispatch delta',
    '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>',
  ], { cwd: root });
  const store = new StoryStore(root);
  const storyId = 'B-dispatch-consumer';
  const now = '2026-07-16T00:00:00.000Z';
  store.writeStory(storyId, {
    storyId, name: 'dispatch-consumer-smoke', title: 'Dispatch consumer smoke', description: 'Synthetic dispatch contract.',
    type: 'chore', phase: 'PLAN', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, events: [],
  });
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001', title: 'Define verification', context: 'Synthetic context', status: 'pending', startTime: null, endTime: null,
  }] });
  store.writeFindings(storyId, { findings: [{
    id: `${storyId}:F-001`, desc: 'Synthetic dispatch finding', severity: 'high', category: 'missing',
    status: 'open', agent: 'proof-or-stop-review-quality', files: ['packages/main/src/example.ts'],
  }] });
  store.writeClusters(storyId, { clusters: [{
    clusterId: 'CL-001', rootCause: 'Synthetic root cause', findingIds: [`${storyId}:F-001`],
    files: ['packages/main/src/example.ts'], severity: 'high', createdAt: now,
  }] });
  const handlers = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') });

  const full = handlers.dispatch({ storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-verification-intent' });
  const brief = handlers.dispatch({ storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-verification-intent', summary: true } as any);
  const digest = createHash('sha256').update(full.prompt).digest('hex');
  assert.ok(full.prompt.length > 2000, 'fixture prompt is a real prompt');
  assert.ok(brief.prompt.length < 400, `summary dispatch still prints the prompt body (${brief.prompt.length} chars)`);
  assert.match(brief.prompt, new RegExp(digest), 'summary names the digest of the omitted prompt');
  assert.match(brief.prompt, new RegExp(`${Buffer.byteLength(full.prompt)} bytes`));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const body = 'x'.repeat(5000);
const fullText = renderReviewRunStartOutput('Review run RR-1 started', body, 'role', false);
const briefText = renderReviewRunStartOutput('Review run RR-1 started', body, 'role', true);
assert.match(fullText, /BEGIN EXACT ASSEMBLED REVIEW PROMPT/);
assert.ok(briefText.length < 400 && briefText.startsWith('Review run RR-1 started'), 'summary review_run_start omits the prompt body');
assert.match(briefText, new RegExp(createHash('sha256').update(body).digest('hex')));
console.log('compact-owner-output-smoke: PASS');
