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
import { createScopeAntiExpansionHandlers } from '../handlers/scope-anti-expansion.js';
import { createChecklistHandlers } from '../handlers/checklist.js';

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
      allowedPaths: ['packages/main/src'],
      excludedCommands: ['omx'],
      blockedPaths: ['packages/main/dist'],
    },
    forceNew: true,
  });
  const storyId = /Story (B-[a-z0-9]+)/.exec(output)?.[1];
  assert.ok(storyId, `story_create output should include story id: ${output}`);
  assert.deepEqual(store.readScopeBoundary(storyId)?.allowed, ['INIT scope freeze correctness']);
  assert.deepEqual(store.readScopeBoundary(storyId)?.excluded, ['Authority expansion']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.allowedCommands, ['npm --prefix packages/main run build']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.excludedCommands, ['omx']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.allowedPaths, ['packages/main/src']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.excludedPaths, ['packages/main/dist']);
});

withTempContext('story_create rejects malformed or blank scope boundary arrays', (root, store) => {
  const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  assert.throws(() => handlers.story_create({
    name: 'scope-boundary-malformed-smoke',
    title: 'Fix malformed boundary regression',
    description: 'Reject malformed scope boundary arrays before gate evidence can be saved.',
    type: 'bug',
    priority: 'high',
    background: validBackground(),
    checklist: [{ title: 'Reject malformed boundary arrays', context: 'Boundary arrays must stay typed.' }],
    scopeBoundary: {
      mode: 'correctness_fix',
      allowed: 'INIT scope freeze correctness' as unknown as string[],
      userConfirmed: true,
    },
    forceNew: true,
  }), /scopeBoundary\.allowed must be an array of strings/);

  assert.throws(() => handlers.story_create({
    name: 'scope-boundary-blank-smoke',
    title: 'Fix blank boundary regression',
    description: 'Reject blank scope boundary terms before gate evidence can be saved.',
    type: 'bug',
    priority: 'high',
    background: validBackground(),
    checklist: [{ title: 'Reject blank boundary terms', context: 'Boundary arrays must stay meaningful.' }],
    scopeBoundary: {
      mode: 'correctness_fix',
      allowed: ['   '],
      userConfirmed: true,
    },
    forceNew: true,
  }), /story_create scopeBoundary requires at least one allowed scope entry/);
});

withTempStore('execution boundary rejects malformed arrays and unsafe paths', () => {
  assert.throws(() => buildExecutionBoundary({
    storyId: STORY_ID,
    allowedCommands: 'npm test' as unknown as string[],
  }), /executionBoundary\.allowedCommands must be an array of strings/);
  assert.throws(() => buildExecutionBoundary({
    storyId: STORY_ID,
  }), /executionBoundary must include at least one allowed or excluded command\/tool\/path entry/);
  assert.throws(() => buildExecutionBoundary({
    storyId: STORY_ID,
    allowedPaths: ['../outside'],
  }), /executionBoundary\.allowedPaths must contain safe relative paths/);
});

withTempContext('INIT boundary handlers reject empty scope/execution and accept safe paths', (root, store) => {
  seedStory(store);
  const handlers = createScopeAntiExpansionHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  assert.throws(() => handlers.scope_boundary_set({
    storyId: STORY_ID,
    allowedScope: [],
    userConfirmed: true,
  }), /scopeBoundary\.allowed must include at least one non-empty entry/);
  assert.throws(() => handlers.execution_boundary_set({
    storyId: STORY_ID,
  }), /executionBoundary must include at least one allowed or excluded command\/tool\/path entry/);
  handlers.execution_boundary_set({
    storyId: STORY_ID,
    allowedPaths: ['packages/main/src'],
    blockedPaths: ['packages/main/dist'],
    actor: 'scope-anti-expansion-smoke',
  });
  assert.deepEqual(store.readExecutionBoundary(STORY_ID)?.allowedPaths, ['packages/main/src']);
  assert.deepEqual(store.readExecutionBoundary(STORY_ID)?.excludedPaths, ['packages/main/dist']);
});

withTempContext('scope extension proposal persists proposal body separately from reason', (root, store) => {
  seedStory(store);
  const handlers = createScopeAntiExpansionHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  handlers.scope_extension_proposal({
    storyId: STORY_ID,
    proposal: 'Expand the story to include a documented migration recovery path.',
    reason: 'Reviewer noticed a user-visible recovery gap.',
    reviewer: 'koala-review-story-init',
  });
  const saved = store.readScopeExtensionProposals(STORY_ID).proposals[0];
  assert.equal(saved.proposal, 'Expand the story to include a documented migration recovery path.');
  assert.equal(saved.reason, 'Reviewer noticed a user-visible recovery gap.');
  assert.ok(saved.proposalTextHash, 'proposalTextHash should be persisted');
  assert.notEqual(saved.proposal, saved.reason, 'reason must not replace proposal body');
});

withTempContext('story_create refuses direct INIT_CHECK creation', (root, store) => {
  const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  assert.throws(() => handlers.story_create({
    name: 'direct-init-check-smoke',
    title: 'Reject direct INIT_CHECK creation',
    description: 'Direct INIT_CHECK creation must not bypass anti-expansion artifacts.',
    type: 'bug',
    priority: 'high',
    background: validBackground(),
    checklist: [{ title: 'Reject direct INIT_CHECK', context: 'Use normal INIT gates instead.' }],
    phase: 'INIT_CHECK',
    forceNew: true,
  }), /story_create cannot directly create INIT_CHECK stories/);
  assert.equal(store.listStoryIds().length, 0, 'direct INIT_CHECK rejection must not write a story');
});

withTempContext('INIT reviewers cannot mutate checklist definitions directly', (root, store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  const handlers = createChecklistHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  assert.throws(() => handlers.checklist_update({
    storyId: STORY_ID,
    itemId: 'CHK-001',
    title: 'Reviewer tries to expand requirements',
    agent: 'koala-review-story-init',
  }), /init_reviewer_checklist_mutation_blocked/);
  assert.throws(() => handlers.checklist_add({
    storyId: STORY_ID,
    title: 'Reviewer adds a requirement',
    context: 'This must be a proposal instead.',
    agent: 'product-reviewer',
  }), /init_reviewer_checklist_mutation_blocked/);
  handlers.checklist_update({
    storyId: STORY_ID,
    itemId: 'CHK-001',
    title: 'Main agent applies an INIT fix',
    actor: 'main-agent',
  });
  assert.equal(store.readChecklist(STORY_ID).items[0].title, 'Main agent applies an INIT fix');
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

withTempStore('feature scope does not apply correctness-fix default excluded keywords', (store) => {
  seedStory(store, { checklistTitle: 'Add Authority scope handling' });
  store.writeScopeBoundary(STORY_ID, buildScopeBoundary({
    storyId: STORY_ID,
    mode: 'feature',
    allowed: ['Authority scope handling feature'],
    confirmedBy: 'scope-anti-expansion-smoke',
    now: NOW,
  }));
  store.writeExecutionBoundary(STORY_ID, buildExecutionBoundary({
    storyId: STORY_ID,
    allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'],
    confirmedBy: 'scope-anti-expansion-smoke',
    now: NOW,
  }));
  freeze(store);
  assert.equal(getScopeAntiExpansionGuardFailureReason(STORY_ID, store, process.cwd()), null);
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

withTempContext('accepted proposal invalidates previous freeze evidence', (root, store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  freeze(store);
  const proposal = buildScopeExtensionProposal({
    proposalId: 'SEP-smoke-accepted',
    storyId: STORY_ID,
    proposedBy: 'koala-review-story-init',
    reason: 'Reviewer proposes a user-decided scope extension.',
    patch: {},
    proposedAt: NOW,
  });
  store.writeScopeExtensionProposals(STORY_ID, {
    storyId: STORY_ID,
    updatedAt: NOW,
    proposals: [proposal],
  });
  const handlers = createScopeAntiExpansionHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  handlers.scope_extension_decide({
    storyId: STORY_ID,
    proposalId: proposal.proposalId,
    decision: 'accepted',
    reason: 'User explicitly accepts this scope extension for smoke verification.',
    decider: 'scope-anti-expansion-smoke',
  });
  expectReason(store, /\[scope_freeze_check_stale\]/);

  freeze(store);
  assert.equal(getScopeAntiExpansionGuardFailureReason(STORY_ID, store, process.cwd()), null);
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
