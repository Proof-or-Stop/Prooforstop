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
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-testintent-handoff-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
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
    background: `## Trigger Event
Round 22 finding F-129 requires this handoff to emit the canonical proof-or-stop-test-intent role.

## Key Insights
The handler must preserve legacy testIntent reads while making newly generated guidance canonical.

## Solution Tradeoffs
The existing handoff regression is the narrowest place to assert role identity and command guidance.

## Conversational Texture
Keep the handoff concise, explicit, and useful to the agent receiving the checklist context.`,
    type: 'feature',
    priority: 'medium',
    checklist: [
      { title: 'Expose handoff command', context: 'Missing testIntent blockers need a next action that respects role boundaries.' },
      {
        title: 'Keep existing intent visible',
        context: 'The handoff should include existing testIntent counts so the agent does not duplicate work.',
        verificationIntent: {
          happy: [{ desc: 'Existing happy intent -> remains visible', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      },
    ],
    forceNew: true,
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert(storyId, `story id not found in ${created}`);

  const handoff = parseJson(run(dir, 'testintent_handoff', { storyId }));
  assert(handoff.agent === 'proof-or-stop-verification-intent', 'handoff should target the canonical proof-or-stop-verification-intent agent');
  assert(handoff.summary.missingIntentItems.includes('CHK-001'), 'missing item should be summarized');
  assert(handoff.summary.existingIntentItems.some((item) => item.itemId === 'CHK-002' && item.happy === 1), 'existing intent counts should be summarized');
  assert(handoff.prompt.includes(`story ${storyId}`), 'prompt should include story id');
  assert(handoff.prompt.includes('You are the proof-or-stop-verification-intent agent'), 'prompt should target the canonical agent');
  assert(handoff.prompt.includes('write verificationIntent for each testable item via proof-or-stop checklist_update'), 'prompt should use canonical verificationIntent guidance');
  assert(handoff.prompt.includes('Main agent must not write verificationIntent'), 'prompt should preserve role boundary');
  assert(!handoff.prompt.includes('write testIntent'), 'prompt should not instruct the agent to write legacy testIntent');
  assert(handoff.prompt.includes('proof-or-stop checklist_update'), 'prompt should include update command guidance');
  assert(handoff.prompt.includes('CHK-001'), 'prompt should include checklist item ids');
  assert(handoff.nextActions[0] === 'Send prompt to the proof-or-stop-verification-intent agent in the story worktree.', 'next action should target the canonical agent');
  assert(handoff.commandExamples.length === 1
    && handoff.commandExamples[0].includes('CHK-001')
    && handoff.commandExamples[0].includes('"verificationIntent"')
    && !handoff.commandExamples[0].includes('testIntent')
    && handoff.commandExamples[0].includes('"agent":"proof-or-stop-verification-intent"'),
  'command examples should focus missing items and use the canonical agent');

  const scoped = parseJson(run(dir, 'testintent_handoff', { storyId, itemIds: ['CHK-002'] }));
  assert(scoped.summary.totalItems === 1, 'itemIds should scope handoff items');
  assert(scoped.summary.missingIntentItems.length === 0, 'scoped existing item should not be marked missing');

  console.log('testintent_handoff verified');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
