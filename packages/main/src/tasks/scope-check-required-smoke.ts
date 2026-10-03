#!/usr/bin/env node
/**
 * Run 16 (abs-stepped-slices, B-80ea): the PLAN scope-plan reviewer did not run.
 *
 * The scope-plan reviewer traces every sentence and example of the stored
 * request (request.md) to checklist intents; it is the PLAN check that should
 * catch run-13-style misses. story_review only demanded it
 * (`missing_scope_check`) when an understanding snapshot existed, and
 * `understanding_set` was only advised, although the balanced policy declares
 * `plan.requireUnderstanding: 'always'`. The owner skipped understanding, so
 * the Story reached DEV with no scope review.
 *
 * Contract proven here:
 *   S1  balanced + request.md + a checklist + no understanding + no
 *       scope-check: story_review reports `missing_scope_check` as a blocker,
 *       and the DEV-entry gate refuses with `[missing_scope_check]` and one
 *       `Next:` line (the managed scope-plan reviewer launch), even when the
 *       last story_review record is clean.
 *   S2  `next` in PLAN returns exactly that launch as one agent step
 *       (host_run, managedDispatch, agentType proof-or-stop-review-scope-plan).
 *   S3  After a signed scope-check the requirement is satisfied: story_review
 *       has no missing_scope_check and `next` moves on.
 *   S4  light profile (requireUnderstanding 'never'), same Story shape: no
 *       scope check is demanded (express/light unchanged).
 *   S5  balanced without request.md is still required (policy says always).
 *
 * Usage: node packages/main/dist/tasks/scope-check-required-smoke.js
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { getGuardFailureReason } from '../core/machine.js';
import { writeStoryRequest } from '../core/story-request.js';
import { createMainRegistry } from '../registry.js';
import { createNextDriver } from '../handlers/next-driver.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';

const STORY_DIR = '.proof-or-stop/story/actives';
const SCOPE_REVIEWER = 'proof-or-stop-review-scope-plan';
const failures: string[] = [];
function check(ok: boolean, message: string, detail = ''): boolean {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${message}${ok || !detail ? '' : `\n         ${detail.slice(0, 1500).replace(/\n/g, '\n         ')}`}`);
  if (!ok) failures.push(message);
  return ok;
}
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const REQUEST = [
  'Add stepped slices to arrays and strings: a[start:end:step].',
  'For example [1, 2, 3, 4][::2] returns [1, 3] and "12345"[::-1] returns "54321".',
].join('\n');

function setup(profile: 'balanced' | 'light', withRequest: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `scope-check-required-${profile}-`)));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: STORY_DIR, requirementsDir: 'docs/requirements', workflow: { profile },
  }, null, 2));
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-5c0a';
  const now = '2026-10-03T03:00:00.000Z';
  const story: StoryInfo = {
    storyId, name: 'stepped-slices', title: 'Stepped slices',
    description: 'Add stepped slices inside index brackets.',
    type: 'feature', phase: 'PLAN', priority: 'medium',
    createdAt: now, startedAt: now, endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001', title: 'Array stepped read slicing', context: 'evaluator',
      userSees: '[1, 2, 3, 4][::2] returns [1, 3]',
      files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
      status: 'pending', startTime: null, endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  if (withRequest) {
    writeStoryRequest(store, { storyId, phase: 'INIT', request: REQUEST, source: 'smoke', now });
  }
  // The DEV-entry gate's first, independent refusal is satisfied: this smoke is about the scope check.
  store.writeDevMemoryPreflightAck(storyId, {
    schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId, topHitIds: [],
    acknowledgedAt: now, acknowledgedBy: 'smoke',
  } as never);
  const ctx = { store, root, scanRoot: root };
  const review = () => createStoryReviewHandlers(ctx).story_review({ storyId }) as {
    issues: Array<{ type: string; severity: string; message: string }>;
  };
  const registry = createMainRegistry(ctx);
  const next = () => createNextDriver(ctx, (name: string) => registry.get(name)).decide(storyId) as unknown as {
    kind: string; reason: string; command: string | null; argv?: unknown; cli?: { command: string; payload: Record<string, unknown> } | null; why: string;
  };
  const guard = () => getGuardFailureReason(storyId, store, 'DEV', root, root);
  /** A clean story_review record as run 16 had (13 advisories, 0 blockers): what admitted DEV. */
  const cleanReviewRecord = () => {
    const REVIEW_SALT = 'proof-or-stop-review-integrity-v1';
    const timestamp = '2026-10-03T03:01:00.000Z';
    const _hash = createHash('sha256').update(`${storyId}:${timestamp}:0:0:${REVIEW_SALT}`).digest('hex');
    store.writeReview(storyId, { reviews: [{ timestamp, issueCount: 0, blockerCount: 0, issues: [], _hash }] } as never);
  };
  const signScope = () => createScopeCheckHandlers(ctx).scope_check_save({
    storyId,
    features: [{ feature: 'Array stepped read slicing', status: 'covered', covered_by: 'CHK-001', excluded_by: null, source: 'request.md' }],
    summary: { total: 1, covered: 1, excluded: 0, gaps: 0 },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    openQuestions: [],
  });
  return { root, store, storyId, review, next, guard, cleanReviewRecord, signScope };
}

function balanced(withRequest: boolean): void {
  const label = withRequest ? 'S1-S3 balanced + request.md' : 'S5 balanced without request.md';
  console.log(label);
  const t = setup('balanced', withRequest);
  try {
    check(t.store.readUnderstanding(t.storyId) === null, 'fixture has no understanding snapshot');
    const issue = t.review().issues.find(entry => entry.type === 'missing_scope_check');
    check(issue?.severity === 'blocker', 'story_review reports missing_scope_check as a blocker without understanding',
      JSON.stringify(t.review().issues.map(entry => `${entry.severity}:${entry.type}`)));

    // The DEV-entry gate itself refuses, even with a clean review record (run 16's state).
    t.cleanReviewRecord();
    const failure = t.guard();
    check(!!failure && /\[missing_scope_check\]/.test(failure), 'DEV-entry gate refuses with [missing_scope_check] despite a clean story_review record', String(failure));
    const nextLines = (failure ?? '').split('\n').filter(line => line.startsWith('Next: '));
    check(nextLines.length === 1 && nextLines[0]!.includes(SCOPE_REVIEWER) && nextLines[0]!.includes('host_run'),
      'the refusal carries exactly one Next: line, the managed scope-plan reviewer launch', String(failure));

    if (!withRequest) return;
    const step = t.next();
    check(step.kind === 'agent' && step.reason === 'scope_plan_review_launch' && step.cli?.command === 'host_run'
      && step.cli.payload.agentType === SCOPE_REVIEWER && step.cli.payload.managedDispatch === true,
      'next in PLAN returns one agent step: host_run managedDispatch of the scope-plan reviewer', JSON.stringify(step));

    t.signScope();
    check(!t.review().issues.some(entry => entry.type === 'missing_scope_check'), 'after a signed scope-check story_review no longer demands it');
    const after = t.guard();
    check(!after || !/\[missing_scope_check\]/.test(after), 'after a signed scope-check the DEV-entry gate no longer refuses for it', String(after));
    const stepAfter = t.next();
    check(!JSON.stringify(stepAfter).includes(SCOPE_REVIEWER), 'after a signed scope-check next no longer proposes the scope-plan reviewer', JSON.stringify(stepAfter));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
}

function light(): void {
  console.log('S4 light profile + request.md (requireUnderstanding never): unchanged');
  const t = setup('light', true);
  try {
    check(!t.review().issues.some(entry => entry.type === 'missing_scope_check'), 'light story_review does not demand a scope check');
    t.cleanReviewRecord();
    const failure = t.guard();
    check(!failure || !/\[missing_scope_check\]/.test(failure), 'light DEV-entry gate does not refuse for a scope check', String(failure));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
}

balanced(true);
balanced(false);
light();
if (failures.length) {
  console.log(`scope-check-required-smoke: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('scope-check-required-smoke: PASS');
