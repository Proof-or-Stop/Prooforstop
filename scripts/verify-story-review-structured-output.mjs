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

function createProject() {
  const dir = mkdtempSync(join(tmpdir(), 'koala-story-review-output-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'koala.config.json'), JSON.stringify({
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
      outcome: '> koala story_review\n{ "actionSummary": {...}, "reviewPromptSummary": {...} }',
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
  return storyId;
}

const checks = {
  'missing-intent': () => {
    const dir = createProject();
    try {
      const storyId = makeStory(dir, 'missing', [{ title: 'Implement output', context: 'missing intent should block' }], { understanding: true });
      const review = parseJson(run(dir, 'story_review', { storyId }));
      assert(review.summary.blockerCount > 0, 'missing intent should produce blocker');
      assert(review.actionSummary.hasBlockers === true, 'actionSummary should report blockers');
      assert(review.actionSummary.nextFix.includes('testintent_handoff'), 'nextFix should point to the test-intent handoff command');
      assert(review.actionSummary.missingIntentItems.length === 1, 'missing intent item should be listed');
      assert(review.reviewPromptSummary.hasUnderstanding === true, 'reviewPromptSummary should see understanding');
      assert(typeof review._reviewPrompt === 'string' && review._reviewPrompt.length > 0, 'full _reviewPrompt should remain');
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
      assert(review.summary.blockerCount === 0, 'advisory-only review should have no blockers');
      assert(review.actionSummary.canEnterDev === true, 'actionSummary should allow DEV');
      assert(review.actionSummary.nextFix.includes('可进入 DEV') || review.actionSummary.nextFix.includes('补齐 fixture'), 'nextFix should be non-blocking');
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
      assert(review.reviewPromptSummary.hasRiskSignals === true || review.issues.some((i) => i.type === 'risk_signals'), 'risk signal should be visible');
      assert(review.reviewPromptSummary.hasDecision === false, 'missing decision should be summarized');
      assert(review.reviewPromptSummary.hasPreMortem === false, 'missing preMortem should be summarized');
      assert(review.actionSummary.blockerTypes.includes('missing_decision'), 'missing decision blocker should be summarized');
      assert(review._reviewPrompt.includes('Decision'), 'full prompt should include decision section');
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
