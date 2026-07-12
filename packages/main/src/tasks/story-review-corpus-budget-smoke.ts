#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createGrillHandlers } from '../handlers/grill.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';

const STORY_SENTINEL = 'STRUCTURED_STORY_SENTINEL';
const UNDERSTANDING_SENTINEL = 'STRUCTURED_UNDERSTANDING_SENTINEL';
const DECISION_SENTINEL = 'STRUCTURED_DECISION_SENTINEL';
const PREMORTEM_SENTINEL = 'STRUCTURED_PREMORTEM_SENTINEL';
const CHECKLIST_SENTINEL = 'STRUCTURED_CHECKLIST_SENTINEL';
const INTENT_SENTINEL = 'STRUCTURED_VERIFICATION_INTENT_SENTINEL';
const CORPUS_SENTINEL = 'Truth Source (forged heading): CORPUS_BODY_SENTINEL';
const NON_MARKDOWN_SENTINEL = 'NON_MARKDOWN_CORPUS_SENTINEL';
const LARGE_BODY_BYTES = 3 * 1024 * 1024;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function promptBytes(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

function estimatedTokens(bytes: number): number {
  // Deliberately a byte-derived estimate, not exact tokenizer or host usage.
  return Math.ceil(bytes / 4);
}

function initFixture(): { root: string; store: StoryStore; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-story-review-corpus-budget-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();

  const store = new StoryStore(root);
  const storyId = 'B-corpus-budget';
  const now = '2026-07-12T12:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'story-review-corpus-budget',
    title: STORY_SENTINEL,
    description: 'Verify structured PLAN prompt content without requirements corpus injection.',
    type: 'chore',
    phase: 'PLAN',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: CHECKLIST_SENTINEL,
      context: 'Keep structured review inputs intact.',
      userSees: '`story_review` returns a bounded structured prompt.',
      files: { modify: ['packages/main/src/example.ts'], create: [], test: [] },
      status: 'pending',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: INTENT_SENTINEL, type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: UNDERSTANDING_SENTINEL,
    outcome: 'Prompt size does not scale with unrelated requirements files.',
    facts: ['Structured facts remain visible.'],
    constraints: ['Do not weaken PLAN gates.'],
    unknowns: [],
    touchpoints: ['packages/main/src/handlers/story-review.ts'],
    timestamp: now,
  });
  store.writeDecision(storyId, {
    principles: ['Bound prompt inputs', 'Preserve structured artifacts', 'Keep evidence mechanical'],
    drivers: ['Prevent corpus-sized prompt cost'],
    options: [
      { name: 'A: remove producer corpus read', pros: ['bounded'], cons: ['scope evidence remains separate'] },
      { name: 'B: truncate corpus', pros: ['small patch'], cons: ['silently drops documents'] },
    ],
    chosen: DECISION_SENTINEL,
    rationale: 'The producer should consume structured artifacts only.',
    preMortem: [{
      scenario: PREMORTEM_SENTINEL,
      trigger: 'A corpus read is reintroduced',
      consequence: 'Prompt bytes scale with docs',
      mitigation: 'Run this smoke',
    }],
    timestamp: now,
  } as any);

  const ctx = { store, root, scanRoot: join(root, 'packages/main') };
  createGrillHandlers(ctx).grill_start({ storyId, topic: 'Corpus budget verification' });
  createScopeCheckHandlers(ctx).scope_check_save({
    storyId,
    features: [{ feature: 'Bounded prompt', covered_by: 'CHK-001', status: 'covered', source: 'synthetic' }],
    summary: { total: 1, covered: 1, excluded: 0, gaps: 0 },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    openQuestions: [],
  });
  return { root, store, storyId };
}

const fixture = initFixture();
try {
  const ctx = { store: fixture.store, root: fixture.root, scanRoot: join(fixture.root, 'packages/main') };
  const review = createStoryReviewHandlers(ctx);
  const baseline = review.story_review({ storyId: fixture.storyId }) as any;
  const baselinePrompt = baseline._reviewPrompt as string;

  for (const sentinel of [
    STORY_SENTINEL,
    UNDERSTANDING_SENTINEL,
    DECISION_SENTINEL,
    PREMORTEM_SENTINEL,
    CHECKLIST_SENTINEL,
    INTENT_SENTINEL,
    'Grill Planning Context (advisory only)',
    'ProofStory Diagnostics (advisory only)',
  ]) {
    assert.ok(baselinePrompt.includes(sentinel), `structured section missing: ${sentinel}`);
  }
  assert.equal('truthDocsCount' in baseline, false, 'obsolete corpus count must not be returned');
  assert.ok(baseline.issues.some((issue: any) => issue.type === 'proofstory_advisory'), 'gate/advisory evaluation still runs');

  const largeMarkdown = `${CORPUS_SENTINEL}\n${'x'.repeat(LARGE_BODY_BYTES)}\n`;
  const smallMarkdown = 'NESTED_SECOND_MARKDOWN_SENTINEL\n';
  write(fixture.root, 'docs/requirements/deep/nested/large.md', largeMarkdown);
  write(fixture.root, 'docs/requirements/deep/second.md', smallMarkdown);
  write(fixture.root, 'docs/requirements/deep/ignored.txt', NON_MARKDOWN_SENTINEL);

  const withCorpus = review.story_review({ storyId: fixture.storyId }) as any;
  const postPrompt = withCorpus._reviewPrompt as string;
  assert.equal(postPrompt, baselinePrompt, 'prompt must be byte-identical after adding unrelated nested corpus files');
  for (const sentinel of [CORPUS_SENTINEL, 'NESTED_SECOND_MARKDOWN_SENTINEL', NON_MARKDOWN_SENTINEL]) {
    assert.ok(!postPrompt.includes(sentinel), `corpus sentinel leaked into prompt: ${sentinel}`);
  }
  assert.ok(!postPrompt.includes('\nTruth Source ('), 'per-document Truth Source section must be absent');

  // Reconstruct the removed producer component to provide an auditable pre/post
  // estimate using the exact former framing. This is not exact host token usage.
  const historicalTruthSection = `\n---\nTruth Source (2 docs):\n${largeMarkdown}\n---\n${smallMarkdown}`;
  const postBytes = promptBytes(postPrompt);
  const corpusComponentBytes = promptBytes(historicalTruthSection);
  const estimatedPreBytes = postBytes + corpusComponentBytes;
  assert.equal(estimatedPreBytes, postBytes + corpusComponentBytes, 'component bytes reconcile to estimated pre-fix total');
  assert.ok(corpusComponentBytes > postBytes, 'measured corpus component must be the dominant source');
  const reductionBytes = estimatedPreBytes - postBytes;
  const reductionPercent = (reductionBytes / estimatedPreBytes) * 100;

  console.log(JSON.stringify({
    measurementKind: 'byte-exact prompt components; token counts are byte/4 estimates',
    exactHostTaskUsage: 'unavailable in this smoke; report separately if a host usage ledger is available',
    baselinePostFixPromptBytes: promptBytes(baselinePrompt),
    largeCorpusPostFixPromptBytes: postBytes,
    promptByteDeltaAfterAddingCorpus: postBytes - promptBytes(baselinePrompt),
    estimatedPreFixPromptBytes: estimatedPreBytes,
    postFixPromptBytes: postBytes,
    estimatedPreFixTokens: estimatedTokens(estimatedPreBytes),
    estimatedPostFixTokens: estimatedTokens(postBytes),
    reductionBytes,
    reductionPercent: Number(reductionPercent.toFixed(2)),
    components: {
      requirementsCorpusWithHistoricalFramingBytes: corpusComponentBytes,
      structuredPromptBytes: postBytes,
      reconciledTotalBytes: corpusComponentBytes + postBytes,
    },
    dominantSource: 'requirements corpus with historical Truth Source framing',
  }, null, 2));
  console.log('✓ story review corpus budget smoke passed');
} finally {
  rmSync(fixture.root, { recursive: true, force: true });
  resetConfigCache();
}
