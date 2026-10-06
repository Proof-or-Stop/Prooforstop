#!/usr/bin/env node

// Regression (benchmark run 13, abs Go task): the task said "Accept omitted
// components for stepped slices: `value[:end:step]`, `value[start::step]`, and
// `value[::step]`. AST stringification must preserve stepped ranges, for
// example: ...". The Story stored only the owner's paraphrase (background.md /
// index.json), so the PLAN scope-plan reviewer had nothing authoritative to
// trace, and no intent asserted stringification for every listed omitted form.
//
// The verbatim request must be recorded in the Story (request.md, bounded,
// hash-bound, immutable after INIT except by an explicit amendment), handed to
// the scope-plan reviewer and the verification-intent author (not to REVIEW
// lanes), and a mechanical pre-check must name every backticked request literal
// that no checklist title / userSees / verificationIntent states.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStoryCreateHandlers } from '../handlers/story-create.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { computeBackgroundHash } from '../core/init-check-gate.js';
import { StoryStore } from '../core/store.js';

const MARKER = 'scope-plan reviewer prompt omits the verbatim request';
const VARIANTS = 'Accept omitted components for stepped slices: `value[:end:step]`, `value[start::step]`, and `value[::step]`.';
const REQUEST = [
  'Extend indexing ranges so arrays and strings support a third slice component:',
  '',
  '- `value[start:end:step]`',
  '',
  '1. Parser support',
  `- ${VARIANTS}`,
  '- AST stringification must preserve stepped ranges, for example:',
  '  - `myArray[::2]` -> `(myArray[::2])`',
].join('\n');
const BACKGROUND = [
  '## Trigger Event',
  'Benchmark run 13 on 2026-09-30 shipped stepped slices whose omitted-component stringification was never asserted by any intent.',
  '',
  '## Key Insights',
  'The request lists three omitted-component variants; a checklist that names only two of them silently drops the third from verification.',
  '',
  '## Solution Tradeoffs',
  'Record the verbatim request and trace every listed variant to an intent instead of trusting the owner paraphrase stored in the description.',
  '',
  '## Conversational Texture',
  'The user expects every example and every enumerated variant in the task text to be verified exactly, not approximately or by analogy.',
].join('\n');

function capture<T>(fn: () => T): { value: T; stderr: string } {
  let stderr = '';
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    return { value: fn(), stderr };
  } finally {
    process.stderr.write = original as typeof process.stderr.write;
  }
}

const root = mkdtempSync(join(tmpdir(), 'request-traceability-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', testsDir: 'tests', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'trace@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Trace Smoke'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const store = new StoryStore(root);
  const ctx = { root, scanRoot: root, store };
  const create = createStoryCreateHandlers(ctx as never);
  const handlers = create as unknown as Record<string, (args: Record<string, unknown>) => unknown>;

  const created = capture(() => create.story_create({
    name: 'stepped-slices',
    title: 'Support stepped array and string slices',
    description: 'Add value[start:end:step] slicing while keeping existing ranges.',
    type: 'feature',
    priority: 'medium',
    background: BACKGROUND,
    request: REQUEST,
    checklist: [{
      title: 'Parser accepts stepped ranges',
      userSees: 'Parsing `value[start::step]` and `value[::step]` succeeds; `str(parse("myArray[::2]"))` prints `(myArray[::2])`.',
      verificationIntent: {
        happy: [{ desc: 'value[start:end:step] parses', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
        edge: [{ desc: 'value[start::step] parses', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
        adversarial: [{ desc: 'invalid step is rejected', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
      },
    }],
    forceNew: true,
  } as never));
  const storyId = String(created.value).match(/B-[a-z0-9]{4}/)?.[0];
  assert.ok(storyId, `story_create did not report a story id: ${created.value}`);

  const dispatch = createStoryDispatchHandlers(ctx as never);
  // INIT product reviewer: path only (cheap), never the inline text.
  const product = dispatch.dispatch({ storyId, agentType: 'proof-or-stop-product-reviewer' }).prompt;
  assert.ok(product.includes('request.md') && !product.includes(VARIANTS), 'INIT product reviewer must get the request path only');
  const story = store.readStory(storyId);
  store.writeStory(storyId, { ...story, phase: 'PLAN' });
  const scope = dispatch.dispatch({ storyId, agentType: 'proof-or-stop-review-scope-plan' }).prompt;
  assert.ok(scope.includes(VARIANTS), `${MARKER}: the scope-plan prompt lacks the request sentence ${JSON.stringify(VARIANTS)}`);

  // Mechanical pre-check: exactly the unmapped listed variant is reported.
  const unmappedLine = scope.split('\n').find(line => line.includes('Request literals no checklist item states')) ?? '';
  assert.ok(unmappedLine.includes('`value[:end:step]`'), `pre-check did not report the unmapped variant: ${unmappedLine || '(no pre-check line)'}`);
  assert.ok(!unmappedLine.includes('`value[::step]`') && !unmappedLine.includes('`value[start::step]`'), `pre-check reported a mapped variant: ${unmappedLine}`);
  assert.ok(!unmappedLine.includes('`(myArray[::2])`'), `pre-check reported a mapped example output: ${unmappedLine}`);
  assert.match(scope, /every normative sentence, every "for example" and every enumerated variant/, 'scope-plan prompt must state the traceability rule');
  assert.ok(`${created.value}\n${created.stderr}`.includes('`value[:end:step]`'), 'story_create must surface the unmapped literal to the owner at intake');

  // Storage: verbatim, hash-bound, bound into the INIT_CHECK signature domain.
  const requestPath = store.storyFilePath(storyId, 'request.md');
  const meta = JSON.parse(readFileSync(store.storyFilePath(storyId, 'request.json'), 'utf8'));
  assert.equal(readFileSync(requestPath, 'utf8'), `${REQUEST}\n`, 'request.md must be the verbatim request');
  assert.equal(meta.sha256, createHash('sha256').update(`${REQUEST}\n`).digest('hex'));
  assert.equal(meta.truncated, false);
  const bgOnly = createHash('sha256').update(readFileSync(store.storyFilePath(storyId, 'background.md'), 'utf8')).digest('hex');
  assert.notEqual(computeBackgroundHash(root, storyId), bgOnly, 'INIT_CHECK signature must bind request.md');

  // Token discipline: intent authoring gets the request; a REVIEW lane does not.
  const intent = dispatch.dispatch({ storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-verification-intent' }).prompt;
  assert.ok(intent.includes('request.md'), 'verification-intent prompt must point at the verbatim request');
  assert.match(intent, /exact-output intent/, 'verification-intent prompt must ask for exact-output intents per example/variant');
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'REVIEW', currentReviewRound: 'R1' } as never);
  const review = dispatch.dispatch({ storyId, agentType: 'proof-or-stop-review-behavior' }).prompt;
  assert.ok(!review.includes(VARIANTS) && !review.includes('request.md'), 'REVIEW lanes must not receive the request text');
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'PLAN' });

  // Immutable after INIT except by an explicit amendment.
  assert.throws(() => handlers.story_request_set({ storyId, request: `${REQUEST}\n- extra` }), /amendmentReason/);
  handlers.story_request_set({ storyId, request: `${REQUEST}\n- extra`, amendmentReason: 'The user clarified one more required slice form during PLAN.' });
  const amended = JSON.parse(readFileSync(store.storyFilePath(storyId, 'request.json'), 'utf8'));
  assert.equal(amended.amendments.length, 1, 'the amendment must be recorded');
  assert.equal(amended.amendments[0].previousSha256, meta.sha256);

  // Hand edits are detected, not trusted.
  writeFileSync(requestPath, 'tampered\n');
  const tampered = dispatch.dispatch({ storyId, agentType: 'proof-or-stop-review-scope-plan' }).prompt;
  assert.match(tampered, /request\.md does not match request\.json/, 'a hand-edited request must be flagged');
  assert.ok(!tampered.includes('tampered\n'), 'a hand-edited request must not be presented as authoritative');

  // Bounded: a 20 KB request is truncated with a clear marker.
  const big = 'x'.repeat(20 * 1024);
  const staged = handlers.story_request_set({ request: big });
  assert.match(String(staged), /staged/i, 'story_request_set without storyId stages the next story_create request');
  const second = capture(() => create.story_create({
    name: 'second', title: 'Second story', description: 'Uses the staged request.', type: 'feature', priority: 'medium',
    background: BACKGROUND, checklist: [{ title: 'Do it' }], forceNew: true,
  } as never));
  const secondId = String(second.value).match(/B-[a-z0-9]{4}/)?.[0];
  assert.ok(secondId && secondId !== storyId);
  const bounded = readFileSync(store.storyFilePath(secondId, 'request.md'), 'utf8');
  assert.ok(Buffer.byteLength(bounded) <= 16 * 1024, 'request.md must be bounded to 16 KB');
  assert.match(bounded, /\[proof-or-stop: request truncated at \d+ of 20480 bytes/);
  assert.ok(!existsSync(join(root, '.proof-or-stop', 'runtime', 'staged-story-request.md')), 'the staged request is consumed once');
  console.log('request-traceability-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
