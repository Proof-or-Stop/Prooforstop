#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages', 'main', 'dist', 'cli.js');

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
  const dir = mkdtempSync(join(tmpdir(), 'lattice-testintent-handoff-'));
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
  writeFileSync(join(dir, 'docs', 'requirements', 'truth.md'), '# Truth\n\nIntent handoff should be explicit.\n');
  return dir;
}

const dir = createProject();
try {
  const created = run(dir, 'story_create', {
    name: 'testintent-handoff',
    title: 'Generate testIntent handoff',
    description: 'PLAN gate should tell the main agent how to hand missing testIntent work to the test-intent agent.',
    type: 'feature',
    priority: 'medium',
    checklist: [
      { title: 'Expose handoff command', context: 'Missing testIntent blockers need a next action that respects role boundaries.' },
      {
        title: 'Keep existing intent visible',
        context: 'The handoff should include existing testIntent counts so the agent does not duplicate work.',
        testIntent: {
          happy: [{ desc: 'Existing happy intent -> remains visible', type: 'cli_blackbox' }],
          edge: [],
          adversarial: [],
        },
      },
    ],
    forceNew: true,
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert(storyId, `story id not found in ${created}`);

  const review = parseJson(run(dir, 'story_review', { storyId }));
  assert(review.actionSummary.nextFix.includes('testintent_handoff'), 'story_review nextFix should point to testintent_handoff');
  assert(review._hint.includes('testintent_handoff'), 'story_review hint should point to testintent_handoff');

  const handoff = parseJson(run(dir, 'testintent_handoff', { storyId }));
  assert(handoff.agent === 'test-intent', 'handoff should target the test-intent agent');
  assert(handoff.summary.missingIntentItems.includes('CHK-001'), 'missing item should be summarized');
  assert(handoff.summary.existingIntentItems.some((item) => item.itemId === 'CHK-002' && item.happy === 1), 'existing intent counts should be summarized');
  assert(handoff.prompt.includes(`story ${storyId}`), 'prompt should include story id');
  assert(handoff.prompt.includes('Main agent must not write testIntent'), 'prompt should preserve role boundary');
  assert(handoff.prompt.includes('lattice checklist_update'), 'prompt should include update command guidance');
  assert(handoff.prompt.includes('CHK-001'), 'prompt should include checklist item ids');
  assert(handoff.commandExamples.length === 1 && handoff.commandExamples[0].includes('CHK-001'), 'command examples should focus missing items');

  const scoped = parseJson(run(dir, 'testintent_handoff', { storyId, itemIds: ['CHK-002'] }));
  assert(scoped.summary.totalItems === 1, 'itemIds should scope handoff items');
  assert(scoped.summary.missingIntentItems.length === 0, 'scoped existing item should not be marked missing');

  console.log('testintent_handoff verified');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
