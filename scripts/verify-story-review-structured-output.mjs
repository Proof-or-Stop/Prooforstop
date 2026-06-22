#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages', 'main', 'dist', 'cli.js');
const mode = process.argv[2] || 'all';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(projectRoot, command, payload) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseJson(text) {
  return JSON.parse(text.slice(text.indexOf('{')));
}

function assertPlanReviewRoundSchema(review) {
  assert(Number.isInteger(review.planReviewRound), 'story_review should expose numeric planReviewRound');
  assert(review.planReviewRound >= 1, 'planReviewRound should be 1-based');
  assert(
    review.reviewRound === review.planReviewRound,
    'legacy story_review.reviewRound should remain a numeric PLAN review alias',
  );
}

function assertStableStoryReviewShape(review) {
  assert(review.summary && typeof review.summary.blockerCount === 'number', 'story_review should return summary.blockerCount');
  assert(Array.isArray(review.issues), 'story_review should return issues array');
  assert(typeof review._hint === 'string' && review._hint.length > 0, 'story_review should return _hint');
  assert(typeof review._reviewPrompt === 'string' && review._reviewPrompt.length > 0, 'story_review should preserve _reviewPrompt');
}

function createProject() {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-story-review-output-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(dir, 'docs', 'requirements', 'truth.md'), '# Truth\n\nKeep testIntent complete.\n');
  return dir;
}

function makeStory(projectRoot, suffix, checklist, extra = {}) {
  const created = run(projectRoot, 'story_create', {
    name: `review-output-${suffix}`,
    title: `Review output ${suffix}`,
    background: `## Trigger Event
2026-05-12 B-2a4a structured-output smoke creates a temporary story so story_review response fields can be inspected without touching a real project.

## Key Insights
The smoke is about public CLI output shape, not feature behavior. It must prove the PLAN review count is explicit and does not collide with signed artifact reviewRound semantics.

## Solution Tradeoffs
Use a synthetic project and the real dist CLI. This keeps the check black-box enough to catch response drift while avoiding direct story JSON edits.

## Conversational Texture
The user noticed that a numeric story_review field could be mistaken for findings.json reviewRound. The smoke preserves that distinction as a maintainer-facing contract.`,
    description: 'Verify structured story_review output.',
    type: 'feature',
    priority: extra.priority || 'high',
    checklist,
    forceNew: true,
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`story id not found in ${created}`);
  if (extra.understanding) {
    run(projectRoot, 'understanding_set', {
      storyId,
      task: 'verify structured story review',
      outcome: '> lattice story_review\n{ "actionSummary": {...}, "reviewPromptSummary": {...} }',
      facts: ['review output has structured summary'],
      constraints: ['preserve _reviewPrompt'],
      unknowns: [],
      touchpoints: ['packages/main/src/handlers/story-review.ts'],
    });
  }
  if (extra.decision) {
    run(projectRoot, 'decision_set', {
      storyId,
      principles: ['summary first', 'prompt preserved', 'additive fields'],
      drivers: ['clarity'],
      options: [
        { name: 'Option A', pros: ['small'], cons: ['extra fields'] },
        { name: 'Option B', pros: ['short'], cons: ['breaks prompt'] },
      ],
      chosen: 'Option A',
      rationale: 'A keeps compatibility while improving readability.',
      preMortem: [
        { scenario: 'missing prompt', trigger: 'delete field', consequence: 'reviewer fails', mitigation: 'preserve _reviewPrompt' },
        { scenario: 'wrong next fix', trigger: 'bad derivation', consequence: 'agent wrong action', mitigation: 'derive from issues' },
        { scenario: 'old callers fail', trigger: 'breaking schema', consequence: 'fixture failure', mitigation: 'additive fields' },
      ],
    });
  }
  run(projectRoot, 'scope_check_save', {
    storyId,
    features: [{
      feature: 'structured story_review output shape',
      covered_by: 'scripts/verify-story-review-structured-output.mjs',
      status: 'covered',
      excluded_by: null,
      source: 'synthetic smoke',
    }],
    summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 },
    openQuestions: [],
  });
  return storyId;
}

const checks = {
  'missing-intent': () => {
    const dir = createProject();
    try {
      const storyId = makeStory(dir, 'missing', [{ title: 'Implement output', context: 'missing intent should block' }], { understanding: true });
      const review = parseJson(run(dir, 'story_review', { storyId }));
      assertStableStoryReviewShape(review);
      assertPlanReviewRoundSchema(review);
      assert(review.summary.blockerCount > 0, 'missing intent should produce blocker');
      assert(review.issues.some((i) => i.type === 'missing_verification_intent' || i.type === 'missing_test_intent'), 'missing intent item should be listed');
      assert(review._reviewPrompt.includes('Understanding Snapshot'), 'full _reviewPrompt should include understanding');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  'advisory-only': () => {
    const dir = createProject();
    try {
      const storyId = makeStory(dir, 'advisory', [{
        title: 'Implement output',
        context: 'all intents present',
        testIntent: {
          happy: [{ desc: 'happy ok', type: 'cli_blackbox' }],
          edge: [{ desc: 'edge ok', type: 'cli_blackbox' }],
          adversarial: [{ desc: 'adv ok', type: 'cli_blackbox' }],
        },
      }], { priority: 'low', understanding: true, decision: true });
      const review = parseJson(run(dir, 'story_review', { storyId }));
      assertStableStoryReviewShape(review);
      assertPlanReviewRoundSchema(review);
      assert(review.summary.blockerCount === 0, 'advisory-only review should have no blockers');
      assert('summary' in review && 'issues' in review && '_hint' in review && '_reviewPrompt' in review, 'legacy fields should remain');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  'high-risk': () => {
    const dir = createProject();
    try {
      const storyId = makeStory(dir, 'risk', [{
        title: 'Implement gate',
        context: 'risk story',
        testIntent: {
          happy: [{ desc: 'happy ok', type: 'cli_blackbox' }],
          edge: [{ desc: 'edge ok', type: 'cli_blackbox' }],
          adversarial: [{ desc: 'adv ok', type: 'cli_blackbox' }],
        },
      }], { understanding: true });
      const review = parseJson(run(dir, 'story_review', { storyId }));
      assertStableStoryReviewShape(review);
      assertPlanReviewRoundSchema(review);
      assert(review.issues.some((i) => i.type === 'missing_decision'), 'missing decision blocker should be summarized');
      assert(review._reviewPrompt.includes('Decision'), 'full prompt should include decision section');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  // B-4e06 CHK-002: story_review AND validate must name verification_intent_repair
  // when evidence exists without intent, while keeping the gate HARD.
  'legacy-evidence-no-intent': () => {
    const dir = createProject();
    try {
      const storyId = makeStory(dir, 'legacy', [{ title: 'Implement output', context: 'legacy evidence without intent' }], { understanding: true });
      // Seed PASSING evidence for the happy lane but leave verificationIntent empty.
      run(dir, 'verification_evidence_add', {
        storyId, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0',
        kind: 'integration_test', result: 'pass',
        note: 'legacy evidence recorded before intent was authored, drives the repair hint',
      });
      // story_review: missing-intent stays a HARD blocker AND names the repair command.
      const review = parseJson(run(dir, 'story_review', { storyId }));
      const legacyIssue = review.issues.find(
        (i) => i.type === 'missing_verification_intent' && i.itemId === 'CHK-001' && i.legacyEvidenceWithoutIntent,
      );
      assert(legacyIssue, 'story_review should flag the legacy evidence-without-intent state on CHK-001 happy');
      assert(legacyIssue.severity === 'blocker', 'legacy hint must NOT weaken the missing-intent blocker');
      assert(legacyIssue.repairCommand === 'verification_intent_repair', 'issue should name the repair command');
      assert(/verification_intent_repair/.test(legacyIssue.message), 'message should reference the repair command');
      // A lane WITHOUT evidence keeps the generic blocker (no legacy hint).
      const plainIssue = review.issues.find(
        (i) => i.type === 'missing_verification_intent' && i.itemId === 'CHK-001' && i.message.includes('verificationIntent.edge'),
      );
      assert(plainIssue && !plainIssue.legacyEvidenceWithoutIntent, 'a no-evidence lane should keep the generic blocker');
      // validate: surfaces the same hint additively (never a pass condition).
      const validation = parseJson(run(dir, 'validate', { story: storyId, json: true }));
      assert(
        Array.isArray(validation.legacyEvidenceWithoutIntent) &&
        validation.legacyEvidenceWithoutIntent.some((h) => h.itemId === 'CHK-001' && h.lane === 'happy'),
        'validate should surface a legacyEvidenceWithoutIntent hint for CHK-001 happy',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

if (mode !== 'all') {
  const check = checks[mode];
  if (!check) throw new Error(`unknown verify-story-review-structured-output mode: ${mode}`);
  check();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(checks)) {
  check();
  console.log(`ok ${name}`);
}

console.log('story review structured output verified');
