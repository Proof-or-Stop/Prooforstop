#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function initStore(options: { saveScopeCheck?: boolean } = {}): { root: string; store: StoryStore; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-story-review-ergonomics-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-review';
  const now = '2026-05-08T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'story-review-ergonomics',
    title: 'Story review ergonomics',
    description: 'Synthetic story for story_review ergonomics.',
    type: 'chore',
    phase: 'PLAN',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Normalize touchpoint coverage',
      context: 'Touchpoint strings can include human explanation.',
      userSees: '`story_review` accepts described touchpoints.',
      files: {
        modify: ['packages/main/src/foo.ts'],
        create: [],
        test: ['packages/main/src/tasks/story-review-ergonomics-smoke.ts'],
      },
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Normalize story review touchpoints',
    outcome: 'Touchpoints with descriptions match checklist files',
    facts: ['Touchpoint strings may contain explanatory parentheses.'],
    constraints: [],
    unknowns: [],
    touchpoints: ['packages/main/src/foo.ts (pass result.summary to report)'],
    timestamp: now,
  });
  if (options.saveScopeCheck !== false) {
    createScopeCheckHandlers({ store, root, scanRoot: join(root, 'packages/main') }).scope_check_save({
      storyId,
      features: [{
        feature: 'Codex adapter verification',
        covered_by: null,
        status: 'excluded',
        excluded_by: 'No adapter files touched',
        source: 'scope-smoke',
      }],
      summary: { total: 1, covered: 0, excluded: 1, gaps: 0 },
      openQuestions: [],
    });
  }
  return { root, store, storyId };
}

function assertMissingScopeCheckGuidanceIsActionable(): void {
  const { root, store, storyId } = initStore({ saveScopeCheck: false });
  try {
    const result = createStoryReviewHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).story_review({ storyId }) as any;
    const issue = result.issues.find((entry: any) => entry.type === 'missing_scope_check');
    assert.ok(issue);
    assert.equal(issue.severity, 'blocker');
    assert.match(issue.message, /scope-check\.json is missing PLAN gate evidence/);
    assert.match(issue.message, /scope_check_save/);
    assert.match(issue.message, /lattice-review-scope-plan \/ scope-plan reviewer/);
    assert.match(issue.message, /implementation\/main agent must not self-sign/);
    assert.match(issue.message, /manually edit story metadata/);
    assert.match(issue.message, /not remote completion/);
    assert.doesNotMatch(issue.message, /self-sign.*scope_check_save/i);
    assert.doesNotMatch(issue.message, /scope_contract_check/i);
    assert.doesNotMatch(issue.message, /receiptVerified|authorityDone|productionDone|fullAuthorityDone/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertTouchpointAndExcludedInfoAreQuiet(): void {
  const { root, store, storyId } = initStore();
  try {
    const result = createStoryReviewHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).story_review({ storyId }) as any;
    assert.equal(result.summary.blockerCount, 0);
    assert.equal(result.issues.some((issue: any) => issue.type === 'touchpoint_uncovered'), false);
    assert.equal(result.issues.some((issue: any) => issue.type === 'scope_excluded_info'), false);
    assert.equal(result.info?.some((entry: any) => entry.type === 'scope_excluded_info'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPlanAddNeedsAuditReason(): void {
  const { root, store, storyId } = initStore();
  try {
    const handlers = createChecklistHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    assert.throws(
      () => handlers.checklist_add({ storyId, title: 'Add scope item', context: 'Synthetic scope addition' }),
      /reason ≥ 10/,
    );
    handlers.checklist_add({
      storyId,
      title: 'Add scope item',
      context: 'Synthetic scope addition',
      reason: 'Explicit replan audit for PLAN addition',
    });
    const audit = store.readChecklist(storyId).auditLog || [];
    assert.equal(audit.some(entry => entry.action === 'add' && entry.itemId === 'CHK-002'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPlanRemoveCannotBypassFreeze(): void {
  const { root, store, storyId } = initStore();
  try {
    const handlers = createChecklistHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    assert.throws(
      () => handlers.checklist_remove({
        storyId,
        itemId: 'CHK-001',
        disposition: 'accept',
        justification: 'Attempting to replace the frozen checklist item',
      }),
      /PLAN phase does not allow removing checklist items.*remove\+add bypass/,
    );
    assert.equal(store.readChecklist(storyId).items.some(item => item.id === 'CHK-001'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertTouchpointAndExcludedInfoAreQuiet();
assertMissingScopeCheckGuidanceIsActionable();
assertPlanAddNeedsAuditReason();
assertPlanRemoveCannotBypassFreeze();

console.log('✓ story review ergonomics smoke passed');
