#!/usr/bin/env node
/**
 * B-85ba CHK-005: INIT→INIT_CHECK scope anti-expansion smoke.
 *
 * Exercises the thin machine guard against the core scope evaluator/store
 * artifacts: missing boundary, missing execution boundary, excluded keyword,
 * failed/stale freeze check, pending proposal, repeated discarded direction,
 * mitigation, and the happy path.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { getScopeAntiExpansionGuardFailureReason } from '../core/machine.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';
import {
  buildExecutionBoundary,
  buildScopeBoundary,
  buildScopeDiscardDigestEntry,
  buildScopeExtensionProposal,
  digestScopeFreezeCheck,
  evaluateScopeFreeze,
  normalizeBoundaryArray,
} from '../core/scope-anti-expansion.js';
import type { ChecklistData, ScopeFreezeCheckData, StoryInfo } from '../core/types.js';

const NOW = '2026-06-12T12:00:00.000Z';
const STORY_ID = 'B-scope-anti-expansion-smoke';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function createTempStore(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'koala-scope-anti-expansion-'));
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  resetConfigCache();
  return { root, store: new StoryStore(root) };
}

function withTempStore(label: string, fn: (store: StoryStore) => void): void {
  const { root, store } = createTempStore();
  try {
    fn(store);
    console.log(`  ✓ ${label}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function withTempContext(label: string, fn: (root: string, store: StoryStore) => void): void {
  const { root, store } = createTempStore();
  try {
    fn(root, store);
    console.log(`  ✓ ${label}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function validBackground(): string {
  return [
    '## Trigger Event',
    'B-85ba smoke test creates a story with scope boundary inputs so the INIT gate can verify canonical user-confirmed scope.',
    '## Key Insights',
    'The boundary must be persisted as structured metadata immediately, not inferred later from reviewer prose or broad repository context.',
    '## Solution Tradeoffs',
    'This smoke uses the story_create handler directly because it needs to validate metadata writes without creating a real git worktree.',
    '## Conversational Texture',
    'The user asked for anti-expansion behavior that stops before development, so the visible artifact write is part of product behavior.',
  ].join('\n\n') + '\n';
}

function seedStory(store: StoryStore, opts: {
  title?: string;
  description?: string;
  checklistTitle?: string;
  checklistContext?: string;
  checklistExcludes?: string[];
} = {}): void {
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'scope-anti-expansion-smoke',
    title: opts.title ?? 'Fix the INIT gate boundary regression',
    description: opts.description ?? 'Keep the implementation scoped to the INIT anti-expansion freeze gate.',
    type: 'bug',
    phase: 'INIT',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'INIT', action: 'create', timestamp: NOW }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: opts.checklistTitle ?? 'Wire the scope freeze gate',
      ...(opts.checklistContext ? { context: opts.checklistContext } : { context: 'Use the core evaluator without expanding scope.' }),
      ...(opts.checklistExcludes ? { excludes: opts.checklistExcludes } : {}),
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, checklist);
}

function writeGoodBoundaries(store: StoryStore): void {
  store.writeScopeBoundary(STORY_ID, buildScopeBoundary({
    storyId: STORY_ID,
    mode: 'correctness_fix',
    allowed: ['INIT anti-expansion gate correctness'],
    excluded: ['accepted reviewer expansion without decision'],
    confirmedBy: 'scope-anti-expansion-smoke',
    confirmationNote: 'Synthetic user-confirmed boundary for smoke coverage.',
    now: NOW,
  }));
  store.writeExecutionBoundary(STORY_ID, buildExecutionBoundary({
    storyId: STORY_ID,
    allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'],
    excludedCommands: ['omx'],
    excludedTools: [],
    confirmedBy: 'scope-anti-expansion-smoke',
    confirmationNote: 'Synthetic execution boundary for smoke coverage.',
    now: NOW,
  }));
}

function projectStory(store: StoryStore) {
  const story = store.readStory(STORY_ID);
  return { title: story.title, description: story.description };
}

function projectChecklist(store: StoryStore) {
  return store.readChecklist(STORY_ID).items.map(item => ({
    id: item.id,
    title: item.title,
    ...(item.context ? { context: item.context } : {}),
    ...(item.excludes ? { excludes: [...item.excludes] } : {}),
  }));
}

function freeze(store: StoryStore, mitigation?: string): ScopeFreezeCheckData {
  const result = evaluateScopeFreeze({
    storyId: STORY_ID,
    scopeBoundary: store.readScopeBoundary(STORY_ID),
    executionBoundary: store.readExecutionBoundary(STORY_ID),
    story: projectStory(store),
    checklist: projectChecklist(store),
    discardDigest: store.readScopeDiscardDigest(STORY_ID),
    repeatDiscardMitigation: mitigation,
    now: NOW,
  });
  store.writeScopeFreezeCheck(STORY_ID, result.check);
  return result.check;
}

function expectReason(store: StoryStore, pattern: RegExp): void {
  const reason = getScopeAntiExpansionGuardFailureReason(STORY_ID, store, process.cwd());
  assert.ok(reason, `expected scope anti-expansion guard reason matching ${pattern}`);
  assert.match(reason, pattern);
}

withTempContext('story_create persists initial scope and execution boundaries', (root, store) => {
  const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const output = handlers.story_create({
    name: 'scope-boundary-create-smoke',
    title: 'Fix INIT scope freeze regression',
    description: 'Persist user-confirmed scope boundary during story_create.',
    type: 'bug',
    priority: 'high',
    background: validBackground(),
    checklist: [{ title: 'Persist the freeze artifacts', context: 'Use typed scope anti-expansion artifacts.' }],
    scopeBoundary: {
      mode: 'correctness_fix',
      allowed: ['INIT scope freeze correctness'],
      excluded: ['Authority expansion'],
      userConfirmed: true,
      confirmation: 'Synthetic smoke user confirmation.',
    },
    executionBoundary: {
      allowedCommands: ['npm --prefix packages/main run build'],
      allowedTools: ['shell'],
      excludedCommands: ['omx'],
    },
    forceNew: true,
  });
  const storyId = /Story (B-[a-z0-9]+)/.exec(output)?.[1];
  assert.ok(storyId, `story_create output should include story id: ${output}`);
  assert.deepEqual(store.readScopeBoundary(storyId)?.allowed, ['INIT scope freeze correctness']);
  assert.deepEqual(store.readScopeBoundary(storyId)?.excluded, ['Authority expansion']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.allowedCommands, ['npm --prefix packages/main run build']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.excludedCommands, ['omx']);
});

withTempStore('missing scope boundary blocks before worktree creation', (store) => {
  seedStory(store);
  expectReason(store, /\[missing_scope_boundary\]/);
});

withTempStore('missing execution boundary blocks distinctly', (store) => {
  seedStory(store);
  store.writeScopeBoundary(STORY_ID, buildScopeBoundary({
    storyId: STORY_ID,
    mode: 'correctness_fix',
    allowed: ['INIT anti-expansion gate correctness'],
    confirmedBy: 'scope-anti-expansion-smoke',
    now: NOW,
  }));
  expectReason(store, /\[missing_execution_boundary\]/);
});

withTempStore('correctness-fix default excluded keyword blocks future capability text', (store) => {
  seedStory(store, { checklistTitle: 'Add Authority scope handling' });
  writeGoodBoundaries(store);
  expectReason(store, /\[excluded_keyword\][\s\S]*Authority|Authority[\s\S]*\[excluded_keyword\]/);
});

withTempStore('failed freeze check blocks with failed-freeze reason', (store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  const pass = freeze(store);
  const failedBase: ScopeFreezeCheckData = { ...pass, status: 'fail', issues: [], _hash: '' };
  store.writeScopeFreezeCheck(STORY_ID, { ...failedBase, _hash: digestScopeFreezeCheck(failedBase) });
  expectReason(store, /\[scope_freeze_check_failed\]/);
});

withTempStore('pending proposal blocks until explicit decision', (store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  freeze(store);
  const proposal = buildScopeExtensionProposal({
    proposalId: 'SEP-smoke-001',
    storyId: STORY_ID,
    proposedBy: 'koala-review-story-init',
    reason: 'Reviewer proposes expansion, but it is not decided yet.',
    patch: {},
    proposedAt: NOW,
  });
  store.writeScopeExtensionProposals(STORY_ID, {
    storyId: STORY_ID,
    updatedAt: NOW,
    proposals: [proposal],
  });
  expectReason(store, /\[scope_extension_proposal_pending\]/);
});

withTempStore('stale freeze check blocks after checklist mutation', (store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  freeze(store);
  const checklist = store.readChecklist(STORY_ID);
  checklist.items[0] = { ...checklist.items[0], title: 'Wire the scope freeze gate after mutation' };
  store.writeChecklist(STORY_ID, checklist);
  expectReason(store, /\[scope_freeze_check_stale\]/);
});

withTempStore('repeat discarded direction blocks without mitigation and passes with mitigation', (store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  const story = projectStory(store);
  const checklist = projectChecklist(store);
  const boundary = store.readScopeBoundary(STORY_ID);
  const terms = normalizeBoundaryArray([
    story.title ?? '',
    story.description ?? '',
    ...(boundary?.allowed ?? []),
    ...checklist.flatMap(item => [item.title, item.context ?? '']),
  ]);
  const entry = buildScopeDiscardDigestEntry({
    terms,
    reason: 'Previous story was discarded after selecting this direction.',
    storyId: 'B-previous-discarded',
    discardedAt: NOW,
  });
  store.writeScopeDiscardDigest(STORY_ID, {
    storyId: STORY_ID,
    updatedAt: NOW,
    entries: [entry],
  });
  expectReason(store, /\[repeat_discarded_direction\]/);

  freeze(store, 'Mitigation: this retry narrows to the machine guard only and does not repeat the discarded work.');
  assert.equal(getScopeAntiExpansionGuardFailureReason(STORY_ID, store, process.cwd()), null);
});

withTempStore('happy path passes with current boundary, freeze, and no pending proposals', (store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  freeze(store);
  assert.equal(getScopeAntiExpansionGuardFailureReason(STORY_ID, store, process.cwd()), null);
});

console.log('✓ scope anti-expansion smoke passed');
