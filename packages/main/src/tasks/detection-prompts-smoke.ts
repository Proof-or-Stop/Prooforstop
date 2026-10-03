#!/usr/bin/env node

// Regression (benchmark run 13, abs Go task): the parser filled an omitted range
// start with 0, so AST String() printed `(myArray[0:5:2])` instead of
// `(myArray[:5:2])`. Round-1 review found the root cause; the repair added a
// StartOmitted flag and fixed every evaluation path but never String(), the
// round-2 concept reviewer called String() "unrelated", and the implementer's own
// test asserted the wrong rendering. Three detection gaps:
//   C. the behavior lane never auto-selected: BEHAVIOR_TRIGGERS matched the
//      category exactly ('gate') while story_create emits 'State Machine/Gate';
//   A. neither the finding-repair prompt nor the concept reviewer asked for a
//      sweep of every reader (render/String()/serialize/equality/hash) of a field
//      whose meaning changed;
//   B. test-coverage and quality never checked an asserted value against the
//      requirement, so a test locking in a contradicting value passed review.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';

const background = '## Trigger Event\nA benchmark request on 2026-09-29 asks for stepped index ranges in the evaluator.\n\n## Key Insights\nThe parser and evaluator both need the third component.\n\n## Solution Tradeoffs\nExtend the existing range node instead of adding a new node.\n\n## Conversational Texture\nThe requester wants omitted slice components preserved as written.';

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', testsDir: 'tests', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=p@example.invalid', '-c', 'user.name=P', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  resetConfigCache();
  return root;
}

function laneReasonFor(title: string, description: string): string | undefined {
  const root = fixtureRoot('detection-prompts-lane-');
  try {
    const store = new StoryStore(root);
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: root, log: () => {} });
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = () => true;
    try {
      handlers.story_create({
        name: 'lane', title, type: 'feature', priority: 'medium', description, background,
        checklist: [{ title: 'Change the flow', context: 'core' }], forceNew: true,
      } as never);
    } finally {
      process.stderr.write = originalWrite as typeof process.stderr.write;
    }
    const storyId = store.listStoryIds()[0];
    assert.ok(storyId, 'story_create wrote no story');
    const story = store.readStory(storyId);
    const reviewers = computeActiveReviewers(story, store.readChecklist(storyId), null, []);
    return reviewers.find(r => r.name === 'behavior')?.reason;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// C. behavior lane selection from the real story_create risk detector.
const gateReason = laneReasonFor('Tighten the state machine DONE gate', 'The state machine must refuse DONE while a finding is open.');
assert.ok(gateReason, 'behavior lane not selected for a story whose risk detector reported State Machine/Gate');
assert.match(gateReason, /state machine/);
assert.equal(laneReasonFor('Rotate the auth token', 'Credentials rotate daily.'), undefined, 'a non-gate risk category must not select the behavior lane');
assert.equal(laneReasonFor('Support stepped index ranges', 'Arrays accept start:end:step slices.'), undefined, 'a story without risk wording must not select the behavior lane');

// A. finding-repair prompt carries the consumer sweep.
{
  const root = fixtureRoot('detection-prompts-repair-');
  try {
    const store = new StoryStore(root);
    const storyId = 'B-sweep';
    store.writeStory(storyId, { storyId, title: 'Slices', description: 'Omitted slice components', phase: 'DEV', priority: 'medium' } as never);
    store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Parse slices', context: 'parser', status: 'in_progress', relatedDocs: [] }] } as never);
    store.writeFindings(storyId, { findings: [{
      id: `${storyId}:F-001`, desc: 'parser/parser.go:40 fills an omitted start with 0', severity: 'medium', category: 'edge', status: 'open', agent: 'proof-or-stop-review-quality',
    }] } as never);
    const handlers = createStoryDispatchHandlers({ root, scanRoot: root, store });
    const repair = handlers.dispatch({ storyId, findingId: 'F-001', agentType: 'proof-or-stop-finding-repair' }).prompt;
    assert.match(repair, /changes what a field or encoding means/, 'finding-repair prompt lacks the consumer-sweep instruction');
    for (const reader of ['String()', 'serialize', 'equality', 'hash']) {
      assert.ok(repair.includes(reader), `finding-repair consumer sweep does not name ${reader}`);
    }
    assert.match(repair, /concrete reason tied to the request/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A + B. reviewer role templates.
const templates = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'agents');
const template = (role: string) => readFileSync(join(templates, `proof-or-stop-review-${role}.md`), 'utf8');
const concept = template('concept');
assert.match(concept, /changes what an existing field or encoding means/, 'concept template lacks the consumer sweep');
assert.match(concept, /String\(\)/);
assert.match(concept, /Never mark a reader "unrelated"/, 'concept template lets a reader be called unrelated without a reason');
for (const role of ['test-coverage', 'quality']) {
  assert.match(template(role), /contradicts the requirement/, `${role} template lacks the assertion-correctness rule`);
}
console.log('detection-prompts-smoke: PASS');
