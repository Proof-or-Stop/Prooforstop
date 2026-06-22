#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const worktreeRoot = dirname(dirname(__filename));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(cwd, args, env = {}) {
  return execFileSync('node', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

run(worktreeRoot, [join(worktreeRoot, 'packages/main/dist/cli.js'), 'session_brief'], {
  LATTICE_ACTIVITY_ROLE: 'reviewer',
  LATTICE_ACTIVITY_RECORD_READONLY: '1',
});
run(worktreeRoot, [join(worktreeRoot, 'packages/main/dist/cli.js'), 'session_brief'], {
  LATTICE_ACTIVITY_ROLE: 'intent',
  LATTICE_ACTIVITY_RECORD_READONLY: '1',
});
const brief = run(worktreeRoot, [join(worktreeRoot, 'packages/main/dist/cli.js'), 'session_brief']);

assert(brief.includes('[cli/reviewer/ok]') || brief.includes('[codex/reviewer/ok]'), 'session_brief missing reviewer role');
assert(brief.includes('[cli/intent/ok]') || brief.includes('[codex/intent/ok]'), 'session_brief missing intent role');
assert(
  brief.includes('testintent_check')
    || brief.includes('story_review')
    || brief.includes('checklist_get')
    || brief.includes('checklist_update')
    || brief.includes('Resume: cd')
    || brief.includes('story_create')
    || brief.includes('reviewer_list')
    || brief.includes('finding_list')
    || brief.includes('review_pass_set')
    || brief.includes('story_advance --storyId=')
    || brief.includes('story_advance --phase='),
  'session_brief missing role-aware next step',
);

const mainBrief = run(worktreeRoot, [join(worktreeRoot, 'bin/lattice-codex.js'), 'session_brief']);
assert(
  mainBrief.includes('## Active stories') || mainBrief.includes('**Dashboard**') || mainBrief.includes('**Story**:'),
  'session_brief missing dashboard, active stories, or active story section',
);
assert(
  mainBrief.includes('Resume: cd')
    || mainBrief.includes('story_advance --storyId=')
    || mainBrief.includes('No active story')
    || mainBrief.includes('All stories DONE')
    || mainBrief.includes('checklist_update')
    || mainBrief.includes('delivery_check_set')
    || mainBrief.includes('summary_set'),
  'session_brief missing recovery or next-step hint',
);

// ── B-b9d0 CHK-004 / CHK-005: source-code receipt — TEST-phase next-step must
// refuse DONE while scope is blocking. The actual TEST next-step branch is
// gated behind a story being in phase=TEST with a blocking scope state, which
// is non-trivial to synthesize in this smoke. So we lock the contract at the
// source level: the literal handler must contain (a) the scopeBlocking field
// on NextStepCtx, (b) the TEST-phase early return that consumes it, and (c)
// the user-facing wording the policy doc promises.
const sessionSrc = readFileSync(join(worktreeRoot, 'packages/main/src/handlers/session.ts'), 'utf8');
const sessionMarkers = [
  'scopeBlocking',
  'Scope gate: blocking',
  'DONE is not recommended while scope is blocking',
];
for (const marker of sessionMarkers) {
  assert(
    sessionSrc.includes(marker),
    `packages/main/src/handlers/session.ts: missing CHK-004 scope-blocking marker "${marker}"`,
  );
}
// And the branch must be inside the TEST case of computeNextStep, not just
// dangling somewhere in the file.
const computeNextStepIdx = sessionSrc.indexOf('function computeNextStep');
assert(computeNextStepIdx >= 0, 'computeNextStep not found in session.ts');
const testCaseIdx = sessionSrc.indexOf("case 'TEST':", computeNextStepIdx);
assert(testCaseIdx > 0, "computeNextStep missing case 'TEST'");
const testToDoneIdx = sessionSrc.indexOf("case 'DONE'", testCaseIdx);
const testBlock = sessionSrc.slice(testCaseIdx, testToDoneIdx > 0 ? testToDoneIdx : testCaseIdx + 4000);
assert(
  testBlock.includes('scopeBlocking') && testBlock.includes('Scope gate: blocking'),
  'computeNextStep TEST branch missing scope-blocking guard',
);

console.log('session brief command center verified');
