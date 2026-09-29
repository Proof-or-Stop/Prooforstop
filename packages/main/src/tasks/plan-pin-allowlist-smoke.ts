#!/usr/bin/env node
/**
 * Lab plan-pin-allowlist: run 5 (2026-09-29) pinned `env CONTEXT=abs go test ...`
 * in PLAN. checklist_update accepted it; DEV's first verification_evidence_add
 * refused it [verification_command_not_allowlisted], and because pins freeze at
 * DEV the owner had to roll back to PLAN and rerun its gates. The same allowlist
 * must refuse the pin when it is written.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function initStore(options: { saveScopeCheck?: boolean } = {}): { root: string; store: StoryStore; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-story-review-ergonomics-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
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
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
      openQuestions: [],
    });
  }
  return { root, store, storyId };
}

const row = (command: string) => ({
  desc: 'Focused behavior passes', type: 'logic', priority: 'must',
  scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
  verification: { command, selector: '--- PASS: TestX' },
});
const intent = (command: string) => ({ happy: [row(command)], edge: [row(command)], adversarial: [row(command)] });

const { root, store, storyId } = initStore();
try {
  const handlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  assert.throws(() => handlers.checklist_update({
    storyId, itemId: 'CHK-001', agent: 'proof-or-stop-verification-intent',
    verificationIntent: intent("env CONTEXT=abs go test -v ./evaluator -run '^TestX$'"),
  } as any), /verification_command_not_allowlisted/, 'a non-allowlisted pinned executable must be refused in PLAN');
  handlers.checklist_update({
    storyId, itemId: 'CHK-001', agent: 'proof-or-stop-verification-intent',
    verificationIntent: intent("go test -v ./evaluator -run '^TestX$'"),
  } as any);
  assert.equal(store.readChecklist(storyId).items[0].verificationIntent?.happy?.[0].verification?.command,
    "go test -v ./evaluator -run '^TestX$'");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('plan-pin-allowlist-smoke: PASS');
