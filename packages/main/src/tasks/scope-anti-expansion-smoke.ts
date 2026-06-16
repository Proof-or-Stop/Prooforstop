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
import { execFileSync } from 'node:child_process';
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
} from '../core/scope-anti-expansion.js';
import type { ChecklistData, ScopeDiscardDigestData, ScopeFreezeCheckData, StoryInfo } from '../core/types.js';
import { createScopeAntiExpansionHandlers } from '../handlers/scope-anti-expansion.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createWorktreeHandlers } from '../handlers/worktree.js';
import { createStoryQueryHandlers } from '../handlers/story-query.js';

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

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createTempGitStore(): { root: string; store: StoryStore } {
  const context = createTempStore();
  git(context.root, ['init']);
  git(context.root, ['config', 'user.email', 'scope-smoke@example.test']);
  git(context.root, ['config', 'user.name', 'Scope Smoke']);
  write(context.root, '.gitignore', [
    '.worktrees/',
    '**/activity.jsonl',
    '.lattice/*',
    '!.lattice/story/',
    '!.lattice/story/**',
    '',
  ].join('\n'));
  write(context.root, 'README.md', 'scope anti-expansion smoke\n');
  git(context.root, ['add', '.']);
  git(context.root, ['commit', '-m', 'init']);
  resetConfigCache();
  return context;
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

function withTempGitContext(label: string, fn: (root: string, store: StoryStore) => void): void {
  const { root, store } = createTempGitStore();
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

function backgroundDirectionOnly(direction: string): string {
  return [
    '## Trigger Event',
    `B-85ba background direction smoke captures the selected direction only in background.md: ${direction}. This sentence stays long enough for the background validator while avoiding title reuse.`,
    '## Key Insights',
    `The old story carries no matching title, description, or checklist terms; the reusable direction is documented here instead: ${direction}.`,
    '## Solution Tradeoffs',
    `The replacement should still be blocked because the discarded scope digest includes background.md terms for this direction: ${direction}.`,
    '## Conversational Texture',
    `The user-visible promise is that discarded background context is not invisible to repeat-discard detection: ${direction}.`,
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
    excludedCommands: ['forbidden-cmd'],
    excludedTools: [],
    confirmedBy: 'scope-anti-expansion-smoke',
    confirmationNote: 'Synthetic execution boundary for smoke coverage.',
    now: NOW,
  }));
}

function projectStory(store: StoryStore) {
  const story = store.readStory(STORY_ID);
  return {
    title: story.title,
    description: story.description,
    background: store.readStoryBackground(STORY_ID) ?? undefined,
  };
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
      excludedCommands: ['forbidden-cmd'],
      blockedPaths: ['packages/main/dist'],
    },
    forceNew: true,
  });
  const storyId = /Story (B-[a-z0-9]+)/.exec(output)?.[1];
  assert.ok(storyId, `story_create output should include story id: ${output}`);
  assert.deepEqual(store.readScopeBoundary(storyId)?.allowed, ['INIT scope freeze correctness']);
  assert.deepEqual(store.readScopeBoundary(storyId)?.excluded, ['Authority expansion']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.allowedCommands, ['npm --prefix packages/main run build']);
  assert.deepEqual(store.readExecutionBoundary(storyId)?.excludedCommands, ['forbidden-cmd']);
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
    reviewer: 'lattice-review-story-init',
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
    agent: 'lattice-review-story-init',
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

withTempContext('INIT reviewers cannot mutate story-level scope fields directly', (root, store) => {
  seedStory(store);
  const handlers = createStoryQueryHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const previousAgent = process.env.LATTICE_AGENT;
  process.env.LATTICE_AGENT = 'lattice-review-story-init';
  try {
    assert.throws(() => handlers.story_update({
      storyId: STORY_ID,
      title: 'Reviewer tries to add future capability',
    }), /init_reviewer_story_scope_mutation_blocked/);
  } finally {
    if (previousAgent === undefined) delete process.env.LATTICE_AGENT;
    else process.env.LATTICE_AGENT = previousAgent;
  }
  assert.throws(() => handlers.story_update({
    storyId: STORY_ID,
    description: 'Product reviewer tries to move future capability into current scope.',
    actor: 'product-reviewer',
  }), /init_reviewer_story_scope_mutation_blocked/);
  assert.throws(() => handlers.story_update({
    storyId: STORY_ID,
    source: 'future-scope-reviewer-note',
    agent: 'lattice-review-story-init',
  }), /init_reviewer_story_scope_mutation_blocked/);

  handlers.story_update({
    storyId: STORY_ID,
    priority: 'medium',
    actor: 'product-reviewer',
  });
  assert.equal(store.readStory(STORY_ID).priority, 'medium', 'reviewer may still update non-scope metadata');

  handlers.story_update({
    storyId: STORY_ID,
    title: 'Main agent applies an INIT story title fix',
    description: 'Main agent keeps this story scoped to the current INIT freeze regression.',
    actor: 'main-agent',
  });
  const updated = store.readStory(STORY_ID);
  assert.equal(updated.title, 'Main agent applies an INIT story title fix');
  assert.equal(updated.description, 'Main agent keeps this story scoped to the current INIT freeze regression.');
});

withTempContext('frozen scope cannot be bypassed by reviewer story_update', (root, store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  freeze(store);
  const handlers = createStoryQueryHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  assert.throws(() => handlers.story_update({
    storyId: STORY_ID,
    title: 'Reviewer smuggles a future capability after freeze',
    agent: 'lattice-review-story-init',
  }), /init_reviewer_story_scope_mutation_blocked/);
  assert.equal(getScopeAntiExpansionGuardFailureReason(STORY_ID, store, root), null, 'blocked reviewer mutation must leave freeze evidence fresh');

  handlers.story_update({
    storyId: STORY_ID,
    title: 'Owner updates title after freeze',
    actor: 'main-agent',
  });
  expectReason(store, /\[scope_freeze_check_stale\]/);
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
    proposedBy: 'lattice-review-story-init',
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
    proposedBy: 'lattice-review-story-init',
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

withTempStore('discard digest updatedAt does not stale freeze but entry or overlap changes do', (store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  const baseEntry = buildScopeDiscardDigestEntry({
    terms: ['unrelated archived scope direction'],
    reason: 'Unrelated archived attempt should be part of the semantic corpus.',
    discardedAt: '2026-06-10T10:00:00.000Z',
    storyId: 'B-discarded-base',
  });
  const extraEntry = buildScopeDiscardDigestEntry({
    terms: ['another unrelated archived direction'],
    reason: 'A new discarded entry should alter the semantic corpus.',
    discardedAt: '2026-06-10T11:00:00.000Z',
    storyId: 'B-discarded-extra',
  });
  const overlapEntry = buildScopeDiscardDigestEntry({
    terms: ['Wire the scope freeze gate'],
    reason: 'A new overlap should invalidate previous freeze evidence.',
    discardedAt: '2026-06-10T12:00:00.000Z',
    storyId: 'B-discarded-overlap',
  });
  const digestAtFirst: ScopeDiscardDigestData = {
    storyId: STORY_ID,
    updatedAt: '2026-06-10T10:00:00.000Z',
    entries: [baseEntry],
  };
  const digestAtSecond: ScopeDiscardDigestData = {
    storyId: STORY_ID,
    updatedAt: '2026-06-10T13:00:00.000Z',
    entries: [baseEntry],
  };
  const digestWithExtraEntry: ScopeDiscardDigestData = {
    storyId: STORY_ID,
    updatedAt: '2026-06-10T14:00:00.000Z',
    entries: [baseEntry, extraEntry],
  };
  const digestWithOverlap: ScopeDiscardDigestData = {
    storyId: STORY_ID,
    updatedAt: '2026-06-10T15:00:00.000Z',
    entries: [baseEntry, overlapEntry],
  };
  const evaluateWithDigest = (discardDigest: ScopeDiscardDigestData): ScopeFreezeCheckData => evaluateScopeFreeze({
    storyId: STORY_ID,
    scopeBoundary: store.readScopeBoundary(STORY_ID),
    executionBoundary: store.readExecutionBoundary(STORY_ID),
    story: projectStory(store),
    checklist: projectChecklist(store),
    discardDigest,
    now: NOW,
  }).check;

  const firstCheck = evaluateWithDigest(digestAtFirst);
  const timestampOnlyCheck = evaluateWithDigest(digestAtSecond);
  assert.equal(
    timestampOnlyCheck.freshnessHash,
    firstCheck.freshnessHash,
    'discardDigest.updatedAt metadata changes must not affect freshnessHash',
  );

  const extraEntryCheck = evaluateWithDigest(digestWithExtraEntry);
  assert.notEqual(
    extraEntryCheck.freshnessHash,
    firstCheck.freshnessHash,
    'new discarded corpus entries must affect freshnessHash',
  );
  const overlapCheck = evaluateWithDigest(digestWithOverlap);
  assert.notEqual(
    overlapCheck.freshnessHash,
    firstCheck.freshnessHash,
    'new discarded overlaps must affect freshnessHash',
  );

  store.writeScopeDiscardDigest(STORY_ID, digestAtFirst);
  store.writeScopeFreezeCheck(STORY_ID, firstCheck);
  store.writeScopeDiscardDigest(STORY_ID, digestAtSecond);
  assert.equal(getScopeAntiExpansionGuardFailureReason(STORY_ID, store, process.cwd()), null);
  store.writeScopeDiscardDigest(STORY_ID, digestWithOverlap);
  expectReason(store, /\[scope_freeze_check_stale\]/);
});

withTempGitContext('real discarded story digest blocks replacement without mitigation and passes with mitigation', (root, store) => {
  const storyHandlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const scopeHandlers = createScopeAntiExpansionHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const worktreeHandlers = createWorktreeHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const replacementTitle = 'Retry the discarded INIT freeze direction';
  const replacementDescription = 'Keep the retry scoped to the same discarded INIT freeze behavior.';
  const checklist = [{ title: 'Wire the discarded direction check', context: 'Reject the replacement unless mitigation is explicit.' }];
  const createStory = (name: string): string => {
    const output = storyHandlers.story_create({
      name,
      title: replacementTitle,
      description: replacementDescription,
      type: 'bug',
      priority: 'high',
      background: validBackground(),
      checklist,
      forceNew: true,
    });
    const storyId = /Story (B-[a-z0-9]+)/.exec(output)?.[1];
    assert.ok(storyId, `story_create output should include story id: ${output}`);
    return storyId;
  };

  const discardedStoryId = createStory('discarded-scope-freeze-direction-smoke');
  const discardOutput = worktreeHandlers.story_discard({
    storyId: discardedStoryId,
    reason: 'Previous attempt selected this direction and was discarded.',
  });
  assert.match(discardOutput, /discard digest recorded/);
  assert.equal(store.readStory(discardedStoryId).phase, 'DISCARDED');

  const replacementStoryId = createStory('replacement-scope-freeze-direction-smoke');
  scopeHandlers.scope_boundary_set({
    storyId: replacementStoryId,
    mode: 'correctness_fix',
    allowedScope: ['INIT anti-expansion gate correctness'],
    excludedScope: ['accepted reviewer expansion without decision'],
    userConfirmed: true,
    actor: 'scope-anti-expansion-smoke',
  });
  scopeHandlers.execution_boundary_set({
    storyId: replacementStoryId,
    allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'],
    excludedCommands: ['forbidden-cmd'],
    actor: 'scope-anti-expansion-smoke',
  });

  const failedFreezeOutput = scopeHandlers.scope_freeze_check({ storyId: replacementStoryId });
  assert.match(failedFreezeOutput, /FAIL/);
  const failedCheck = store.readScopeFreezeCheck(replacementStoryId);
  assert.equal(failedCheck?.repeatDiscardOverlaps[0]?.previousStoryId, discardedStoryId);
  const blockedReason = getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root);
  assert.match(blockedReason ?? '', /\[repeat_discarded_direction\]/);

  const mitigatedOutput = scopeHandlers.scope_freeze_check({
    storyId: replacementStoryId,
    repeatDiscardMitigation: 'This retry narrows the old discarded direction to the INIT_CHECK gate regression only.',
  });
  assert.match(mitigatedOutput, /PASS/);
  assert.equal(getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root), null);

  const secondDiscardedStoryId = createStory('second-discarded-scope-freeze-direction-smoke');
  const secondDiscardOutput = worktreeHandlers.story_discard({
    storyId: secondDiscardedStoryId,
    reason: 'A second attempt selected the same direction and was also discarded.',
  });
  assert.match(secondDiscardOutput, /discard digest recorded/);

  const staleReason = getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root);
  assert.match(staleReason ?? '', /\[scope_freeze_check_stale\]/, 'old mitigated freeze must go stale when aggregate discarded corpus changes');

  const unmitigatedAfterSecondOutput = scopeHandlers.scope_freeze_check({ storyId: replacementStoryId });
  assert.match(unmitigatedAfterSecondOutput, /FAIL/);
  const secondFailedCheck = store.readScopeFreezeCheck(replacementStoryId);
  assert.ok(
    secondFailedCheck?.repeatDiscardOverlaps.some(overlap => overlap.previousStoryId === secondDiscardedStoryId),
    'rerun without mitigation should detect the new discarded overlap',
  );
  assert.match(getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root) ?? '', /\[scope_freeze_check_failed\]|\[repeat_discarded_direction\]/);

  const remitigatedOutput = scopeHandlers.scope_freeze_check({
    storyId: replacementStoryId,
    repeatDiscardMitigation: 'This retry documents why both discarded attempts are narrowed to the INIT_CHECK freshness regression.',
  });
  assert.match(remitigatedOutput, /PASS/);
  assert.equal(getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root), null);
});

withTempGitContext('background-only discarded direction blocks replacement and background edits stale freeze', (root, store) => {
  const storyHandlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const scopeHandlers = createScopeAntiExpansionHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const worktreeHandlers = createWorktreeHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  const oldDirection = 'background-only projection must guard repeat discarded INIT freeze scope';
  const updatedDirection = 'background-only projection now documents a narrowed replacement scope';

  const createStory = (input: {
    name: string;
    title: string;
    description: string;
    checklistTitle: string;
    checklistContext: string;
    background: string;
  }): string => {
    const output = storyHandlers.story_create({
      name: input.name,
      title: input.title,
      description: input.description,
      type: 'bug',
      priority: 'high',
      background: input.background,
      checklist: [{ title: input.checklistTitle, context: input.checklistContext }],
      forceNew: true,
    });
    const storyId = /Story (B-[a-z0-9]+)/.exec(output)?.[1];
    assert.ok(storyId, `story_create output should include story id: ${output}`);
    return storyId;
  };

  const discardedStoryId = createStory({
    name: 'discarded-background-only-direction-smoke',
    title: 'Archive isolated setup attempt',
    description: 'This discarded story has a deliberately unrelated summary.',
    checklistTitle: 'Record isolated setup notes',
    checklistContext: 'Avoid reusable overlap outside background text.',
    background: backgroundDirectionOnly(oldDirection),
  });
  const discardOutput = worktreeHandlers.story_discard({
    storyId: discardedStoryId,
    reason: 'Previous attempt selected this background-only direction and was discarded.',
  });
  assert.match(discardOutput, /discard digest recorded/);
  const discardedDigest = store.readScopeDiscardDigest(discardedStoryId);
  assert.ok(
    discardedDigest.entries[0]?.terms.some(term => term.includes(oldDirection)),
    'story_discard must record background.md terms in scope-discard-digest',
  );

  const replacementStoryId = createStory({
    name: 'replacement-background-only-direction-smoke',
    title: 'Repair separate INIT handoff',
    description: 'This replacement summary intentionally differs from the discarded story.',
    checklistTitle: 'Wire separate handoff validation',
    checklistContext: 'The overlap should come from background text only.',
    background: backgroundDirectionOnly(oldDirection),
  });
  scopeHandlers.scope_boundary_set({
    storyId: replacementStoryId,
    mode: 'correctness_fix',
    allowedScope: ['INIT anti-expansion gate correctness'],
    excludedScope: ['accepted reviewer expansion without decision'],
    userConfirmed: true,
    actor: 'scope-anti-expansion-smoke',
  });
  scopeHandlers.execution_boundary_set({
    storyId: replacementStoryId,
    allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'],
    excludedCommands: ['forbidden-cmd'],
    actor: 'scope-anti-expansion-smoke',
  });

  const failedFreezeOutput = scopeHandlers.scope_freeze_check({ storyId: replacementStoryId });
  assert.match(failedFreezeOutput, /FAIL/);
  const failedCheck = store.readScopeFreezeCheck(replacementStoryId);
  assert.equal(failedCheck?.repeatDiscardOverlaps[0]?.previousStoryId, discardedStoryId);
  assert.match(getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root) ?? '', /\[repeat_discarded_direction\]/);

  const mitigatedOutput = scopeHandlers.scope_freeze_check({
    storyId: replacementStoryId,
    repeatDiscardMitigation: 'This retry narrows the background-only discarded direction to one INIT freeze regression.',
  });
  assert.match(mitigatedOutput, /PASS/);
  assert.equal(getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root), null);

  writeFileSync(store.storyFilePath(replacementStoryId, 'background.md'), backgroundDirectionOnly(updatedDirection), 'utf-8');
  assert.match(
    getScopeAntiExpansionGuardFailureReason(replacementStoryId, store, root) ?? '',
    /\[scope_freeze_check_stale\]/,
    'old passing freeze must go stale when background.md changes',
  );
});

withTempStore('happy path passes with current boundary, freeze, and no pending proposals', (store) => {
  seedStory(store);
  writeGoodBoundaries(store);
  freeze(store);
  assert.equal(getScopeAntiExpansionGuardFailureReason(STORY_ID, store, process.cwd()), null);
});

console.log('✓ scope anti-expansion smoke passed');
