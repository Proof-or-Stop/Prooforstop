#!/usr/bin/env node

// Regression: PLAN pins each verification intent to an exact command and test
// selector, and the pin is immutable in DEV. The implementer prompt did not
// show those pins, so workers named their tests freely; the pinned commands then
// selected no test and the owner had to re-dispatch every item just to add
// tests under the pinned names.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { StoryStore } from '../core/store.js';

const MARKER = 'implementer prompt omits the pinned verification commands';
const root = mkdtempSync(join(tmpdir(), 'implementer-pinned-verification-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', testsDir: 'tests', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'pinned@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Pinned Smoke'], { cwd: root });
  const store = new StoryStore(root);
  const storyId = 'B-pinned';
  store.writeStory(storyId, { storyId, title: 'Stepped slices', description: 'Pinned tests', phase: 'DEV', priority: 'high' } as never);
  const pin = (lane: string, n: number, selector: string) => ({
    id: `CHK-001:${lane}:${n}`, desc: `${lane} behaviour ${n}`, type: 'logic',
    verification: { command: `go test -v ./parser -run '^${selector}$'`, selector },
  });
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001', title: 'Parse stepped slices', context: 'parser', status: 'in_progress', relatedDocs: [],
    files: { modify: ['parser/parser.go'], create: [], test: ['parser/parser_test.go'] },
    verificationIntent: {
      happy: [pin('happy', 0, 'TestParsingIndexRangeWithStepExpressions')],
      edge: [pin('edge', 0, 'TestParsingIndexRangeOmittedComponentsWithStepExpressions')],
      adversarial: [{ id: 'CHK-001:adversarial:0', desc: 'unpinned adversarial intent', type: 'logic' }],
    },
  }] } as never);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const { prompt } = createStoryDispatchHandlers({ root, scanRoot: root, store })
    .dispatch({ storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-implementer' });
  for (const selector of ['TestParsingIndexRangeWithStepExpressions', 'TestParsingIndexRangeOmittedComponentsWithStepExpressions']) {
    assert.ok(prompt.includes(`go test -v ./parser -run '^${selector}$'`), `${MARKER}: ${selector} missing`);
  }
  assert.match(prompt, /exact(ly)? (these )?(test )?names?/i, `${MARKER}: no instruction to keep the pinned test names`);
  assert.ok(prompt.includes('CHK-001:adversarial:0'), 'unpinned intents are still listed so the worker covers them');
  console.log('implementer-pinned-verification-prompt-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
