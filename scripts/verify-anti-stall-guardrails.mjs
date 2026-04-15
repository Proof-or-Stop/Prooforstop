#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join } from 'path';
import { renderAntiStall, reviewAntiStall, testAntiStall, waitingAntiStall } from '../packages/main/dist/core/anti-stall.js';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectAllActions(text, label) {
  assert(text.includes('retry:'), `${label} missing retry action`);
  assert(text.includes('fix:'), `${label} missing fix action`);
  assert(text.includes('discard:'), `${label} missing discard action`);
}

expectAllActions(renderAntiStall({
  storyId: 'B-test',
  retry: 're-run the same check',
  fix: 'return to DEV and change code',
}), 'renderAntiStall');
expectAllActions(reviewAntiStall('B-test'), 'reviewAntiStall');
expectAllActions(testAntiStall('B-test', ['BUG-123']), 'testAntiStall');
expectAllActions(waitingAntiStall('B-test'), 'waitingAntiStall');

const checklistSource = readFileSync(join(root, 'packages/main/src/handlers/checklist.ts'), 'utf8');
assert(checklistSource.includes('reviewAntiStall('), 'checklist.ts missing reviewAntiStall usage');
assert(checklistSource.includes('waitingAntiStall('), 'checklist.ts missing waitingAntiStall usage');
assert(checklistSource.includes('renderAntiStall({'), 'checklist.ts missing renderAntiStall blocked branch');

const sessionSource = readFileSync(join(root, 'packages/main/src/handlers/session.ts'), 'utf8');
assert(sessionSource.includes('reviewAntiStall('), 'session.ts missing reviewAntiStall usage');
assert(sessionSource.includes('testAntiStall('), 'session.ts missing testAntiStall usage');
assert(sessionSource.includes('waitingAntiStall('), 'session.ts missing waitingAntiStall usage');

const advanceSource = readFileSync(join(root, 'packages/main/src/handlers/story-advance.ts'), 'utf8');
assert(advanceSource.includes('reviewAntiStall('), 'story-advance.ts missing reviewAntiStall usage');
assert(advanceSource.includes('testAntiStall('), 'story-advance.ts missing testAntiStall usage');

const staleSource = readFileSync(join(root, 'packages/main/src/core/stale-detector.ts'), 'utf8');
assert(staleSource.includes('reviewAntiStall('), 'stale-detector.ts missing reviewAntiStall usage');
assert(staleSource.includes('testAntiStall('), 'stale-detector.ts missing testAntiStall usage');
assert(staleSource.includes('waitingAntiStall('), 'stale-detector.ts missing waitingAntiStall usage');

console.log('anti-stall guardrails verified');
