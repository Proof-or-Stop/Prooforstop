#!/usr/bin/env node

// Regression: a finding-repair worker received only the reviewer's single
// counterexample, so it fixed exactly that case (explicit null in a stepped
// range) and left the sibling with the same root cause (explicit null in a
// two-part range) for the next full review round to find. The repair prompt
// must ask for the whole defect family: enumerate the sibling paths with the
// same root cause, test each, and fix them together.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { StoryStore } from '../core/store.js';

const MARKER = 'finding repair prompt does not ask for the whole defect family';
const root = mkdtempSync(join(tmpdir(), 'finding-repair-family-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', testsDir: 'tests', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'family@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Family Smoke'], { cwd: root });
  const store = new StoryStore(root);
  const storyId = 'B-family';
  store.writeStory(storyId, { storyId, title: 'Stepped slices', description: 'Null handling', phase: 'DEV', priority: 'medium' } as never);
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001', title: 'Stepped reads', context: 'evaluator', status: 'done', relatedDocs: [],
    files: { modify: ['evaluator/evaluator.go'], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
  }] } as never);
  store.writeFindings(storyId, { findings: [{
    id: `${storyId}:F-002`, desc: 'a[0:2:null] treats an explicit null step as omitted instead of raising the numeric-range error',
    severity: 'high', category: 'edge', status: 'open', agent: 'proof-or-stop-review-test-coverage', files: ['evaluator/evaluator.go'],
  }] } as never);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const { prompt } = createStoryDispatchHandlers({ root, scanRoot: root, store })
    .dispatch({ storyId, findingId: 'F-002', agentType: 'proof-or-stop-finding-repair' });
  assert.match(prompt, /same root cause/i, `${MARKER}: no same-root-cause instruction`);
  assert.match(prompt, /sibling/i, `${MARKER}: no sibling-path instruction`);
  assert.match(prompt, /test (for )?each/i, `${MARKER}: no per-sibling test instruction`);
  console.log('finding-repair-family-prompt-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
