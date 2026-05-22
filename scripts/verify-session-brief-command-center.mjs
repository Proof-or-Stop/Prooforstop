#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
  KOALA_ACTIVITY_ROLE: 'reviewer',
  KOALA_ACTIVITY_RECORD_READONLY: '1',
});
run(worktreeRoot, [join(worktreeRoot, 'packages/main/dist/cli.js'), 'session_brief'], {
  KOALA_ACTIVITY_ROLE: 'intent',
  KOALA_ACTIVITY_RECORD_READONLY: '1',
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
    || brief.includes('story_create'),
  'session_brief missing role-aware next step',
);

const mainBrief = run(worktreeRoot, [join(worktreeRoot, 'bin/koala-codex.js'), 'session_brief']);
assert(
  mainBrief.includes('## Active stories') || mainBrief.includes('**Dashboard**') || mainBrief.includes('**Story**:'),
  'session_brief missing dashboard, active stories, or active story section',
);
assert(
  mainBrief.includes('Resume: cd')
    || mainBrief.includes('story_advance --storyId=')
    || mainBrief.includes('No active story')
    || mainBrief.includes('All stories DONE')
    || mainBrief.includes('checklist_update'),
  'session_brief missing recovery or next-step hint',
);

console.log('session brief command center verified');
