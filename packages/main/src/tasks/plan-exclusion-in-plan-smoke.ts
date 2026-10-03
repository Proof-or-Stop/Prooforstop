#!/usr/bin/env node
/**
 * Run 15 (abs-stepped-slices) regression: the PLAN story_review gate demanded
 * exclusions (reference-only doc touchpoints, a request constraint) that the
 * owner could only express by reopening INIT and editing the INIT-only scope
 * boundary, which staled INIT evidence and forced both INIT reviewers to rerun.
 *
 * Contract proven here:
 *  - A reference-only touchpoint is accepted when a checklist item's PLAN-owned
 *    `excludes` names that exact path with a reason; a bare path or a
 *    non-matching entry still blocks (the check keeps its meaning).
 *  - A scope-plan reviewer gap names the PLAN-local action (cover or exclude in
 *    the checklist, then rerun the scope-plan reviewer). Once the checklist has
 *    changed since the signed verdict, the one remaining action is the rerun.
 *  - After the PLAN-local repair plus a fresh reviewer verdict the gate passes in
 *    PLAN with INIT evidence and the scope boundary byte-identical.
 *  - The INIT scope boundary itself still requires INIT.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createScopeAntiExpansionHandlers } from '../handlers/scope-anti-expansion.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';

const CONSTRAINT = 'Do not change public syntax outside index brackets';
const DOC = 'docs/src/docs/types/array.md';
const STORY_DIR = '.proof-or-stop/story/actives';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-plan-exclusion-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: STORY_DIR,
    requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-5e1c';
  const now = '2026-10-03T01:00:00.000Z';
  const story: StoryInfo = {
    storyId, name: 'stepped-slices', title: 'Stepped slices',
    description: 'Add stepped slices inside index brackets.',
    type: 'feature', phase: 'PLAN', priority: 'medium',
    createdAt: now, startedAt: now, endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001', title: 'Parse stepped index ranges', context: 'parser only',
      userSees: 'AST output shows "(a[1:5:2])".',
      files: { modify: ['parser/parser.go'], create: [], test: ['parser/parser_test.go'] },
      status: 'pending', startTime: null, endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Stepped slices', outcome: 'a[1:5:2] works',
    facts: ['Parser owns index brackets.'], constraints: [`${CONSTRAINT}.`], unknowns: [],
    touchpoints: ['parser/parser.go', DOC], timestamp: now,
  });
  // INIT-owned artifacts that must stay untouched by the PLAN-local repair.
  const dir = join(root, STORY_DIR, storyId);
  write(root, join(STORY_DIR, storyId, 'init-check.json'), '{"sentinel":"init evidence"}\n');
  write(root, join(STORY_DIR, storyId, 'scope-boundary.json'), '{"sentinel":"init boundary"}\n');
  const scope = (status: 'gap' | 'excluded') => createScopeCheckHandlers({ store, root, scanRoot: join(root, 'packages/main') }).scope_check_save({
    storyId,
    features: [
      { feature: 'Parse start:end:step', status: 'covered', covered_by: 'CHK-001', excluded_by: null, source: 'request.md' },
      { feature: CONSTRAINT, status, covered_by: null, excluded_by: status === 'excluded' ? `${CONSTRAINT}: acknowledged` : null, source: 'request.md' },
    ],
    summary: { total: 2, covered: 1, excluded: status === 'excluded' ? 1 : 0, gaps: status === 'gap' ? 1 : 0 },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    openQuestions: [],
  });
  const review = () => createStoryReviewHandlers({ store, root, scanRoot: join(root, 'packages/main') }).story_review({ storyId }) as any;
  const checklistHandlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const snapshot = () => ['init-check.json', 'scope-boundary.json'].map(f => readFileSync(join(dir, f), 'utf8')).join('|');
  return { root, store, storyId, scope, review, checklistHandlers, snapshot };
}

function main(): void {
  const t = setup();
  try {
    t.scope('gap');
    const initBefore = t.snapshot();

    // 1. Before repair: the touchpoint blocker and the reviewer gap both name a PLAN-local action.
    let result = t.review();
    const touch = result.issues.find((i: any) => i.type === 'touchpoint_uncovered');
    assert.ok(touch, 'reference-only doc touchpoint must block until covered or excluded');
    assert.match(touch.message, /checklist_update/, 'touchpoint hint must name the PLAN command');
    assert.match(touch.message, /--excludes/, 'touchpoint hint must name the excludes declaration');
    let gap = result.issues.find((i: any) => i.type === 'scope_gap');
    assert.ok(gap && gap.severity === 'blocker');
    assert.match(gap.message, /proof-or-stop-review-scope-plan/, 'gap hint must name the scope-plan reviewer rerun');
    assert.match(gap.message, /checklist_update/, 'gap hint must name the PLAN checklist action');
    assert.doesNotMatch(gap.message, /scope_boundary_set|story_advance/, 'gap hint must not route to INIT');

    // A bare path (no reason) or a different path does not satisfy coverage.
    t.checklistHandlers.checklist_update({ storyId: t.storyId, itemId: 'CHK-001', excludes: [DOC, 'docs/other.md: reference only for syntax examples'] });
    result = t.review();
    assert.ok(result.issues.some((i: any) => i.type === 'touchpoint_uncovered'), 'bare path without reason must still block');

    // 2. PLAN-local repair: record the reference-only doc and the constraint acknowledgement as item excludes.
    t.checklistHandlers.checklist_update({
      storyId: t.storyId, itemId: 'CHK-001',
      excludes: [
        `No changes to ${DOC}; it is reference material only for this parser item.`,
        `${CONSTRAINT}: acknowledged constraint; no syntax outside index brackets is touched.`,
      ],
    });
    assert.equal(t.store.readStory(t.storyId).phase, 'PLAN');
    result = t.review();
    assert.equal(result.issues.some((i: any) => i.type === 'touchpoint_uncovered'), false, 'excluded reference-only touchpoint must be accepted');
    gap = result.issues.find((i: any) => i.type === 'scope_gap');
    assert.ok(gap && gap.severity === 'blocker', 'stale reviewer gap still blocks until the reviewer reruns');
    assert.match(gap.message, /checklist changed since/, 'stale gap must say the checklist changed since the verdict');
    assert.match(gap.message, /proof-or-stop-review-scope-plan/);
    assert.doesNotMatch(gap.message, /scope_boundary_set|story_advance/);

    // 3. Fresh reviewer verdict on the repaired checklist: gate passes in PLAN, INIT artifacts untouched.
    t.scope('excluded');
    result = t.review();
    assert.equal(result.summary.blockerCount, 0, JSON.stringify(result.issues.filter((i: any) => i.severity === 'blocker')));
    assert.equal(t.store.readStory(t.storyId).phase, 'PLAN');
    assert.equal(t.snapshot(), initBefore, 'INIT evidence and scope boundary must be untouched');

    // 4. The INIT boundary itself still requires INIT.
    assert.throws(
      () => createScopeAntiExpansionHandlers({ store: t.store, root: t.root, scanRoot: join(t.root, 'packages/main') } as any)
        .scope_boundary_set({ storyId: t.storyId, userConfirmed: true, allowedScope: ['x'], excludedScope: [CONSTRAINT] }),
      /INIT-only/,
    );
    assert.ok(existsSync(join(t.root, STORY_DIR, t.storyId, 'scope-check.json')));
    console.log('PLAN_EXCLUSION_IN_PLAN_OK');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
}

main();
