#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join } from 'path';
import { renderAntiStall, reviewAntiStall, testAntiStall, waitingAntiStall } from '../packages/main/dist/core/anti-stall.js';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectAllActions(text, label) {
  assert(text.includes('[retry]'), `${label} missing [retry] action`);
  assert(text.includes('[fix]'), `${label} missing [fix] action`);
  assert(text.includes('[discard]'), `${label} missing [discard] action`);
  assert(!text.includes('retry:'), `${label} regressed to legacy retry: label`);
  assert(!text.includes('fix:'), `${label} regressed to legacy fix: label`);
  assert(!text.includes('discard:'), `${label} regressed to legacy discard: label`);
}

expectAllActions(renderAntiStall({
  storyId: 'B-test',
  retry: 're-run the same check',
  fix: 'return to DEV and change code',
}), 'renderAntiStall');
expectAllActions(reviewAntiStall('B-test'), 'reviewAntiStall');
expectAllActions(testAntiStall('B-test', ['BUG-123']), 'testAntiStall');
expectAllActions(waitingAntiStall('B-test'), 'waitingAntiStall');

const antiStallSource = readFileSync(join(root, 'packages/main/src/core/anti-stall.ts'), 'utf8');
assert(antiStallSource.includes('[retry]'), 'anti-stall source missing hard-coded [retry] label');
assert(antiStallSource.includes('[fix]'), 'anti-stall source missing hard-coded [fix] label');
assert(antiStallSource.includes('[discard]'), 'anti-stall source missing hard-coded [discard] label');

const sessionSource = readFileSync(join(root, 'packages/main/src/handlers/session.ts'), 'utf8');
assert(sessionSource.includes('reviewAntiStall('), 'session.ts missing reviewAntiStall usage');
assert(sessionSource.includes('testAntiStall('), 'session.ts missing testAntiStall usage');
assert(sessionSource.includes('renderAntiStall({'), 'session.ts missing renderAntiStall custom REVIEW branch');

console.log('anti-stall guardrails verified');
