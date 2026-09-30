#!/usr/bin/env node

// Regression (benchmark run 13, abs Go task): the item's userSees and its
// verification intents named the exact error text, but the implementer prompt
// only pointed at plan.md. Two managed implementers produced working behavior
// with the wrong error strings, and the owner had to append an exact-error
// acceptance and rerun the implementer each time. The implementer prompt (and
// the finding-repair prompt for findings that name the item) must carry every
// exact user-visible string verbatim, labelled as byte-for-byte required, and
// must not invent strings the item does not state.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { StoryStore } from '../core/store.js';

const MARKER = 'implementer prompt omits the exact required output strings';
const HEADER = 'Exact required output — must match byte-for-byte';
const SIZE = 'range assignment size mismatch: target=3 value=2';
const STEP = 'ERROR: step must be non-zero';
const TRANSCRIPT = 'abs: 1:1: range assignment size mismatch: target=3 value=2';
const ACCEPT = 'range assignment size mismatch: target=<X> value=<Y>';

function section(prompt: string): string | undefined {
  const start = prompt.indexOf(HEADER);
  if (start < 0) return undefined;
  const end = prompt.indexOf('\n\n', start);
  return prompt.slice(start, end < 0 ? undefined : end);
}

const root = mkdtempSync(join(tmpdir(), 'implementer-exact-output-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', testsDir: 'tests', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'exact@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Exact Smoke'], { cwd: root });
  const store = new StoryStore(root);
  const storyId = 'B-exact';
  store.writeStory(storyId, { storyId, title: 'Range assignment', description: 'Exact errors', phase: 'DEV', priority: 'high' } as never);
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-003', title: 'Range assignment size check', context: 'evaluator', status: 'in_progress', relatedDocs: [],
    userSees: [
      `Assigning two values to a three-element range fails with \`${SIZE}\`.`,
      '```',
      '$ abs range.abs',
      TRANSCRIPT,
      '```',
    ].join('\n'),
    files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
    verificationIntent: {
      happy: [{ id: 'CHK-003:happy:0', desc: 'equal-size range assignment succeeds', type: 'logic',
        verification: { command: "go test ./evaluator -run '^TestRangeAssign$'", selector: 'TestRangeAssign' } }],
      edge: [{ id: 'CHK-003:edge:0', desc: `zero step prints "${STEP}" on stderr`, type: 'cli',
        verification: { command: 'go run . step.abs', selector: STEP } }],
      adversarial: [{ id: 'CHK-003:adversarial:0', priority: 'must', type: 'logic',
        desc: `mismatched sizes return exactly \`${ACCEPT}\`` }],
    },
  }, {
    id: 'CHK-004', title: 'Refactor helper', context: 'internal', status: 'pending', relatedDocs: [],
    userSees: 'No visible change; the existing tests keep passing.',
    verificationIntent: { happy: [{ id: 'CHK-004:happy:0', desc: 'existing tests pass', type: 'logic' }], edge: [], adversarial: [] },
  }, {
    id: 'CHK-005', title: 'Many messages', context: 'bulk', status: 'pending', relatedDocs: [],
    userSees: Array.from({ length: 30 }, (_v, i) => `"bulk error number ${i}"`).join(', '),
  }] } as never);
  store.writeFindings(storyId, { findings: [{
    id: `${storyId}:F-001`, desc: 'evaluator/evaluator.go:88 CHK-003 prints the wrong mismatch message (high)',
    severity: 'high', category: 'edge', status: 'open', agent: 'proof-or-stop-review-behavior',
  }] } as never);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const handlers = createStoryDispatchHandlers({ root, scanRoot: root, store });
  const { prompt } = handlers.dispatch({ storyId, itemId: 'CHK-003', agentType: 'proof-or-stop-implementer' });
  const exact = section(prompt);
  assert.ok(exact, `${MARKER}: no "${HEADER}" section`);
  for (const text of [SIZE, TRANSCRIPT, STEP, ACCEPT]) {
    assert.ok(exact.includes(text), `${MARKER}: ${JSON.stringify(text)} missing from the labelled section`);
  }
  assert.ok(!exact.includes('length mismatch'), 'the section invented a string the item does not state');
  assert.ok(!exact.includes('TestRangeAssign'), 'a logic test name is not user-visible output');
  assert.ok(!exact.includes('$ abs range.abs'), 'a transcript command line is input, not required output');

  const plain = handlers.dispatch({ storyId, itemId: 'CHK-004', agentType: 'proof-or-stop-implementer' }).prompt;
  assert.equal(section(plain), undefined, 'an item without exact strings must not get an invented section');

  const bulk = section(handlers.dispatch({ storyId, itemId: 'CHK-005', agentType: 'proof-or-stop-implementer' }).prompt) ?? '';
  assert.ok(bulk.includes('bulk error number 0') && !bulk.includes('bulk error number 29'), 'the section must stay bounded');
  assert.match(bulk, /6 more exact string\(s\) omitted/, 'a truncated section must say how many strings it omitted');

  const repair = handlers.dispatch({ storyId, findingId: 'F-001', agentType: 'proof-or-stop-finding-repair' }).prompt;
  const repairExact = section(repair);
  assert.ok(repairExact, `${MARKER}: finding-repair prompt for a CHK-003 finding has no labelled section`);
  for (const text of [SIZE, STEP, ACCEPT]) assert.ok(repairExact.includes(text), `${MARKER}: repair prompt lacks ${JSON.stringify(text)}`);
  console.log('implementer-exact-output-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
